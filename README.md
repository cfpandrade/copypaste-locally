# copypaste locally

Bloc de notas compartido para la red de casa: se abre en cualquier dispositivo,
y lo que uno escribe aparece al momento en los demás. Pensado para pasar texto
entre el móvil y el ordenador sin recurrir a servicios de terceros.

Todo ocurre dentro de la red local; el contenido no sale a internet.

## Cómo funciona

Un servidor Express sirve la página y mantiene un WebSocket abierto con cada
dispositivo conectado. Los cambios se difunden a todos, y el texto se guarda en
`collaborative-document.html` para que siga ahí al recargar.

Cada visitante recibe un nombre y un color al conectarse, así se ve quién está
escribiendo en cada momento.

## Ponerlo en marcha

```bash
npm install
npm start
```

Queda en `http://localhost:3000`. Se puede cambiar con la variable `PORT`.

## Cómo se trabaja y se publica

En `dev` se toca y se prueba; en `main` se publica. La imagen solo se construye
al fusionar, así que nada llega al servidor hasta que tú lo decides.

```
dev  ──► pruebas en tu ordenador, sin publicar nada
 │
 └─ merge ──► main ──► GitHub construye y publica la imagen
                            │
                            └─► Dockge: botón Update
```

**Probar un cambio en local:**

```bash
git switch dev
# ...editar...
docker compose -f docker-compose.dev.yml up -d --build   # http://localhost:4000
```

O sin Docker, que es más rápido para ir probando:

```bash
npm install && npm start
```

**Publicar lo que te convenza:**

```bash
git switch main && git merge dev && git push
```

Eso dispara la acción de GitHub, que construye la imagen y la deja en
`ghcr.io/cfpandrade/copypaste-locally:latest`. Cuando termine, en Dockge pulsas
**Update** en el stack y el servidor se queda con la versión nueva.

Cada publicación deja también una etiqueta con el identificador del commit, por
si hace falta volver a una versión anterior.

## Con Docker

```bash
docker compose up -d
```

**Ojo con el puerto:** la aplicación escucha en el 3000 dentro del contenedor.
Si lo publicas en otro puerto del servidor, el mapeo tiene que apuntar ahí:

```yaml
ports:
  - 4000:3000     # 4000 en el servidor, 3000 dentro del contenedor
```

Publicarlo como `4000:4000` deja el contenedor arrancado y aparentemente sano,
pero sin responder: el healthcheck comprueba el 3000 por dentro y lo ve bien,
mientras que por fuera no hay nada escuchando en el 4000.

El volumen `copypaste_data` monta `/app`, de modo que el documento compartido
sobrevive a los reinicios.
