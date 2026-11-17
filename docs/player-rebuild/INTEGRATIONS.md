# Integraciones oficiales y estados verificados

> Fecha: 2026-11-13 · Tarea T4 (`integrations`) · Commit base `6b42364`
> Actualizado: 2026-11-15 · **TDT-CLONE-12**: reproducción integrada de YouTube.
> Alcance: reproductor **oficial** de YouTube **dentro de nuestro reproductor**,
> ruta externa para señales que solo se pueden ver en la plataforma del emisor, y
> la superficie de estado de la ficha de canal (spec §9). No incluye extracción de
> señales ocultas ni suplantación de clientes oficiales.

---

## 0. Reproducción integrada de YouTube (TDT-CLONE-12)

Desde TDT-CLONE-12 una fuente `youtube` **del catálogo** se reproduce dentro de
TDT Player, sin abrir YouTube en otra pestaña. El reproductor oficial ocupa el
escenario de `app-player`; nuestra navegación, URL, parrilla y controles de la
ficha siguen siendo nuestros.

| Pieza | Fichero | Responsabilidad |
| --- | --- | --- |
| `YouTubePlaybackEngine` | `core/player/youtube-engine.ts` | Implementa `PlayerEngine` sobre `YT.Player`: estados, volumen/mute, directo, teardown. |
| Resolución de URLs/IDs | `core/integrations/youtube-target.ts` | Única fuente de verdad: id de vídeo (11 caracteres), id de canal (`UC…`), *handle*. |
| Resolución de directos de canal | `core/integrations/youtube-data-api.ts` | YouTube Data API v3 documentada, con caché y cuota acotada. |
| Montaje en Angular | `features/watch/player/player.component.*` | `[data-testid="yt-engine-shell"]`: punto de montaje del frame oficial. |

### Formas de URL y qué se hace con cada una

| URL publicada | Identificador | Comportamiento |
| --- | --- | --- |
| `/live/<VIDEO_ID>` | vídeo | `YT.Player` con ese vídeo (comprobado en real). |
| `/watch?v=<VIDEO_ID>` | vídeo | Igual. |
| `youtu.be/<VIDEO_ID>` | vídeo | Igual. |
| `/embed/<VIDEO_ID>` | vídeo | Igual. |
| `/channel/<UC…>/live` | canal | **Con clave**: se resuelve a su vídeo en directo y se reproduce ese vídeo. **Sin clave**: se muestra el *embed* oficial de canal (`/embed/live_stream?channel=…`), público y sin clave; su estado lo indica YouTube dentro del reproductor y la app **nunca** afirma `playing`. |
| `/@handle/live`, `/c/<n>/live`, `/user/<n>/live` | *handle* | Solo enlace: el *handle* no permite verificar a qué canal apunta. |

**Un `/channel/.../live` no es directamente embebible con estado observable.** El
embed oficial de canal (`/embed/live_stream?channel=…`) es un documento de YouTube
cuyo estado **no es observable** desde nuestra página, así que nunca sirve para
afirmar «se está reproduciendo». Por eso, **con clave** se resuelve el canal a un
**vídeo** concreto y se reproduce con `YT.Player`, que sí informa de `PLAYING`; y
**sin clave** se monta ese embed oficial como el reproductor que el propio emisor
usa en su web, declarando que el estado lo da YouTube — nunca inventándolo.

### Cuándo se afirma «reproduciendo»

`playing` se marca **solo** cuando el reproductor oficial informa
`YT.PlayerState.PLAYING` (1). Un reproductor montado y listo emite `can-play` y el
estado queda en `pausa`; `BUFFERING` (3) es `buffering`; `ENDED` (0) es que la
emisión ha terminado, nunca un reproductor «sano». Esto está cubierto por pruebas
unitarias (`youtube-engine.spec.ts`) y E2E (`e2e/youtube.spec.ts`).

### Autorreproducción al abrir el canal

Medido contra el reproductor real (`scripts/playback/probe-autoplay.mjs`, dos
ejecuciones):

| Forma | ¿Se reprodujo sola? |
| --- | --- |
| `YT.Player` con VIDEO_ID (`autoplay=1`) | **Sí** — estado `[-1, 3, 1]`, tiempo avanzando |
| embed de canal **sin** parámetros | **No** — `video.paused === true`, tiempo 0 |
| embed de canal con `autoplay=1&playsinline=1` | **Sí** — tiempo avanzando |

