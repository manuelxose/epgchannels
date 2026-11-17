# VERIFICACION-FUENTES-02D — HTTP alcanzable ≠ vídeo reproducible

Documento de evidencia del milestone **TDT-API-02D**. Responde a una sola pregunta con medidas reales:

> ¿Un `HTTP 200` sobre un manifiesto prueba que el vídeo se puede reproducir?

**Respuesta medida: no.** Y este documento enseña el caso concreto, no la argumentación.

---

## 1. El caso que cierra la discusión

Fuente: `https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8` (distribución pública de
pruebas de Akamai; no es un emisor de catálogo).

| Eje | Observación | Veredicto |
|---|---|---|
| **A. Alcanzabilidad HTTP** | `200`, `application/x-mpegURL`, 217 bytes, primera línea `#EXTM3U`, manifiesto maestro válido con **1** variante | **sano** |
| **B. Reproducción real en navegador** | Chromium 158 carga el maestro, resuelve la variante `mastermaster_video10000k.m3u8`, y esa variante responde **404** | **`playback-failed-format`** |

El eje A **no puede** ver el fallo: no sigue hacia las variantes ni hacia los segmentos, porque su
trabajo es medir la respuesta del manifiesto. Un comprobador que sólo mira el `200` habría publicado
esta fuente como «sana» y el usuario habría visto un reproductor vacío.

Este caso no se fabricó: es una distribución pública real que hoy está rota. El script lo descubrió al
ejecutarse, y el capitán lo verificó de forma independiente:

```
MASTER 200 application/x-mpegURL bytes 217
variants: 1 | first: mastermaster_video10000k.m3u8
VARIANT_STATUS 404 /hls/live/2000341/test/mastermaster_video10000k.m3u8
```

## 2. Los dos ejes, medidos por separado y nunca derivados uno del otro

Herramienta: `apps/backend/scripts/browser-playback-check.mjs` (sin dependencias nuevas; resuelve
Playwright sin instalar nada).

| Fuente | A: HTTP | B: reproducción real |
|---|---|---|
| `test-streams.mux.dev/x36xhzz/x36xhzz.m3u8` | 200 `audio/mpegurl`, maestro, 5 variantes | **`played`** — 0,29 s, 1920×1080, `readyState` 4, sin `MediaError` |
| `devstreaming-cdn.apple.com/…/img_bipbop_adv_example_ts/master.m3u8` | 200 `application/x-mpegURL`, maestro, 24 variantes, **sin** cabecera ACAO | **`played`** — 0,23 s, 480×270, `readyState` 4 |
| `cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8` | 200 `application/x-mpegURL`, maestro, 1 variante | **`playback-failed-format`** (variante 404) |

Resumen: `played 2 · failed 1 · not-observable 0 · http-200-but-not-playable 1`.

**La fila 2 merece atención**: no hay cabecera ACAO y aun así reproduce, porque un `<video>` HLS no
necesita CORS para *reproducir* (sí lo necesita para leer píxeles). Es exactamente el tipo de matiz que
un informe simplista convierte en «fallo CORS» falso.

## 3. Controles negativos (prueban que los ejes discriminan)

| Control | A | B |
|---|---|---|
| Manifiesto inexistente (`…/does-not-exist.m3u8`) | `404 application/xml`, no-HLS | `http-unreachable` |
| HTML con 200 (`example.com`) | `200 text/html`, no-HLS | `http-unreachable` |

Los cuatro veredictos de la tabla principal y estos dos son **distintos**, lo que demuestra que el eje B
no se deriva del A: si lo hiciera, los negativos coincidirían con «HTTP no es 200».

## 4. Taxonomía de veredictos y por qué el orden importa

Orden de decisión: `played` → `autoplay-blocked` → CORS → 404/410 del recurso → ORB →
`MediaError` (4/3 → codec, resto → format) → `NETWORK_NO_SOURCE` → `timeout-no-progress`.

Dos decisiones de honestidad que un revisor debe verificar:

1. **CORS se decide ANTES que `MediaError`.** Chromium emite `MediaError` 4 tanto para una denegación
   CORS como para un códec no soportado. Ordenarlos al revés habría culpado al códec de un fallo de red.
2. **Un `play()` rechazado sin causa concreta se reporta `timeout-no-progress`**, no «format». Es un
   «no lo sé» explícito, no una adivinación con apariencia de diagnóstico.

Cuando el navegador no está disponible, el veredicto es **`not-observable`** con motivo declarado y
salida 0: es un desconocido honesto, ni un pase ni un fallo. Ese camino está demostrado de verdad
(`--no-browser`), no supuesto.

## 2-bis. Verificación real del motor sobre las fuentes públicas (posterior a §2)

