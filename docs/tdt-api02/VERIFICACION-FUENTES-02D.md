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

## 5. Lo que este documento NO afirma

- **No** afirma nada sobre la legalidad de ninguna fuente. La autorización es otro eje (02C) y este
  documento no la toca.
- **No** generaliza: mide 3 fuentes públicas de prueba más 2 controles. No es un censo del catálogo.
- **No** usa una fuente del catálogo con derechos por resolver. Las fuentes del catálogo con
  clasificación `restricted`/`unresolved` en 02C **no** se sondean aquí para «demostrar» que funcionan:
  fabricar ese derecho es precisamente el defecto que 02C cerró.
- **No** dice que un `played` implique disponibilidad futura: un directo puede caer un minuto después.
  Es una observación con marca de tiempo, no una garantía.

## 6. Reproducir

```powershell
npm run build -w @tdt/backend
node apps/backend/scripts/browser-playback-check.mjs --out evidence/verification-02d/browser-playback.json
node apps/backend/scripts/browser-playback-check.mjs --url https://test-streams.mux.dev/does-not-exist.m3u8 --out %TEMP%/neg.json
node apps/backend/scripts/browser-playback-check.mjs --no-browser
```

Salida: 1 línea de resumen + como máximo 3 líneas de detalle; el informe completo queda en el JSON
acotado (sin cuerpos de playlist, sin tokens).