Por eso `youtubeChannelLiveUrl` construye el embed de canal con `autoplay=1`,
`playsinline=1` y nuestro `origin`, y el `iframe` deja `allow="autoplay; …"`. Se
añadieron también `allowfullscreen` (pantalla completa del control propio de
YouTube).

*Medición instrumental honesta:* el reproductor de YouTube se reproduce solo en un
navegador con una sesión de navegación real. En contextos automatizados recién
creados se observaron arranques irregulares (una misma URL puede quedarse en
`paused` con el tiempo congelado). Por eso la app **no afirma `playing`** para esta
forma: muestra el reproductor oficial y dice que el estado lo indica YouTube. El
camino con VIDEO_ID —el que usa el catálogo para sus 10 opciones `/live/<id>` y el
que usaría un canal con clave de Data API— sí es observable de principio a fin.

Órdenes de intento para un *channel embed* (sin clave), todos acotados:

1. al abrir la ficha se monta una vez;
2. si el *frame* no anuncia su carga en 12 s se **remonta una vez** (medido con
   `probe-start-time.mjs`: el arranque real tarda 1,0-1,8 s en 9 de 9 ejecuciones,
   pero un documento lento no debe convertirse en un callejón sin salida);
3. al **volver al canal** (el componente se recrea) se monta de nuevo, sin gastar
   presupuesto: el usuario espera encontrarlo donde lo dejó;
4. si el reproductor **no se está viendo** mientras el usuario sigue en el canal,
   el motor lo remonta (máximo 2 veces);
5. el botón **Reintentar** remonta el reproductor que ya está en memoria, sin
   reconstruir el motor;
6. agotado el presupuesto, se explica el motivo y se ofrece la página oficial.

> Casos observados por el usuario (2026-11-15): «…y no ha podido reproducirse
> aquí» de forma intermitente, y «a veces le das al canal y funciona y otras no».
> Dos causas, ambas nuestras: rendirse tras **un solo** intento, y — al cambiar de
> canal y volver — que un segundo efecto de la vista compitiera con la carga y
> re-montara el reproductor en cada visita, gastando el presupuesto del canal hasta
> dejarlo en error permanente.
>
> Corrección estructural: **un único dueño de la montura**. El componente carga y,
> cuando la carga ha terminado, anuncia su contenedor (`onHostReady`); el motor
> decide dónde vive su propio frame (`reattachTo`), de modo que moverlo a la nueva
> vista **no** reinicia el reproductor ni consume intentos.
>
> Medido, con la build de producción y el catálogo real:
> · ir y volver 10 veces a La Séptima → **21/21 pasos sin error**;
> · idem con Canal 7 Argentina → **9/9**;
> · abrir la ficha 6 veces seguidas → **6/6 montan el reproductor**.

Instrumentos: `scripts/playback/probe-autoplay.mjs` (¿arranca solo, por forma de
fuente?), `probe-start-time.mjs` (cuánto tarda en arrancar),
`probe-switch-back.mjs` (ciclo cambiar-de-canal-y-volver) y `probe-reopening.mjs`
(abrir el canal N veces).

### Errores del reproductor oficial

| Código | Significado | Estado mostrado |
| --- | --- | --- |
| 100 | vídeo retirado/privado o directo terminado | `source-unavailable` con el motivo |
| 101 / 150 | el titular prohíbe incrustar | `unauthorised` + enlace a YouTube |
| 153 | la página no envió `HTTP Referer` / identificación de cliente | `unauthorised`, con el motivo correcto |
| 5 | el reproductor HTML5 no arranca | reintento acotado |
| sin `PLAYING` en 15 s | la señal no llega | `SOURCE_STALLED`, nunca «reproduciendo» |

### Directos identificados por canal

1. Se obtiene el id de canal del catálogo (o del *handle*, que se rechaza).
2. `search.list?channelId&eventType=live&type=video&videoEmbeddable=true`
   (documentado) da las emisiones públicas en curso.
3. `videos.list?part=status,snippet,liveStreamingDetails` confirma
   `status.embeddable` y que el vídeo pertenece a **ese** canal.
4. El resultado se guarda en caché (60 s si hay directo, 3 min si no) y **todo
   consume cuota**: se respetan los límites documentados (100 `search.list`/día,
   10 000 unidades/día). Al agotarse, se ofrece la página oficial, nunca un
   resultado inventado.
5. Sin clave de API se responde «no se puede comprobar» —nunca «el canal no está
   emitiendo»—, y la ficha enlaza a la página oficial del canal.