Ejecutado con el motor de 02D (no con el comprobador de navegador) contra las mismas cuatro
distribuciones, tras corregir cuatro defectos que sólo aparecieron al ejecutar:

| Fuente | Resultado del motor | ¿Es verdad? |
|---|---|---|
| `test-streams.mux.dev/x36xhzz/x36xhzz.m3u8` | **`healthy` @ profundidad `segments`**, 6 peticiones | **sí** — maestro → variante → segmentos 200 |
| `devstreaming-cdn.apple.com/…/img_bipbop_adv_example_ts/master.m3u8` | **`healthy` @ profundidad `segments`**, 6 peticiones | **sí** |
| `devstreaming-cdn.apple.com/…/bipbop_16x9/bipbop_16x9_variant.m3u8` | `failing` / `response-too-large` | **sí** — medido: su primer segmento declara **59 366 640** bytes |
| `cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8` | `failing` / `missing-segments` | **sí** — medido: su única variante responde **404** |

Las dos filas «failing» **no son defectos del motor**: son la realidad del origen, medida
independientemente por el capitán (variante 404; segmento de 59 MB). Que el motor las distinga de las
sanas, con categorías distintas y en la profundidad donde obtuvo la evidencia, es el resultado buscado.

**Antes de estas correcciones las cuatro fallaban**, y fallaban con la categoría equivocada: un
directo HD sano se reportaba `missing-segments` por un presupuesto de tamaño mal aplicado. Ese es el
valor de haber ejecutado en vez de leer: cuatro defectos reales, ninguno visible con la suite en verde.

### Limitación que queda abierta (declarada)

El segmento de BipBop 16x9 declara 59 MB. Para **muestrear** (leer sólo 64 KiB y cortar) hace falta una
capacidad de lectura de prefijo en `safeFetch` que hoy no existe: la capa de egreso rechaza por
`content-length` declarado **antes de leer un byte**. Por eso, hoy, el ancho de banda por segmento
muestreado está acotado por el **techo de 4 MiB**, no por los 64 KiB de muestreo. La corrección de
contrato está registrada como t14 (propiedad de `ssrf-engineer`). Hasta que exista, esta cifra se
reporta tal cual, sin presentarla como si ya fuera 64 KiB.

## 5. Lo que este documento NO afirma

- **No** afirma nada sobre la legalidad de ninguna fuente. La autorización es otro eje (02C) y este
  documento no la toca.
- **No** generaliza: mide 3 fuentes públicas de prueba más 2 controles. No es un censo del catálogo.
- **No** usa una fuente del catálogo con derechos por resolver. Las fuentes del catálogo con
  clasificación `restricted`/`unresolved` en 02C **no** se sondean aquí para «demostrar» que funcionan:
  fabricar ese derecho es precisamente el defecto que 02C cerró.
- **No** dice que un `played` implique disponibilidad futura: un directo puede caer un minuto después.
  Es una observación con marca de tiempo, no una garantía.

## 5-bis. Limitación principal, declarada sin adornos

**El motor no ha verificado ni una sola fuente del catálogo real.** Medido sobre la base de datos viva:

| Dato | Valor medido |
|---|---|
| fuentes publicadas `hls`/`dash` con URL | **81** |
| con registro de autorización (`source_authorizations_02c`) | **0** |
| sin registro | **81** |

La colección `source_authorizations_02c` **no existe** en la base de datos operativa. Como el gate de
02C falla cerrado, las 81 fuentes son `ineligible` y el motor **no abre un solo socket** hacia ellas.
Eso **es el resultado correcto**, no un fallo del motor: es la prueba de que la elegibilidad precede a
la red. Pero implica que la verificación real contra el catálogo **no está demostrada** en este
milestone, y así se reporta.

Lo que sí está medido con red real: las cuatro distribuciones públicas de prueba, que ejercitan de
verdad el guard SSRF, el transporte, el manifiesto y la capa de segmentos (1–4 peticiones por fuente),
más la prueba de reproducción en navegador de §2.

Por qué no se «arregla» creando autorizaciones: fabricar un derecho para que una fuente pase el gate es
exactamente el defecto que la revisión independiente de 02C encontró, y este milestone no lo repite. La
única vía honesta es que un operador registre autorizaciones reales con evidencia citable.

## 6. Reproducir

```powershell
npm run build -w @tdt/backend
node apps/backend/scripts/browser-playback-check.mjs --out evidence/verification-02d/browser-playback.json
node apps/backend/scripts/browser-playback-check.mjs --url https://test-streams.mux.dev/does-not-exist.m3u8 --out %TEMP%/neg.json
node apps/backend/scripts/browser-playback-check.mjs --no-browser
```

Salida: 1 línea de resumen + como máximo 3 líneas de detalle; el informe completo queda en el JSON
acotado (sin cuerpos de playlist, sin tokens).
