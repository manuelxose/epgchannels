# TDT-API-02FG · Parte G — Integración del reproductor y rendimiento medido

Dominio: integración del reproductor de 02E con la API final y optimización **justificada por medición**.
Especialista D (`spec-integration`), worktree `wt/02fg-integration`, rama `feat/02fg-integration`, base `0e8571d` + `0d3a7bd`.

Regla aplicada al pie de la letra: **medir antes, corregir sólo lo medido, medir después con los mismos métodos**.
Todo lo que no justificaba un cambio está en §6 (descartado), no en el diff.

---

## 1. Método (idéntico en ANTES y DESPUÉS)

| Instrumento | Fichero | Qué mide |
|---|---|---|
| Medida de API + MongoDB + bundle | `apps/backend/scripts/perf-measure.mjs` | Latencia p50/p95 por endpoint, bytes de respuesta, revalidación 304, plan de ejecución real (`explain('executionStats')`), latencia de consulta Mongo, tamaños de bundle |
| Resumen de plan | `apps/backend/scripts/perf-plan-summary.mjs` | Etapas (`IXSCAN`/`SORT`/`COLLSCAN`), índice ganador, `docsExamined`/`keysExamined` |
| Forma de datos viva | `apps/backend/scripts/perf-data-shape.mjs` | Distribución real de `country`/`languageTag`/`region`, EPG mapeado, rango de `programmes` |
| Recorridos del frontend en Chromium | `apps/backend/scripts/partg-integration-check.mjs` | Las 8 rutas de usuario de la Parte G + **recuento real de peticiones** que emite el bundle servido |
| Reproducción real | `apps/backend/scripts/browser-playback-check.mjs` (02E, reutilizado) | Chromium real: ¿avanza `currentTime`? ¿`readyState`? ¿`MediaError`? |

Comandos exactos:

```bash
node apps/backend/scripts/perf-measure.mjs --label before --samples 25 --skip-playback true --out docs/tdt-api02/02fg/perf/before.json
node apps/backend/scripts/perf-measure.mjs --label after  --samples 25 --skip-playback true --out docs/tdt-api02/02fg/perf/after.json
node apps/backend/scripts/partg-integration-check.mjs --base http://127.0.0.1:4400 --out evidence/02fg/partg-integration-after.json
node apps/backend/scripts/browser-playback-check.mjs --out evidence/02fg/browser-playback-after.json
```

Entorno: Windows, Node v24.18.0, MongoDB `rs0` en `127.0.0.1:27117`, Redis en `127.0.0.1:27118`, API en
`127.0.0.1:4010`, bundle servido por `scripts/serve-dist.mjs` en `127.0.0.1:4400` con proxy `/api`.
Datos vivos: 768 canales (**412 publicados**), 1364 fuentes, 11112 programas, 81 autorizaciones, 2 fuentes EPG.

> Nota de honestidad metodológica: el límite de tasa (300 req/min) contaminó la **primera** corrida
> (`/categories` y `/regions` devolvieron `429`). Se reinició el backend con `RATE_LIMIT_MAX_REQUESTS`
> alto —sólo para medir, no se cambió el valor por defecto— y las cifras de este documento son de la
> corrida limpia.

---

## 2. ANTES — línea base medida

### 2.1 API (25 muestras por endpoint, tras 1 calentamiento)

