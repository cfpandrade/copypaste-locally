const express = require('express');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const qrcode = require('qrcode');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const PUERTO = process.env.PORT || 3000;
// La versión publicada, para verla en la página y saber si ya llegó una actualización.
const VERSION = require('./package.json').version;
const DATOS = process.env.DATA_DIR || path.join(__dirname, 'data');
const CARPETA_DOCS = path.join(DATOS, 'documentos');
const CARPETA_ARCHIVOS = path.join(DATOS, 'archivos');

// Un documento de 5 MB ya es enorme para un bloc de notas; sin este límite,
// alguien pegando algo gigante deja al servidor sin memoria.
const MAX_MENSAJE = 8 * 1024 * 1024;
const MAX_ARCHIVO = 50 * 1024 * 1024;
// Guardar en cada tecla castiga el disco y mezcla escrituras simultáneas.
const ESPERA_GUARDADO = 600;
// Cada cuánto se comprueba que las conexiones siguen vivas.
const LATIDO = 30000;
// Los archivos compartidos son de paso: a las ARCHIVOS_HORAS se borran del disco.
const CADUCIDAD_ARCHIVOS = (Number(process.env.ARCHIVOS_HORAS) || 24) * 3600 * 1000;
const LIMPIEZA = 30 * 60 * 1000;
// Redes que pueden entrar (IPv4 en CIDR, separadas por comas): vacío = todas. Se mira la IP de la conexión, no
// cabeceras que cualquiera puede inventarse; detrás de un proxy hay que incluir la IP del proxy.
const REDES = String(process.env.REDES_PERMITIDAS || '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);

const app = express();
// Detrás de un proxy (nginx, Cloudflare...), sin esto req.protocol siempre
// diría "http" y no se vería el dominio real por el que entra la gente.
app.set('trust proxy', true);
const server = http.createServer(app);
const wss = new WebSocket.Server({
    server,
    maxPayload: MAX_MENSAJE,
    verifyClient: ({ req }) => permitida(req.socket.remoteAddress),
});

function aNumero(ip) {
    const partes = String(ip || '').replace(/^::ffff:/, '').split('.').map(Number);
    if (partes.length !== 4 || partes.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return ((partes[0] << 24) | (partes[1] << 16) | (partes[2] << 8) | partes[3]) >>> 0;
}

function permitida(ip, redes = REDES) {
    if (!redes.length) return true;
    if (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') return true; // el healthcheck del contenedor
    const n = aNumero(ip);
    if (n === null) return false;
    return redes.some((red) => {
        const [base, bits = '32'] = red.split('/');
        const b = aNumero(base);
        const m = Number(bits);
        if (b === null || !(m >= 0 && m <= 32)) return false;
        const mascara = m === 0 ? 0 : (~0 << (32 - m)) >>> 0;
        return (n & mascara) === (b & mascara);
    });
}

app.use((req, res, next) =>
    permitida(req.socket.remoteAddress) ? next() : res.status(403).send('Fuera de la red permitida')
);

for (const carpeta of [DATOS, CARPETA_DOCS, CARPETA_ARCHIVOS]) {
    fs.mkdirSync(carpeta, { recursive: true });
}

// --- documentos ---------------------------------------------------------------

const DOC_POR_DEFECTO = 'general';

function nombreValido(nombre) {
    // Solo letras, números y guiones: así el nombre nunca puede escaparse de
    // la carpeta de documentos con cosas como "../../etc/passwd".
    return typeof nombre === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(nombre);
}

function aNombre(texto) {
    const limpio = String(texto || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    return limpio || 'nota-' + crypto.randomBytes(3).toString('hex');
}

const rutaDoc = (nombre) => path.join(CARPETA_DOCS, `${nombre}.html`);

async function leerDoc(nombre) {
    try {
        return await fsp.readFile(rutaDoc(nombre), 'utf8');
    } catch {
        return '';
    }
}

async function listaDocs() {
    const ficheros = await fsp.readdir(CARPETA_DOCS).catch(() => []);
    const docs = [];
    for (const f of ficheros) {
        if (!f.endsWith('.html')) continue;
        const nombre = f.slice(0, -5);
        const info = await fsp.stat(path.join(CARPETA_DOCS, f)).catch(() => null);
        docs.push({
            nombre,
            tamano: info ? info.size : 0,
            modificado: info ? info.mtimeMs : 0,
            conectados: [...wss.clients].filter(
                (c) => c.readyState === WebSocket.OPEN && c.doc === nombre
            ).length,
        });
    }
    return docs.sort((a, b) => b.modificado - a.modificado);
}

// Guardado diferido: se acumulan los cambios y se escribe una vez, en lugar de
// reescribir el fichero entero con cada pulsación.
const pendientes = new Map();

function guardarLuego(nombre, contenido) {
    const anterior = pendientes.get(nombre);
    if (anterior) clearTimeout(anterior.temporizador);
    const temporizador = setTimeout(async () => {
        const { texto } = pendientes.get(nombre) || {};
        pendientes.delete(nombre);
        try {
            // Se escribe aparte y se renombra: si el servidor se cae a medias,
            // el documento no queda cortado.
            const temporal = rutaDoc(nombre) + '.tmp';
            await fsp.writeFile(temporal, texto ?? '', 'utf8');
            await fsp.rename(temporal, rutaDoc(nombre));
        } catch (err) {
            console.error('No se pudo guardar', nombre, err.message);
        }
    }, ESPERA_GUARDADO);
    pendientes.set(nombre, { texto: contenido, temporizador });
}

async function guardarTodoYa() {
    for (const [nombre, { texto, temporizador }] of pendientes) {
        clearTimeout(temporizador);
        await fsp.writeFile(rutaDoc(nombre), texto ?? '', 'utf8').catch(() => {});
    }
    pendientes.clear();
}

// --- archivos -----------------------------------------------------------------

// Los archivos se guardan aparte y en el chat solo viaja su identificador. Ese
// identificador es largo y aleatorio: quien no lo recibe, no puede adivinarlo.
const archivos = new Map();
// El índice vive en disco, junto a los archivos: tras un reinicio los enlaces siguen funcionando.
const INDICE = path.join(CARPETA_ARCHIVOS, 'indice.json');

async function guardarIndice() {
    const temporal = INDICE + '.tmp';
    await fsp.writeFile(temporal, JSON.stringify([...archivos.values()]), 'utf8');
    await fsp.rename(temporal, INDICE);
}

async function cargarIndice() {
    try {
        for (const a of JSON.parse(await fsp.readFile(INDICE, 'utf8'))) {
            if (a && /^[0-9a-f]{32}$/.test(a.id)) archivos.set(a.id, a);
        }
    } catch {
        // sin índice (primera vez) o roto: se empieza vacío y la limpieza recoge lo que sobre
    }
}

// Borra lo caducado y lo que no está en el índice (archivos de antes de que existiera, o de un fallo a medias).
async function limpiarArchivos(ahora = Date.now()) {
    let cambios = false;
    for (const [id, a] of archivos) {
        if (ahora - a.cuando > CADUCIDAD_ARCHIVOS) {
            archivos.delete(id);
            await fsp.unlink(path.join(CARPETA_ARCHIVOS, id)).catch(() => {});
            cambios = true;
        }
    }
    for (const f of await fsp.readdir(CARPETA_ARCHIVOS).catch(() => [])) {
        if (/^[0-9a-f]{32}$/.test(f) && !archivos.has(f)) {
            await fsp.unlink(path.join(CARPETA_ARCHIVOS, f)).catch(() => {});
        }
    }
    if (cambios) await guardarIndice().catch((err) => console.error('No se pudo guardar el índice:', err.message));
}

function nombreSeguro(texto) {
    return String(texto || 'archivo')
        .replace(/[/\\?%*:|"<>]/g, '_')
        .slice(0, 120);
}

app.put(
    '/api/archivos',
    express.raw({ type: '*/*', limit: MAX_ARCHIVO }),
    async (req, res) => {
        if (!req.body || !req.body.length) {
            return res.status(400).json({ error: 'Archivo vacío' });
        }
        const id = crypto.randomBytes(16).toString('hex');
        const nombre = nombreSeguro(
            decodeURIComponent(req.get('x-nombre-archivo') || 'archivo')
        );
        try {
            await fsp.writeFile(path.join(CARPETA_ARCHIVOS, id), req.body);
        } catch (err) {
            console.error('No se pudo guardar el archivo:', err.message);
            return res.status(500).json({ error: 'No se pudo guardar' });
        }
        archivos.set(id, {
            id,
            nombre,
            tipo: req.get('content-type') || 'application/octet-stream',
            tamano: req.body.length,
            cuando: Date.now(),
        });
        await guardarIndice().catch((err) => console.error('No se pudo guardar el índice:', err.message));
        res.json({ ok: true, ...archivos.get(id) });
    }
);

app.get('/api/archivos/:id', (req, res) => {
    const info = archivos.get(req.params.id);
    if (!info) return res.status(404).send('No existe o ya ha caducado');
    res.setHeader('Content-Type', info.tipo);
    res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(info.nombre)}`
    );
    res.sendFile(path.join(CARPETA_ARCHIVOS, info.id));
});

// --- páginas ------------------------------------------------------------------

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'copy.html')));

app.get('/api/documentos', async (req, res) => res.json(await listaDocs()));

app.get('/api/version', (req, res) => res.json({ version: VERSION }));

// Para instalarla en el móvil como una app más (pantalla de inicio, sin barra del navegador).
app.get('/manifest.webmanifest', (req, res) =>
    res.type('application/manifest+json').json({
        name: 'CopyPaste',
        short_name: 'CopyPaste',
        description: 'Copiar y pegar entre los dispositivos de casa',
        start_url: '/',
        display: 'standalone',
        background_color: '#1e293b',
        theme_color: '#1e293b',
        lang: 'es',
        icons: [
            { src: '/icono-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icono-512.png', sizes: '512x512', type: 'image/png' },
        ],
    })
);

// Código QR de la dirección desde la que se está entrando, para abrirlo en el
// móvil apuntando con la cámara en vez de teclear una IP.
app.get('/api/qr', async (req, res) => {
    // La dirección buena es con la que ha entrado quien mira la página: puede
    // ser un dominio público, y detrás de un proxy el servidor solo ve la IP
    // interna. Por eso el navegador manda la suya, y si no, se recurre a
    // PUBLIC_URL o a las cabeceras.
    let destino;
    const pedida = String(req.query.url || '');
    if (/^https?:\/\//i.test(pedida)) {
        destino = pedida;
    } else {
        const base =
            process.env.PUBLIC_URL ||
            `${req.protocol}://${req.get('host')}`;
        destino = base.replace(/\/$/, '') + (req.query.ruta || '/');
    }
    try {
        const svg = await qrcode.toString(destino, {
            type: 'svg',
            margin: 1,
            width: 260,
            color: { dark: '#000000', light: '#ffffff' },
        });
        res.type('image/svg+xml').send(svg);
    } catch (err) {
        res.status(500).send('No se pudo generar el código');
    }
});

// Solo se publican los ficheros de la interfaz. Antes se servía el directorio
// entero, así que cualquiera podía descargarse server.js o el Dockerfile.
app.use(
    express.static(path.join(__dirname, 'publico'), {
        index: false,
        dotfiles: 'ignore',
    })
);

// --- conexiones ---------------------------------------------------------------

const COLORES = [
    '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
    '#9b59b6', '#1abc9c', '#e67e22', '#34495e',
];

function enviar(cliente, objeto) {
    if (cliente.readyState === WebSocket.OPEN) {
        cliente.send(JSON.stringify(objeto));
    }
}

function paraTodos(objeto, { doc = null, excepto = null } = {}) {
    for (const c of wss.clients) {
        if (c === excepto) continue;
        if (doc && c.doc !== doc) continue;
        enviar(c, objeto);
    }
}

function usuariosDe(doc) {
    return [...wss.clients]
        .filter((c) => c.readyState === WebSocket.OPEN && c.doc === doc)
        .map((c) => ({ id: c.userId, name: c.userName, color: c.userColor }));
}

function anunciarUsuarios(doc) {
    const users = usuariosDe(doc);
    paraTodos({ type: 'users_update', users }, { doc });
    paraTodos({ type: 'user_count', count: users.length }, { doc });
    paraTodos({ type: 'documentos', documentos: null }, { doc: null });
}

async function anunciarDocumentos() {
    const documentos = await listaDocs();
    paraTodos({ type: 'documentos', documentos });
}

wss.on('connection', async (ws, req) => {
    ws.vivo = true;
    ws.on('pong', () => {
        ws.vivo = true;
    });
    // Un error en un socket concreto no debe tumbar el servidor entero.
    ws.on('error', (err) => console.error('Error de conexión:', err.message));

    ws.userId = crypto.randomUUID();
    ws.userName = 'User-' + ws.userId.slice(0, 4);
    ws.userColor = COLORES[Math.floor(Math.random() * COLORES.length)];

    let doc = DOC_POR_DEFECTO;
    try {
        const pedido = new URL(req.url, 'http://x').searchParams.get('doc');
        if (pedido && nombreValido(pedido)) doc = pedido;
    } catch {
        /* si la url viene rara, se usa el documento por defecto */
    }
    ws.doc = doc;

    enviar(ws, {
        type: 'bienvenida',
        user: { id: ws.userId, name: ws.userName, color: ws.userColor },
        documento: doc,
    });
    enviar(ws, { type: 'load', content: await leerDoc(doc), documento: doc });

    anunciarUsuarios(doc);
    paraTodos(
        { type: 'user_joined', user: { id: ws.userId, name: ws.userName, color: ws.userColor } },
        { doc, excepto: ws }
    );
    anunciarDocumentos();

    ws.on('message', async (bruto) => {
        let data;
        try {
            data = JSON.parse(bruto);
        } catch {
            // Antes, un mensaje mal formado tiraba el proceso entero y
            // desconectaba a todo el mundo.
            return enviar(ws, { type: 'error', mensaje: 'Mensaje no válido' });
        }
        if (!data || typeof data.type !== 'string') return;

        try {
            await procesar(ws, data);
        } catch (err) {
            console.error('Error procesando', data.type, err.message);
        }
    });

    ws.on('close', () => {
        anunciarUsuarios(ws.doc);
        paraTodos({ type: 'user_left', userId: ws.userId }, { doc: ws.doc });
        anunciarDocumentos();
    });
});

async function procesar(ws, data) {
    switch (data.type) {
        case 'update': {
            const contenido = typeof data.content === 'string' ? data.content : '';
            guardarLuego(ws.doc, contenido);
            paraTodos(
                { type: 'update', content: contenido, documento: ws.doc },
                { doc: ws.doc, excepto: ws }
            );
            break;
        }

        case 'chat': {
            const texto = String(data.message ?? '').slice(0, 4000);
            if (!texto && !data.archivo) break;
            const mensaje = {
                type: 'chat',
                // El emisor sale de la conexión, no de lo que diga el cliente:
                // así nadie puede escribir haciéndose pasar por otro.
                userId: ws.userId,
                userName: ws.userName,
                userColor: ws.userColor,
                message: texto,
                archivo: data.archivo || null,
                timestamp: Date.now(),
                privado: false,
            };

            const destino = data.para;
            if (destino && destino !== 'todos') {
                const receptor = [...wss.clients].find((c) => c.userId === destino);
                if (!receptor) {
                    enviar(ws, {
                        type: 'chat',
                        userId: 'sistema',
                        userName: 'Sistema',
                        message: 'Esa persona ya no está conectada.',
                        timestamp: Date.now(),
                    });
                    break;
                }
                mensaje.privado = true;
                mensaje.para = destino;
                mensaje.paraNombre = receptor.userName;
                enviar(receptor, mensaje);
                enviar(ws, mensaje); // copia para quien lo envía
            } else {
                paraTodos(mensaje, { doc: ws.doc });
            }
            break;
        }

        case 'user_update': {
            ws.userName = String(data.userName ?? '').slice(0, 40) || ws.userName;
            if (typeof data.userColor === 'string') ws.userColor = data.userColor;
            anunciarUsuarios(ws.doc);
            break;
        }

        case 'typing_start':
        case 'typing_stop': {
            paraTodos(
                { type: data.type, userId: ws.userId, userName: ws.userName },
                { doc: ws.doc, excepto: ws }
            );
            break;
        }

        case 'cambiar_documento': {
            const nombre = nombreValido(data.documento)
                ? data.documento
                : aNombre(data.documento);
            const anterior = ws.doc;
            ws.doc = nombre;
            if (!fs.existsSync(rutaDoc(nombre))) {
                await fsp.writeFile(rutaDoc(nombre), '', 'utf8');
            }
            enviar(ws, { type: 'load', content: await leerDoc(nombre), documento: nombre });
            anunciarUsuarios(anterior);
            anunciarUsuarios(nombre);
            await anunciarDocumentos();
            break;
        }

        case 'borrar_documento': {
            const nombre = data.documento;
            if (!nombreValido(nombre) || nombre === DOC_POR_DEFECTO) break;
            await fsp.unlink(rutaDoc(nombre)).catch(() => {});
            for (const c of wss.clients) {
                if (c.doc === nombre) {
                    c.doc = DOC_POR_DEFECTO;
                    enviar(c, {
                        type: 'load',
                        content: await leerDoc(DOC_POR_DEFECTO),
                        documento: DOC_POR_DEFECTO,
                    });
                }
            }
            await anunciarDocumentos();
            break;
        }
    }
}

// Conexiones que se quedan colgadas (un móvil que se duerme) seguirían
// contando como usuarios presentes si no se comprueban.
setInterval(() => {
    for (const ws of wss.clients) {
        if (ws.vivo === false) {
            ws.terminate();
            continue;
        }
        ws.vivo = false;
        ws.ping();
    }
}, LATIDO).unref();

// --- arranque y parada --------------------------------------------------------

async function migrarDocumentoAntiguo() {
    const viejo = path.join(__dirname, 'collaborative-document.html');
    const nuevo = rutaDoc(DOC_POR_DEFECTO);
    if (fs.existsSync(viejo) && !fs.existsSync(nuevo)) {
        await fsp.copyFile(viejo, nuevo);
        console.log('Documento anterior conservado como "general"');
    }
    if (!fs.existsSync(nuevo)) await fsp.writeFile(nuevo, '', 'utf8');
}

async function cerrar() {
    console.log('Cerrando: guardando lo que quede pendiente...');
    await guardarTodoYa();
    process.exit(0);
}
process.on('SIGTERM', cerrar);
process.on('SIGINT', cerrar);

setInterval(() => limpiarArchivos().catch(() => {}), LIMPIEZA).unref();

module.exports = { permitida, limpiarArchivos, archivos, cargarIndice, CADUCIDAD_ARCHIVOS };

if (require.main === module) migrarDocumentoAntiguo().then(async () => {
    await cargarIndice();
    await limpiarArchivos();
    server.listen(PUERTO, () => {
        console.log(`Servidor escuchando en http://localhost:${PUERTO}`);
    });
});