La clave es **opt-in** (`window.TDT_YOUTUBE_API_KEY`, inyectada en despliegue) y
debe ser una clave **restringida** (solo YouTube Data API v3 y a nuestro origen).
Sin clave, las 205 opciones `/channel/…/live` se muestran con el **embed oficial
de canal**, público y sin clave (§0): se intenta una vez por canal y, si YouTube
no lo reproduce, se explica el motivo y se enlaza su página. Nunca se declara «el
canal no está emitiendo» sobre un dato que no se ha comprobado.

> Caso medido (La Séptima, 2026-11-15): el catálogo solo publica su canal, no hay
> clave y la app decía «ninguna fuente disponible» mientras el canal sí emitía en
> YouTube. Con el embed oficial de canal montado, su directo se ve **dentro** de
> nuestra aplicación.

### Lo que se sigue sin hacer

- No se usan hls.js ni dash.js para contenido de YouTube.
- No se extraen manifiestos, `player_response` ni URLs multimedia.
- No se ocultan marcas, anuncios ni controles obligatorios: no se aplica CSS
  propio al interior del frame ni se superpone nada nuestro encima.
- No se usan endpoints internos ni tokens privados.

### Verificación en red real

Tres sondas, ninguna dentro de `npm run test:e2e` (necesitan red y un directo vivo):

- `scripts/playback/verify-youtube-live.mjs` (`npm run playback:verify-youtube`):
  abre la build de producción en Chromium real contra el reproductor de YouTube
  real y solo da PASS si nuestro estado llega a `playing` (que solo ocurre con
  `PLAYING`) con el frame oficial incrustado en nuestra página. Medido el
  2026-11-15 con `OkQduT-9Pyc` y `5J-wqzcL_VI`: 11/11 comprobaciones, 0 ventanas
  abiertas (`artifacts/yt/verify-live.json`).
- `scripts/playback/verify-youtube-switch.mjs` (`playback:verify-youtube-switch`):
  tres cambios reales entre dos directos, comprobando que queda **un solo**
  reproductor y que el anterior desaparece: 6/6.
- `scripts/playback/probe-youtube-api.mjs`: mide dos hechos del API oficial de los
  que depende el diseño. **Medido:** (a) el script `/iframe_api` dispara `onload`
  ~193 ms **antes** de que exista `YT.Player`, así que esperar a
  `onYouTubeIframeAPIReady` es obligatorio; (b) el API **sustituye** el elemento
  que recibe (`isConnected === false` después de montar), por lo que el motor
  monta en un hijo propio y nunca limpia el contenedor compartido.

---

## 1. Qué está permitido y qué no

El catálogo publica cuatro tipos de opción relevantes (`lists/tv.json` →
`options[].format`): `m3u8`, `mpd`, `stream` y `youtube` (medición: 768 canales /
855 opciones; `artifacts/playback/source-matrix.json`).

| Integración | Permitida | Cómo se hace aquí |
| --- | --- | --- |
| Página oficial de YouTube del emisor (`/channel/<UC…>/live`, `/live/<id>`) | **Sí**, mediante el **reproductor oficial IFrame** de YouTube **dentro de nuestra página** | Dominio **sin cookies** `youtube-nocookie.com`, `origin` restringido a nuestro origen, carga diferida (el motor sólo se importa y el API sólo se pide al abrir una ficha con fuente YouTube). Un vídeo va directo a `YT.Player`; un canal se resuelve a su vídeo en directo (§0). |
| Enlace a la web/reproductor del emisor | **Sí** | `<a target="_blank" rel="noopener noreferrer">`. Nunca se incrusta una página arbitraria. |
| Señales HLS/DASH publicadas en abierto | **Sí** | hls.js / dash.js propios (T2). |
| Descargar o reconstruir la URL de vídeo de YouTube (`/manifest/hls_playbacklist`, `player_response`) | **No** | No se implementa. Sería saltarse la plataforma y sus condiciones. |
| Suplantar el cliente oficial, `User-Agent`, `Referer` o `Origin` de un emisor | **No** | Las URLs con marcadores de cliente (`[DEVICE_ID]`, etc.) se listan como no reproducibles. Los canales `UAG`/`REF*` se marcan `Requiere acceso oficial`. |
| Eludir geobloqueo, DRM o registro | **No** | Estado verificado con motivo y, si existe, enlace oficial. |
| Incrustar el reproductor de un tercero arbitrario (`iframe` de Twitch, Dailymotion…) | **No** | Solo se enlaza. `stream` nunca llega a un motor ni a un iframe propio. |

