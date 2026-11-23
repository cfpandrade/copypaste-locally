# CopyPaste

Bloc de notas compartido para la red de casa: se abre en cualquier dispositivo,
y lo que uno escribe o pega aparece al momento en los demás. Sirve para pasar
texto y archivos entre el móvil y el ordenador sin servicios de terceros.

Todo ocurre dentro de la red local; el contenido no sale a internet.

## Qué hace

- **Notas separadas**: cada nota tiene su nombre y su propio contenido.
- **Archivos compartidos**: se arrastran o se pegan y aparecen en los demás
  dispositivos. Caducan a las 24 horas (`ARCHIVOS_HORAS`) y se borran del disco.
- **Chat** entre los dispositivos conectados, a todos o a uno.
- **Copiar, pegar e historial**: «Copiar todo» guarda también lo copiado en el
  historial de ese dispositivo (los 10 últimos), y «Pegar» trae lo que tengas
  copiado.
- **Código QR** para abrir la página en el móvil.
- **Se instala como app** en el móvil: en el navegador, «Añadir a pantalla de
  inicio».
- Tema claro u oscuro según el del sistema, salvo que elijas otro.

## Cómo funciona

Un servidor Express sirve la página y mantiene un WebSocket abierto con cada
dispositivo. Los cambios se difunden a todos y se guardan en disco.

Todos los datos van en la carpeta `DATA_DIR` (en el contenedor, `/datos`), y
nada fuera de ella:

```
/datos/documentos/<nota>.html     el contenido de cada nota
/datos/archivos/<id>              los archivos compartidos
/datos/archivos/indice.json       qué es cada archivo y cuándo caduca
```

## Configuración

| Variable | Por defecto | Para qué |
| --- | --- | --- |
| `PORT` | `3000` | Puerto en el que escucha. |
| `DATA_DIR` | `./data` (`/datos` en la imagen) | Dónde se guarda todo. |
| `ARCHIVOS_HORAS` | `24` | Horas que dura un archivo compartido. |
| `REDES_PERMITIDAS` | vacío (todas) | Redes que pueden entrar, en CIDR y separadas por comas, p. ej. `192.168.50.0/24`. Se mira la IP de la conexión: detrás de un proxy hay que incluir la IP del proxy. |
| `PUBLIC_URL` | — | Dirección que pone el código QR, si no se puede deducir. |

**El portapapeles en el móvil.** Los navegadores solo dejan leer y escribir el
portapapeles en páginas seguras (`https://`). Por `http://` copiar sigue
funcionando con el método antiguo, pero «Pegar» no puede leer lo que tienes
copiado: para eso, sírvela por HTTPS a través del proxy.

## Ponerlo en marcha

```bash
npm install
npm start      # http://localhost:3000
npm test       # las pruebas del servidor
```

## Cómo se publica

En `dev` se trabaja y se prueba; al fusionar en `main`, GitHub construye la
imagen y la publica con tres etiquetas:

```
ghcr.io/cfpandrade/copypaste-locally:latest
ghcr.io/cfpandrade/copypaste-locally:<versión de package.json>   p. ej. 3.1.0
ghcr.io/cfpandrade/copypaste-locally:<commit>
```

La versión sale de `package.json`: súbela en cada cambio que se publique. El
servidor (CT117) se recrea con la versión nueva en cuanto aparece.

El repositorio es público para que cualquiera lo use o haga un fork, pero solo
el propietario puede publicar: la rama `main` y las etiquetas de versión están
protegidas, y la imagen solo se construye desde `main` (nunca desde una PR).
Cada imagen lleva su procedencia firmada por GitHub; para comprobarla:

```bash
gh attestation verify oci://ghcr.io/cfpandrade/copypaste-locally:3.1.2 --owner cfpandrade
```

## Con Docker

```bash
docker compose up -d
```

La aplicación escucha en el **3000** dentro del contenedor. Si la publicas en
otro puerto del servidor, el mapeo tiene que apuntar al 3000:

```yaml
ports:
  - 4000:3000     # 4000 en el servidor, 3000 dentro del contenedor
```

El volumen se monta en `/datos`, de modo que las notas y los archivos
sobreviven a los reinicios y a recrear el contenedor.
