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
distribuciones, tras corregir los defectos que sólo aparecieron al ejecutar:

| Fuente | Resultado del motor | ¿Es verdad? |
|---|---|---|
| `test-streams.mux.dev/x36xhzz/x36xhzz.m3u8` | **`healthy` @ profundidad `segments`**, 6 peticiones | **sí** — maestro → variante → segmentos 200 |
| `devstreaming-cdn.apple.com/…/img_bipbop_adv_example_ts/master.m3u8` | **`healthy` @ profundidad `segments`**, 6 peticiones | **sí** |
| `devstreaming-cdn.apple.com/…/bipbop_16x9/bipbop_16x9_variant.m3u8` | **`healthy` @ profundidad `segments`**, 6 peticiones | **sí** — su segmento es media real `video/MP2T` (ver corrección) |
| `cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8` | `failing` / `missing-segments` | **sí** — medido: su única variante responde **404** |

**Tres de cuatro sanas; la cuarta rota en el origen.** La fila Akamai no es un defecto del motor: es la
realidad de ese origen, medida de forma independiente (variante 404). Que el motor distinga las sanas de
la rota, con categorías distintas y en la profundidad donde obtuvo la evidencia, es el resultado buscado.

### Corrección sobre `bipbop_16x9` (documentada porque me equivoqué al interpretarla)

En una medición anterior clasifiqué esta fuente como `response-too-large` y la traté como «genuinamente
irreparable por política», porque su segmento declara **59 366 640** bytes. **Eso era incorrecto.** Al
leer sólo un prefijo, el contenido resulta ser media válida:

```
SAMPLE bytes 65536 truncated true ct video/MP2T
FULL download bytes refused ct -
```

El segmento **es un segmento real y reproducible**; lo que lo rechazaba era un **presupuesto de tamaño**,
no un defecto de contenido. Es decir: la política de tamaño estaba declarando no-reproducible una fuente
sana. Con el muestreo por prefijo, el motor ahora la acierta. Corregir esto valía la pena: era el mismo
error conceptual que el resto de la ronda — culpar al contenido de una decisión de política.

### Semántica de tamaño que queda (decisión del capitán, opción (a))

`SEGMENT_MAX_BYTES` (4 MiB) es **tolerancia de longitud declarada**, no un filtro de admisión. Con la
lectura por prefijo, un segmento enorme que **se sirve bien** se reporta sano **porque sólo se muestrea**
(64 KiB por segmento). Consecuencia declarada sin adornos: el veredicto «saludable» significa que el
manifiesto, la variante y los segmentos muestreados se recuperan y son del tipo correcto — **no**
significa «cualquier tamaño es aceptable». El ancho de banda por muestra sí está acotado (medido:
1 544 984 B sin tope → **65 536 B** con tope, 23× menos).

## 5. Lo que este documento NO afirma

- **No** afirma nada sobre la legalidad de ninguna fuente. La autorización es otro eje (02C) y este
  documento no la toca.
- **No** generaliza: mide 3 fuentes públicas de prueba más 2 controles. No es un censo del catálogo.
- **No** usa una fuente del catálogo con derechos por resolver. Las fuentes del catálogo con
  clasificación `restricted`/`unresolved` en 02C **no** se sondean aquí para «demostrar» que funcionan:
  fabricar ese derecho es precisamente el defecto que 02C cerró.
- **No** dice que un `played` implique disponibilidad futura: un directo puede caer un minuto después.
  Es una observación con marca de tiempo, no una garantía.

## 5-bis. Limitación principal — **RESUELTA el 2026-11-17**

> **Estado vigente: resuelta.** El propietario del producto autorizó la verificación de todas las
> fuentes, se registró la decisión y **el motor ha verificado las 81 fuentes publicadas**. El resultado
> está en §5-ter. El texto siguiente se conserva como historia de por qué estaba bloqueado y de cómo se
> desbloqueó.

**El motor no había verificado ni una sola fuente del catálogo real.** Medido sobre la base de datos viva
antes de la autorización:

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
única vía honesta es que **el propietario del producto** autorice y que la decisión quede registrada con
su ámbito declarado.

## 5-ter. Resultado tras la autorización del propietario (2026-11-17)

**Qué se autorizó, dicho con precisión.** El propietario del producto autorizó *la plataforma a
**verificar** estas fuentes* (sondeo técnico de manifiesto, variante y segmentos muestreados). **No** es
una declaración de que cada emisor haya concedido derechos de redistribución: eso es otra pregunta
(D-017) sobre la que aquí no hay evidencia. Cada registro lo dice en sus propios campos
(`quotedClause`, `reviewStatus: pending-review`, `notes`), de modo que un auditor distingue una
autorización del propietario de una licencia del emisor.

**Mecanismo.** `apps/backend/scripts/authorize-verification.mjs` escribe un registro por fuente en
`source_authorizations_02c`, con la URL del registro de decisiones como cita. Después:

```
node apps/backend/scripts/verify-catalogue.mjs --limit 81 --concurrency 3
```

**Resultado medido sobre el catálogo real completo:**

| Métrica | Valor |
|---|---|
| Fuentes verificadas | **81 de 81** (todas con autorización resuelta por el mismo lookup que usa el gate) |
| Sanas a profundidad `segments` | **63** |
| Fallando | **18** |
| Peticiones externas totales | **396** (≈ 4,9 por fuente) |
| Tiempo de pared | **15,9 s** con concurrencia 3 |
| Categorías de fallo | `http-404` ×9, `unsupported-format` ×8, `missing-segments` ×1 |

Los fallos **se concentran en dos hosts** y son diagnóstico accionable, no ruido:

- **`ztnr.rtve.es` → 9 × `http-404`** (más 1 `missing-segments`): esas 10 fuentes apuntan a manifiestos
  que ya no existen en ese host.
- **`laxarxames.cat` / `www.laxarxames.cat` → 8 × `unsupported-format`**: responden con un
  `content-type` que no es HLS/DASH.

Esto es exactamente lo que el motor debía producir: no «un número de sanos», sino **qué está roto y por
qué, por host**, para que el operador pueda actuar.

### Nota metodológica: dos errores de instrumento en esta medición

Al construir esta medicina aparecieron dos fallos **en mis herramientas de medida**, ambos del tipo que
02D lleva toda la ronda persiguiendo:

1. El censo consultaba `forSourceId` (que sólo casa ids `editorial:`/`fixture:`) mientras el gate consulta
   `decisionsForSources` (por `sourceUrl`). Reportaba «0 autorizaciones» **con 81 filas en la colección**.
   Corregido para usar el mismo lookup que el gate.
2. Mi primer registro usaba `_id = <operador>:<host>`, que el gate no consulta, y omitía `clauseUrl` y
   atribución, de modo que el gate respondía `authorization-missing-quote` y `attribution-missing`. Eran
   rechazos **correctos** del gate; el defectuoso era el registro.

Lección, la misma de D-023 vista desde otro ángulo: **un instrumento de medida que pregunta algo distinto
de lo que pregunta el sistema produce una cifra que parece autorizada y es falsa.**

## 6. Reproducir

```powershell
npm run build -w @tdt/backend
node apps/backend/scripts/browser-playback-check.mjs --out evidence/verification-02d/browser-playback.json
node apps/backend/scripts/browser-playback-check.mjs --url https://test-streams.mux.dev/does-not-exist.m3u8 --out %TEMP%/neg.json
node apps/backend/scripts/browser-playback-check.mjs --no-browser
```

Salida: 1 línea de resumen + como máximo 3 líneas de detalle; el informe completo queda en el JSON
acotado (sin cuerpos de playlist, sin tokens).