**Limitación medida y declarada:** el catálogo publica 215 opciones `youtube`
sobre 202 canales; **205** son `/channel/<UC…>/live` y **10** son `/live/<id>`.
Las 10 de vídeo se reproducen integradas sin configuración. Las 205 de canal se
resuelven a su vídeo en directo cuando el despliegue aporta una clave de la Data
API; si YouTube rechaza el embebido (101/150/153) o el canal no emite, la ficha
lo dice con su motivo y ofrece el enlace oficial — nunca afirma reproducción.

---

## 2. Postura de seguridad

- **Sin cookies antes del consentimiento**: el dominio es `youtube-nocookie.com`
  y ningún recurso de YouTube se solicita hasta que el usuario abre la ficha del
  canal con una fuente de YouTube (el reproductor se crea entonces, no antes).
  El API se carga de forma diferida (`YouTubePlaybackEngine` se importa en su
  propio *chunk* y `iframe_api` se pide al montar el motor), no al arrancar la app.
  **Compromiso declarado:** abrir la ficha de un canal de YouTube *es* el
  consentimiento para cargar su reproductor oficial; no hay un botón intermedio.
  Si un despliegue exige consentimiento explícito previo, debe montar una barrera
  propia antes de renderizar `app-player` para estas fuentes.
- **`origin` restringido**: `playerVars.origin` es siempre
  `location.origin`; nunca un valor fabricado.
- **Clave de API opt-in y restringida**: la resolución de canales necesita
  `window.TDT_YOUTUBE_API_KEY`; sin clave no se llama a Google. La clave debe
  restringirse a YouTube Data API v3 y a nuestro origen, y nunca se escribe en el
  repositorio ni en los logs.
- **Teardown**: al cambiar de canal o desmontar la ficha se llama a `destroy()`
  del reproductor oficial, se elimina el frame y se desconecta el observador de
  tamaño (`youtube-engine.spec.ts`, `e2e/youtube.spec.ts`).
- **Un reproductor a la vez**: cambiar de fuente o de canal libera el motor
  anterior antes de crear el siguiente (probado en E2E para YouTube→HLS,
  HLS→YouTube y YouTube→YouTube).
- **CSP**: ver §5. No se pone como `<meta>` porque rompería el arranque.

---

## 3. Estados verificados (spec §9)

La ficha solo puede mostrar un estado que los datos publicados respalden. La
etiqueta y el motivo van juntos (`[data-verified-state]` + `[data-testid=verified-state]`).

| Estado | Etiqueta | Respaldo (dato publicado) | Acción ofrecida |
| --- | --- | --- | --- |
| `live` | **Ver en directo** | Una fuente HLS/DASH/MP4 que este navegador puede intentar (no geo, sin marcadores de cliente) | Reproductor propio |
| `official-embed` | **Ver en directo (oficial)** | Página oficial de YouTube con identificador direccionable y sin `GEO` | Reproductor IFrame oficial (click-to-play) |
| `official-site` | **Disponible en la web oficial** | El emisor solo publica su página, o la señal existe pero no se puede intentar aquí | Enlace externo |
| `eventual` | **Emisión eventual** | `EVT`, o `NOEM` (solo guía) | Enlace externo si lo hay |
| `requires-official` | **Requiere acceso oficial** | `UAG` (solo su app) o `REF*` (necesita `Referer`) | Enlace oficial si lo hay |
| `unavailable` | **No disponible actualmente** | Nada publicable ni enlazable | — |

**Regla dura (probada):** nunca se renderiza «Ver en directo» si la fuente no
puede reproducirse aquí. Las fuentes publicadas que **no** se intentan se
listan aparte, con el motivo (bloqueo regional, datos de cliente, formato no
admitido), para no ocultar información del catálogo.

Transición honesta al reproducir: si el reproductor propio termina en un estado
que no es reproducción (error de medio, sin fotogramas, códec no admitido), la
ficha deja de afirmar «Ver en directo» y muestra el estado recuperable con su
acción. Esto es lo que impide que un contenedor que el navegador no decodifica
se presente como reproducción.

---

## 2-bis. Enviar a un dispositivo

El reproductor ofrece un botón **Enviar a un dispositivo** que abre el selector
de dispositivos **del navegador**. La app nunca dibuja una lista propia: enumerar
dispositivos de la red solo puede hacerlo la plataforma.