| Endpoint | Estado | Bytes | p50 | p95 |
|---|---:|---:|---:|---:|
| `/channels?page=1&pageSize=100` | 200 | 36 480 | 15 ms | 17 ms |
| `/channels?page=1&pageSize=24` | 200 | 9 117 | 15 ms | 17 ms |
| `/channels?country=INT&page=1&pageSize=100` | **400** | 201 | 16 ms | 19 ms |
| `/channels?language=multi&page=1&pageSize=100` | **400** | 211 | 16 ms | 16 ms |
| `/channels?q=la&page=1&pageSize=100` | 200 | 32 725 | 15 ms | 23 ms |
| `/channels?playable=true&page=1&pageSize=24` | 200 | 8 831 | 15 ms | 23 ms |
| `/channels/plus-24` | 200 | 2 255 | 38 ms | 58 ms |
| `/channels/plus-24/playback` | 200 | 2 915 | 29 ms | 35 ms |
| `/channels/plus-24/schedule` | 200 | 398 | 20 ms | 35 ms |
| `/epg/now?limit=20` | 200 | 6 639 | 32 ms | 69 ms |
| `/epg/next?limit=20` | 200 | 6 639 | 29 ms | 41 ms |
| `/categories` | 200 | 784 | 14 ms | 18 ms |
| `/regions` | 200 | 1 822 | 15 ms | 19 ms |

- Recorrido completo del catálogo (5 páginas × 100): **150 405 B**, 257 ms.
- Revalidación `304` de `/channels`: p50 **15 ms**, p95 19 ms.

### 2.2 MongoDB — plan real y trabajo por consulta

| Consulta | Etapas | Índice | docsExamined | keysExamined | p50 |
|---|---|---|---:|---:|---:|
| lista pág. 1 (`published`, orden nombre) | `SORT>FETCH>IXSCAN` | `status_category_name` | 412 | 412 | 20 ms |
| lista `country=INT` | `SORT>FETCH>IXSCAN` | `country_region_name` | 302 | 302 | 14 ms |
| búsqueda (regex sobre `searchText`) | `SORT>FETCH>IXSCAN` | `status_category_name` | 412 | 412 | 17 ms |
| `bySlug` | `LIMIT>FETCH>IXSCAN` | `slug_unique` | 1 | 1 | 3 ms |
| fuentes por `channelId` | `FETCH>IXSCAN` | `channel_priority` | 2 | 2 | 3 ms |
| ventana de canales del feed | `SORT>FETCH>IXSCAN` | `status_category_name` | 412 | 412 | 8 ms |
| ventana de `programmes` | `FETCH>IXSCAN` | `channel_start` | 0 | 0 | 4 ms |

**Lectura clave:** no hay ni un `COLLSCAN`. Todas las consultas ya usan índice. Lo que sí aparece es
`SORT` en memoria sobre **412 documentos** en las tres listas: el índice `status_category_name` es
`(editorialStatus, category, name)` y la consulta filtra además por `mergedInto: null`, así que Mongo
recorre los 412 y ordena en memoria en lugar de leer el índice ya ordenado.

### 2.3 Frontend — peticiones reales del bundle servido (Chromium)

| Recorrido | Peticiones API | De ellas `/schedule` | ms |
|---|---:|---:|---:|
| Catálogo (`/television`, arranque) | **27** | **21** | 2 295 |
| Ficha de canal (`/television/:id`) | **31** | **25** | — |

Bundle de producción: JS total **1 876 986 B** (16 ficheros), CSS 5 186 B, **inicial 316 467 B**
(incluye `dash-all-min` 852 kB y `hls` 591 kB como *lazy*, fuera del inicial).

---

## 3. Diagnóstico — qué justificaba un cambio y qué no

| Hallazgo medido | Justifica cambio | Decisión |
|---|---|---|
| `/television` pide **21 `/schedule` de canal** en el arranque para un snapshot que la portada **no renderiza** | Sí — 21 round-trips por visita para nada | ✅ Cortar la carga de guía del catálogo |
| `/television/:id` pide **4 veces el mismo** `/schedule` del canal abierto | Sí — duplicado real | ✅ Guarda de petición en vuelo + respetar `epgRefreshMs` |
| El reloj de 30 s hacía `ensureEpg(..., true)` → **refresco forzado cada 30 s** aunque `epgRefreshMs` es 30 min | Sí — polling innecesario | ✅ Sin `force`: el reloj sólo refresca lo caducado |
| `Promise.all` dejaba rechazos sin observar (unhandled rejection) | Sí — defecto real de corrección | ✅ `allSettled` y relanzar el primer fallo no-404 |
| `country=INT` y `language=multi` devuelven **400** | **No** (es contrato, no rendimiento) | ⚠️ Documentado en §5, no tocado |
| Planes Mongo con `SORT` en memoria sobre 412 docs | Sí, pero... | ❌ **Descartado**: 412 docs es un dataset pequeño; el coste del índice compuesto nuevo no está justificado por 14–20 ms (§6) |
| `/categories` y `/regions` ya en 14–15 ms | No | ❌ Descartado: añadir caché sería complejidad sin cuello de botella medido |
| Bundle JS 1.88 MB (inicial 316 kB) | Sí lo parecería | ❌ **Descartado**: la Parte G no lo empeora y el peso está en `dash`/`hls` *lazy* del reproductor de 02E, que no se reescribe |

