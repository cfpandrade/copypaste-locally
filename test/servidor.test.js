// Lo nuevo del servidor (23/11/2026): redes permitidas, caducidad de los archivos y el índice en disco.
// npm test (con las dependencias instaladas); usa una carpeta de datos temporal.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const datos = fs.mkdtempSync(path.join(os.tmpdir(), 'copypaste-'));
process.env.DATA_DIR = datos;
process.env.ARCHIVOS_HORAS = '1';
const srv = require('../server');

test('redes permitidas', () => {
    const redes = ['192.168.50.0/24', '10.0.0.5'];
    assert.ok(srv.permitida('192.168.50.20', redes));
    assert.ok(srv.permitida('::ffff:192.168.50.20', redes));
    assert.ok(srv.permitida('10.0.0.5', redes));
    assert.ok(!srv.permitida('10.0.0.6', redes));
    assert.ok(!srv.permitida('192.168.60.1', redes));
    assert.ok(!srv.permitida('fe80::1', redes));
    assert.ok(srv.permitida('127.0.0.1', redes));            // el healthcheck
    assert.ok(srv.permitida('8.8.8.8', []));                  // sin lista, todas
});

test('caducidad e índice en disco', async () => {
    const carpeta = path.join(datos, 'archivos');
    const viejo = 'a'.repeat(32), nuevo = 'b'.repeat(32), huerfano = 'c'.repeat(32);
    for (const id of [viejo, nuevo, huerfano]) fs.writeFileSync(path.join(carpeta, id), 'x');
    const ahora = Date.now();
    srv.archivos.set(viejo, { id: viejo, nombre: 'v', cuando: ahora - 2 * srv.CADUCIDAD_ARCHIVOS });
    srv.archivos.set(nuevo, { id: nuevo, nombre: 'n', cuando: ahora });
    await srv.limpiarArchivos(ahora);
    assert.deepStrictEqual(fs.readdirSync(carpeta).filter((f) => f.length === 32).sort(), [nuevo]);
    const indice = JSON.parse(fs.readFileSync(path.join(carpeta, 'indice.json'), 'utf8'));
    assert.deepStrictEqual(indice.map((a) => a.id), [nuevo]);
    srv.archivos.clear();
    await srv.cargarIndice();                                   // tras un reinicio, el enlace sigue
    assert.ok(srv.archivos.has(nuevo));
});
