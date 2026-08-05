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