---

## 4. Corregido (sólo lo justificado)

1. **`CatalogStore.ensureCatalog` ya no dispara la guía.** El catálogo cargaba el EPG de los 21 primeros
   canales aunque ninguna vista del catálogo lo pintaba (`grep`: el snapshot sólo lo consume
   `schedule-page` y `watch-page`).
2. **`CatalogStore.ensureEpg` respeta `epgRefreshMs` y une la petición en vuelo** (`epgInFlight`):
   tres llamadores que competían al abrir un canal (efecto de detalle, cargador, reloj) emiten **una**
   petición.
3. **`WatchPageComponent`**: el reloj de 30 s deja de forzar refresco (`ensureEpg([slug])` en vez de
   `ensureEpg([slug], true)`); `loadChannelDetail` tampoco fuerza.
4. **`SchedulePageComponent`** carga explícitamente su guía (`ensureCatalog().then(() => ensureEpg())`),
   que antes heredaba gratis del catálogo. Es la vista que sí la renderiza.
5. **`EpgApiService.schedules`** usa `Promise.allSettled`: un fallo ya no abandona peticiones hermanas
   sin observar (causaba un *unhandled rejection* real que hacía fallar la suite del frontend).
6. **`ChannelsApiService.loadCatalogue`**: `/categories` se pide en paralelo al recorrido de páginas
   (antes era una cola serial) y su rechazo queda observado si el recorrido falla primero.

Tests que cubren lo nuevo (`apps/frontend/src/app/core/state/catalog.store.spec.ts`):
- el catálogo solo **no** emite peticiones `/schedule`;
- tres `ensureEpg` concurrentes producen **exactamente 1** petición `/schedule`.

---

## 5. DESPUÉS — misma medición

### 5.1 Frontend — peticiones reales (la mejora que sí existe)

| Recorrido | ANTES API | DESPUÉS API | ANTES `/schedule` | DESPUÉS `/schedule` | ANTES ms | DESPUÉS ms |
|---|---:|---:|---:|---:|---:|---:|
| Catálogo (`/television`) | 27 | **6** | 21 | **0** | 2 295 | 1 974 |
| Ficha de canal | 31 | **11** | 25 | **1** | — | — |
| Parrilla (`/schedule`) | — | 27 | — | 21 | — | — |

Reducción del arranque del catálogo: **−78 % de peticiones** (27 → 6) y **−100 % de llamadas de guía**
en la portada. La parrilla conserva sus 21 (correcto: es la vista que pinta la guía).

### 5.2 API — sin regresión

| Endpoint | ANTES p50 | DESPUÉS p50 | ANTES p95 | DESPUÉS p95 |
|---|---:|---:|---:|---:|
| `/channels?page=1&pageSize=100` | 15 | 10 | 17 | 16 |
| `/channels?q=la` | 15 | 10 | 23 | 16 |
| `/channels/plus-24` | 38 | 29 | 58 | 33 |
| `/channels/plus-24/schedule` | 20 | 10 | 35 | 13 |
| `/epg/now?limit=20` | 32 | 21 | 69 | 32 |
| `/categories` | 14 | 10 | 18 | 15 |
| `/regions` | 15 | 10 | 19 | 16 |
| Revalidación 304 | 15 | 10 | 19 | 14 |