| Superficie del navegador | Qué aporta |
| --- | --- |
| `chrome.cast` (Media Router de Chrome) | El selector de Google, con los dispositivos reales de la red |
| `HTMLMediaElement.remotePlayback` (API estándar) | Selector de la plataforma (Chrome, Edge) |
| `webkitShowPlaybackTargetPicker` | Selector de AirPlay en Safari |

Reglas que se respetan:

- El botón **solo aparece si el navegador puede descubrir dispositivos**
  (`remotePlaybackCapabilities`). Sin superficie no hay botón, en vez de un botón
  que no hace nada.
- Se actúa sobre el `<video>` propio de los motores **HLS/DASH**: es el único
  medio que la página posee y puede entregar.
- Con una fuente de **YouTube** no se ofrece: su reproductor vive en un *frame* de
  otro origen cuyo documento es inalcanzable (`contentDocument === null`,
  medido), así que no puede entregarse desde aquí. La página lo dice y remite al
  control de emisión del propio reproductor de YouTube.

Medición (2026-11-15): en el Chromium de Playwright ni `chrome.cast`, ni
`navigator.presentation`, ni `remotePlayback` están disponibles, y el Chrome
instalado del sistema (lanzado por Playwright) tampoco expone el puente Cast sin
el perfil y la red de un usuario real. Por eso:
`scripts/playback/probe-remote-playback.mjs` y
`check-cast-capable-browser.mjs` documentan lo que hay; las pruebas
`e2e/cast.spec.ts` simulan cada superficie para fijar el contrato del botón.

### Google Cast (integrado de verdad)

Además de las superficies del navegador, la app integra el **SDK oficial de
Google Cast** (`cast-sender.ts`):

- La primera vez que se pulsa el botón se carga `cast_sender.js` desde
  `www.gstatic.com` (`loadCastSender`). Nunca se carga al abrir la página.
- El SDK **crea `chrome.cast` aunque el navegador no lo traiga**, y por eso el
  botón se ofrece para toda fuente propia, no solo cuando el navegador anuncia
  dispositivos. No depende de `__onGCastApiAvailable`: ese callback solo se dispara
  cuando el SDK se configura con `api_key`; el puente se detecta por sondeo
  (medido: el callback no se llama y `chrome.cast` sí existe).
- Se crea una sesión con el **receptor** indicado. Sin configurar nada se usa el
  *Default Media Receiver* de Google (`CC1AD845`), que reproduce una URL HLS/DASH
  directamente sin registrar receptor propio.
- El dispositivo recibe la **URL del stream**, no una copia de la pantalla: la
  emisión sigue aunque se cierre la pestaña.
- Solo se envían fuentes propias (`hls`/`dash`). YouTube, `iframe` y los reproductores
  remezclados (`stream`) se rechazan explícitamente.

**Despliegue:** para usar un receptor propio (por ejemplo con vuestro logotipo),
registrar la app en Google Cast Console y exponer su App ID como
`window.TDT_CAST_APP_ID` antes de cargar la aplicación. Sin él se usa el receptor
genérico, que funciona igual para canales abiertos.

La CSP de despliegue debe permitir `https://www.gstatic.com` en `script-src`
(incluido arriba).

### Enviar el canal a otra pantalla (funciona siempre)

El navegador solo puede descubrir dispositivos si expone una de las superficies
anteriores y Cast no está disponible. Cuando no hay ninguna, la vía que sí
funciona es **compartir el enlace del canal con el otro dispositivo**:

1. El reproductor ofrece el enlace de canal (`sessionLink`), accesible con la hoja
   de compartir del sistema o, si no la hay, copiado al portapapeles.
2. El enlace apunta a la **página índice de esta misma aplicación** y lleva en el
   fragmento (`#/cast/<token>`) solo qué canal abrir.
3. El otro dispositivo —móvil, tableta o un televisor con navegador— abre el
   enlace, ve «Te han enviado un canal» y entra en la ficha del canal.

Reglas: el enlace va al índice (no a `/television/<otro>`, que conservaría esa
ruta y no navegaría); no hay servidor, cuenta ni sesión, y nada sale de la red
local; un fragmento manipulado se ignora (solo se acepta un payload válido).

Pruebas: `src/app/core/integrations/cast-session.spec.ts` (qué se puede enviar y
qué no, ida y vuelta del token, enlaces inválidos) y `e2e/cast-session.spec.ts`
(receptor real en un segundo contexto de navegador).

---

## 4. P3 — cajón de la parrilla (foco gestionado)