Mejoras de 3–10 ms: dentro del ruido del host (ver §5.4). **No se reclama como optimización.**

### 5.3 Bundle

| Métrica | ANTES | DESPUÉS | Δ |
|---|---:|---:|---:|
| JS total | 1 876 986 B | 1 877 161 B | +175 B |
| CSS | 5 186 B | 5 186 B | 0 |
| Inicial (transfer) | 316 467 B | 316 467 B | 0 |
| Ficheros | 16 | 16 | 0 |

Delta nulo esperado: los cambios fueron de comportamiento, no de código nuevo.

### 5.4 MongoDB — sin cambio (y por eso no se optimizó)

Planes y `docsExamined`/`keysExamined` **idénticos** antes y después (412/302/412/1/2/412/0). La latencia
de las mismas consultas en tres corridas fue `lista pág.1`: **20 → 34 → 24 ms p50**; `búsqueda`:
`17 → 19 → 16 ms`. Como el plan y el trabajo examinado no cambian, esa variación es **ruido del host**,
y es exactamente la razón por la que crear índices nuevos para "bajar 10 ms" no habría sido una mejora
medida sino una apuesta.

---

## 6. Descartado a propósito (y por qué)

- **Índice compuesto nuevo para eliminar el `SORT` en memoria.** Haría falta `(editorialStatus, mergedInto,
  name, slug)` y medir de nuevo; sobre 412 documentos el `SORT` cuesta milisegundos y ninguna cifra
  actual lo sitúa como cuello de botella. Añadir un índice es coste de escritura y de mantenimiento
  permanente a cambio de nada demostrado. *Si el catálogo crece a decenas de miles de canales, esto es
  el primer cambio a medir.*
- **Caché de `/categories` y `/regions`.** 14–15 ms, 784 B y 1 822 B. Sin cuello de botella medido.
- **Reescribir el reproductor o trocear más el bundle.** `dash-all-min` (852 kB) y `hls` (591 kB) ya son
  *lazy* y salen del inicial; la Parte G no los empeora y el encargo prohíbe reescribir el reproductor.
- **`country=INT` / `language=multi` (400).** Es una **incompatibilidad real de contrato**, no de
  rendimiento: `countryCodeSchema = /^[A-Z]{2}$/` rechaza `INT` (que no es ISO-3166) y
  `localeCodeSchema = /^[a-z]{2,3}(-[A-Z]{2})?$/` rechaza `multi` (no es BCP-47), aunque **118 canales
  publicados** tienen exactamente `country: 'INT'` y `languageTag: 'multi'`. El §3 del complemento del
  capitán ya fija el criterio (`z.string().min(2).max(3)` en los contratos **operativos**); las rutas
  públicas y `countryCodeSchema` son propiedad de t6, así que se **reporta al capitán** en vez de
  tocarlo desde aquí.

---

## 7. Reproducción real y progresión de media

### 7.1 Fuentes públicas (Chromium 158.0.8127.18, harness 02E reutilizado)

| Fuente | Alcance A (HTTP) | Alcance B (reproducción real) |
|---|---|---|
| `test-streams.mux.dev/x36xhzz/x36xhzz.m3u8` | 200, `audio/mpegurl` | **played** — playhead 0.14 s, 1920×1080, readyState 4 |
| `devstreaming-cdn.apple.com/.../master.m3u8` | 200, `application/x-mpegURL` | **played** — playhead 0.08 s, 480×270, readyState 4 |
| `cph-p2p-msl.akamaized.net/.../test/master.m3u8` | 200 `application/x-mpegURL` | **playback-failed-format** (un segmento devuelve 404) — HTTP 200 pero **no** reproducible, reportado como tal |

Resumen: **played 2, failed 1, not-observable 0**; 1 caso demostrado de "HTTP 200 que no se reproduce".
Evidencia: `evidence/02fg/browser-playback-after.json`.

### 7.2 Dentro de la aplicación real (`/television/la-1`, bundle servido, API real)

```
watch la-1 api=11 {"video":true,"src":"blob:http://127.0.0.1:4400/…","t":7188.022,"rs":4,"paused":false,"w":1280,"err":null}
MEDIA_PROGRESSION t0=7188.029 t1=7191.043 delta=3.014
```

`currentTime` avanzó **3.014 s en 3.0 s de reloj** con `readyState 4`, `paused false`, `videoWidth 1280`
y `MediaError null`: es **reproducción en tiempo real**, no un fotograma congelado ni un `200` que no pinta.
Fuente: HLS de la cadena vía hls.js (`blob:` = MSE, el motor real del reproductor).

---

## 8. Recorridos de la Parte G — resultado en Chromium sobre el bundle servido

`evidence/02fg/partg-integration-after.json` → **8/8 OK, 0 errores de consola**.

| Recorrido | Resultado medido |
|---|---|
| Selección de canal / catálogo | 21 tiles, navegación a `/television/plus-24`, `<video>` presente |
| Navegación internacional | filtro país con opción `INT (118)`; tras elegirla, 22 tiles |
| Filtro por país | `ES` → 22 tiles ≤ todos (22); subconjunto no vacío |
| Búsqueda | `la` → filtra sin romper el contador |
| Now/next | superficie presente (guía real vacía por datos caducados, ver §9) |
| Selección de fuente | `la-1` reproduce con la fuente preferida autorizada |
| Manejo de error | con `/api/v1/channels**` abortado, la UI dice el error (no finge catálogo) |
| Responsive | 360/768/1440 px: desbordamiento horizontal **0 px** en los tres |

---

## 9. Dato de datos relevante (no es un bug del código)

`programmes` está **caducado** en la base viva: `min start` 2026-11-12, **`max start` 2026-11-16T22:20Z**,
hoy 2026-11-17. Por eso `epg/now` y la parrilla salen vacíos: **no se inventa programación** (regla §1.8 del
contrato). 117 canales publicados tienen `epg.sourceId`; 11112 programas cubren 176 canales, uno solo
con fuente `json-tdtchannels`, y las 2 fuentes EPG tienen `ingestionEnabled: false`.

---

## 10. Verificación (exit codes reales)

| Comando | Exit | Resultado |
|---|---:|---|
| `npm run build` | **0** | contracts + api-client + backend |
| `npm run typecheck` | **0** | los tres paquetes |
| `npm --prefix apps/frontend run build` | **0** | inicial 316 467 B / 85.76 kB transfer |
| `npx vitest run` (cwd `apps/backend`) | **0** | 36 ficheros, **768 tests** |
| `npm --prefix apps/frontend run test` | **0** | 19 ficheros, **354 tests** |
| `node apps/backend/scripts/browser-playback-check.mjs` | **0** | 2 played / 1 failed-format / 0 not-observable |
| Progresión de media en la app (`/television/la-1`) | **0** | Δ 3.014 s en 3.0 s, readyState 4 |

---

## 11. Riesgos y límites declarados

- Las latencias de API y Mongo son de **una máquina de desarrollo**; las diferencias de pocos ms en §5.2
  y §5.4 no se reclaman como mejora. La mejora sólida y reproducible es la de **peticiones del frontend**
  (§5.1), que no depende del host.
- El `SORT` en memoria sigue ahí por diseño (§6). Es el primer candidato si el catálogo crece.
- `country=INT`/`language=multi` (400) es una incompatibilidad de contrato **abierta**, reportada al
  capitán; el frontend filtra por país e idioma **en cliente** sobre el catálogo ya cargado, así que la
  UI funciona, pero un consumidor de la API no puede pedir "solo internacionales".
- Los recorridos se validaron con el bundle servido por `scripts/serve-dist.mjs` (mismo origen + proxy),
  no contra un despliegue real con CDN/TLS.