El cajón declara `aria-modal="true"`; ahora cumple el contrato
(`core/a11y/focus-trap.ts`, con pruebas unitarias y E2E):

1. **Foco inicial** en el control de cierre.
2. **Trampa de foco**: `Tab`/`Shift+Tab` ciclan entre el cierre y la región de
   desplazamiento de la guía; el foco no sale nunca del diálogo.
3. **Fondo inerte**: todo lo que no está en la ruta del diálogo recibe `inert` y
   `aria-hidden="true"`, también dentro del *shadow root* del componente.
4. **Bloqueo de scroll**: `body` fijo con la posición conservada; se restaura al
   cerrar (sin salto).
5. **Restauración de foco**: al cerrar (botón, `Escape` o fondo) el foco vuelve
   exactamente al control que abrió el cajón.

---

## 5. Content Security Policy

La CSP **no** puede aplicarse desde `<meta>` en este proyecto: el *builder* de
Angular inyecta un script de arranque en línea y `script-src` sin
`'unsafe-inline'`/`'unsafe-eval'` bloquearía toda la aplicación (verificado: con
la meta puesta, ni el enrutador ni el cajón se montaban; los E2E existentes
fallaban). Por eso se declara como **cabecera HTTP** en despliegue:

```text
Content-Security-Policy: default-src 'self';
  script-src 'self' https://www.youtube.com https://www.gstatic.com https://www.gstatic.com/cv/js/sender/;
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:;
  media-src 'self' https: blob:;
  connect-src 'self' https:;
  frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com;
  worker-src 'self' blob:;
  object-src 'none';
  base-uri 'self';
  frame-ancestors 'self'
```

Solo el reproductor oficial de YouTube es un *frame* de terceros permitido, y
solo en el dominio sin cookies. Si algún día hace falta `'unsafe-eval'`, será
por una dependencia concreta (p. ej. un motor de descifrado) y se justificará
aquí.

---

## 6. Verificación

- `src/app/core/integrations/youtube-target.spec.ts` — resolución pura de URLs:
  cada forma de vídeo, id de canal vs id de vídeo, *handles*, hosts ajenos,
  `javascript:`/`data:` y rechazos explícitos.
- `src/app/core/integrations/youtube-data-api.spec.ts` — Data API documentada,
  `status.embeddable`, propiedad del vídeo por canal, «no emite», cuota agotada,
  caché, de-duplicación y límites de cuota. Ninguna prueba toca la red.
- `src/app/core/player/youtube-engine.spec.ts` — el contrato `PlayerEngine`:
  `ready` ≠ `playing`, mapeo de `YT.PlayerState`, volumen/mute sin recrear el
  reproductor, códigos 100/101/150/153/5, *stall* sin `PLAYING` y teardown.
- `src/app/core/state/player.controller.youtube.spec.ts` — selección de motor por
  formato, resolución de canales (activo, sin emisión, no embebible, sin clave) y
  cambio YouTube↔HLS sin reproducciones simultáneas.
- `e2e/youtube.spec.ts` — 15 pruebas E2E deterministas con fixtures: las 12
  situaciones exigidas por TDT-CLONE-12 §6 más la ausencia de clave y un
  *handle*, en escritorio y móvil. Los *stubs* reproducen los dos hechos medidos
  del API real (sustituye el elemento; `onload` antes de `YT.Player`).
- `e2e/youtube-lazy.spec.ts` — el motor se descarga al abrir la ficha de YouTube,
  no con la aplicación.
- `scripts/playback/verify-youtube-live.mjs` — verificación **en red real** contra
  YouTube (no forma parte de `npm run test:e2e`).
- `src/app/core/integrations/youtube-embed.spec.ts` — identificadores canónicos,
  host sin cookies, `origin`, clasificación de errores (incluido 153).
- `src/app/core/integrations/verified-state.spec.ts` — cada estado con su dato de
  respaldo, nunca `live` para geo/pistas de cliente/formato no admitido, `UAG`/`REF`.
- `src/app/core/a11y/focus-trap.spec.ts` — trampa de `Tab`, `Escape`, fondo
  inerte (incluido *shadow root*), bloqueo de scroll, restauración de foco.
- `e2e/integrations.spec.ts` — estados verificados y la postura del reproductor
  oficial (dominio sin cookies, `origin`, `noopener noreferrer`, caída al enlace).
- `src/app/core/data/validators.spec.ts` — las opciones `youtube` con id canónico
  son reproducibles en la app; `iframe` y los ids no canónicos siguen siendo enlace.
