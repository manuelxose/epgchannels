# Informe REA — ciclo de reproducción web, media y HLS/DASH

**Milestone:** TDT-API-02A · **Tarea:** t2 `[rea]` · **Intento:** 1 (`39340a2d-b8e5-4e83-9d0f-b0d09f84c492`)
**Worktree:** `C:\Users\Admin\Documents\workspace\streaming\wt\tdt02a-rea` (rama `feat/tdt02a-rea`, base `febbec4`)
**Fecha de captura:** 2026-11-16, 14:17–14:19 UTC (15:17–15:19 Europe/Madrid)
**Herramienta:** REA (MCP `rea__*`), `rea-agents 6.8.0`, skill `reverse-engineer-anything` v49
**Asignación de modelo:** L2, `deepseek-official/deepseek-flash` (investigación y documentación)

---

## 1. Alcance y reglas

Objetivo: documentar con evidencia observada el **ciclo de reproducción web**, las **solicitudes de media** (manifiestos y segmentos) y la **compatibilidad HTML5/HLS/DASH**, más la arquitectura de la aplicación del reproductor, usando REA.

Reglas aplicadas durante toda la tarea:

- Solo páginas públicas y flujos autorizados. **No** se intentó evadir DRM, geobloqueo, autenticación, paywalls ni retos anti-bot.
- No se enviaron credenciales. No se usaron cookies de sesión ni tokens.
- Navegador de REA en modo *launch* con perfil temporal propio (headless), nunca conexión a un puerto 9222 supuesto.
- Una carga por página; sin pruebas de carga ni sondeos masivos.
- No se modificó el código de producción ni la instalación de REA.

## 2. Instalación de REA observada

| Dato | Valor observado |
|---|---|
| Paquete | `rea-agents` **6.8.0** (`mcpName: io.github.morluto/rea`, licencia MIT) |
| Raíz instalada | `C:\Users\Admin\AppData\Local\blg\toolchain\node-v24.22.2-win-x64\node_modules\rea-agents` |
| Lanzador | `…\rea-agents\scripts\rea.mjs`; binarios `rea` / `rea-agents` |
| Servidor MCP | `rea 6.8.0`, arrancado 2026-11-15T21:18:06Z |
| SDK / protocolo | server 2.3.1, cliente de prueba 2.3.1; protocolo negociado 2026-07-28 |
| Catálogo | **229 herramientas MCP**, 175 comandos CLI, 6 prompts |
| Digest del catálogo | `fe938a7c6eba3763b22ae2022de76dc4a7812d35d86f1d4efd36b9962b04da0b` |
| Skill instalada | `C:\Users\Admin\.agents\skills\reverse-engineer-anything\SKILL.md`, `version: "49"` |
| Documentación instalada | `README.md`, `DISCLAIMER.md`, `THIRD_PARTY_NOTICES.md`, `skills/`; **no** hay carpeta `docs/` en el paquete publicado (el README enlaza a `docs/` del repositorio, no incluida) |

### Herramientas disponibles para esta tarea

- **Navegador/CDP:** `capture_browser_scenario` (launch/connect), `list_browser_targets`, `inspect_web_page`, `capture_web_screenshot`, `observe_web_session`, `discover_webmcp_tools`, `inspect_web_event_listeners`, `compare_web_captures`, `compare_web_screenshots`.
- **Aplicación web/JavaScript:** `analyze_web_bundle`, `analyze_javascript_application`, `export_web_scripts`, `inspect_analysis_view`, `trace_javascript_semantics`, `trace_application_feature`, `reconcile_javascript_runtime`, `export_environment_bundle`.
- **Evidencia:** `export_evidence_bundle`, `import_evidence_bundle`, `get_evidence_bundle`, `inspect_analysis_view`.
- **Artefactos varios:** inspección de archivos, ejecutables Go/Rust, .NET gestionado, SQLite, Python `.pyc`, BEAM, APK (firma), modelos GGUF/safetensors, Electron.

### Capacidades no disponibles observadas (relevantes o no)

| Capacidad | Estado | Motivo |
|---|---|---|
| Ghidra (análisis nativo profundo) | no disponible | `GHIDRA_INSTALL_DIR` sin configurar |
| Hopper / IDA / JEB / Kuna | no disponible | proveedor no configurado |
| adb / apktool / JADX | no disponible | binarios no instalados |
| Herramientas macOS (Mach-O, plist, firma Apple, UI nativa) | no disponible | host Windows |
| pcap/tshark, firmware, pwntools, sigrok, Wakaru, WABT | no disponible | perfiles Linux o binarios externos no configurados |
| Captura de procesos | no disponible | host no soportado |

Ninguna de las capacidades ausentes bloqueó este estudio: el proveedor de navegador/CDP y el analizador JavaScript estaban disponibles.

## 3. ¿Existe una carpeta local `rea` en el workspace?

**No.** Búsqueda recursiva de directorios llamados `rea` bajo `C:\Users\Admin\Documents\workspace\streaming` (excluyendo `node_modules`): **0 resultados**. Lo que sí existe es material de referencia del reproductor, reunido en hitos anteriores:

- `reference\player-doc\television.html` — 218.488 B, HTML SSR de `player.tdtchannels.com/television` (Next.js/Turbopack).
- `reference\player-bundles\` — 11 chunks JS (`/_next/static/chunks/…`) + `manifest.json` con URL, bytes y SHA-256 de cada uno (capturados el 2026-11-13).
- `reference\data\` — `tv.json` (515.062 B), `TV.epg.json` (3.935.897 B), `hls-probe.json` (2.916 B).
- `tools\` — utilidades Node de captura/sondeo previas (p. ej. `probe-hls.mjs`, `net-observe.mjs`).

Estos ficheros se usaron solo como contexto; la evidencia de este informe procede de capturas REA nuevas.

## 4. Evidencia capturada (resumen)

| Evidencia | Operación | Objetivo | Resultado |
|---|---|---|---|
| `ev_51dfba1e9c78…ac6ce` | `capture_browser_scenario` | `https://player.tdtchannels.com/television/La1` | **Reproducción HLS real**: 2 manifiestos + 5 segmentos `.ts` |
| `ev_55f7d155fb1b…6e88` | `capture_browser_scenario` | `https://player.tdtchannels.com/` | Redirección a `/television`; catálogo de 768 canales, sin media |
| `ev_807df5e08085…3937` | `capture_browser_scenario` | `https://bitmovin.com/demos/dash` | Reto Cloudflare Turnstile; **sin manifiesto DASH** |
| `ev_6e31189b97f8…0111` | `capture_browser_scenario` | demo Shaka (build sin compilar) | Error `shaka.util.CmsdManager is not a constructor`; sin media |
| `ev_c93a4fe1a7b7…66c6` | `capture_browser_scenario` | demo Shaka (`#build=compiled`) | Carga `app_manifest.json` (lista de assets) y respuestas 503; **sin `.mpd`** |
| `ev_054bcf28f996…67fb` | `analyze_web_bundle` | app del reproductor (CDP 127.0.0.1:9333) | Análisis **parcial** (cancelado): 21 scripts vistos, 3 parseados |
| `ev_db7e35d6807a…6a3a` | `list_browser_targets` | Chrome propio (CDP 9333) | 1 página: `La 1 \| TDTChannels` |

Los registros completos de las capturas principales están en `evidence/rea/sesion-rea-records.json`; el resumen factual extraído está en `evidence/rea/capturas-resumen.json`.

## 5. Flujo del reproductor observado — TDTChannels / La 1

### 5.1 Navegación y ciclo de vida

1. `https://player.tdtchannels.com/` → **HTTP 30x** a `https://player.tdtchannels.com/television` (observado en la captura de llegada).
2. La parrilla (`/television`) muestra **768 canales**, **21 por página**, con enlaces `/television/<Canal>`; “La 1” → `/television/La1`.
3. La página de canal (`/television/La1`) es una app **Next.js (App Router/Turbopack)**: shell SSR + chunks `/_next/static/chunks/*` + peticiones RSC `?_rsc=…`.
4. Al entrar en `/television/La1`, el reproductor arranca **sin gesto adicional** en la captura (autoplay silenciado/headless): descarga el manifiesto maestro, el de variante y empieza a pedir segmentos.
5. Los medios se piden por **XHR** con cabeceras `Origin: https://player.tdtchannels.com` y `Referer: https://player.tdtchannels.com/`, señal compatible con reproducción **MSE + librería JS** (Chrome 157 no reproduce HLS de forma nativa).

Estado de carga reconstruido a partir de la secuencia de red: documento y chunks → manifiesto maestro → manifiesto de variante → primeros segmentos → sondeos periódicos del manifiesto de variante (3 recargas en 12 s, coherente con `TARGETDURATION=5`). La captura **no** contiene eventos de UI de play/pause; la reproducción se infiere de la petición continuada de segmentos, no de un `video.play()` observado.

### 5.2 Manifiestos y segmentos

**Manifiesto maestro** — `https://rtvelivestream.rtve.es/rtvesec/la1/la1_main_dvr.m3u8`

- 2.118 B, HTTP 200, `content-type: application/vnd.apple.mpegurl`, `content-encoding: gzip`, `cache-control: max-age=3`.
- Generado con “Golumi Video Platform”.
- 3 pistas de audio (`#EXT-X-MEDIA:TYPE=AUDIO`): Castellano (`spa`, DEFAULT), Original (`qaa`), Audio Descripción (`ads`, `public.accessibility.describes-video`).
- 6 pistas de subtítulos (`TYPE=SUBTITLES`): es, en, gl, ca, eu (y grupo `subtitulos`).
- **Una** variante de vídeo: `BANDWIDTH=3012608`, `RESOLUTION=1280x720`, `CODECS="avc1.640029,mp4a.40.2"`.
- La variante apunta a `la1_main_dvr_720.m3u8`; las pistas de audio/subtítulos usan URI absolutas (`…_a_39.m3u8`, `…_a_195.m3u8`, `…_es.m3u8`, etc.).

**Manifiesto de variante** — `https://rtvelivestream.rtve.es/rtvesec/la1/la1_main_dvr_720.m3u8`

- 135.498 B **descomprimidos** (`content-length` gzip 7.904–7.906 B), HTTP 200, mismo `content-type`, `cache-control: max-age=3`.
- `#EXT-X-VERSION:3`, `#EXT-X-TARGETDURATION:5`, `#EXT-X-MEDIA-SEQUENCE:5548`, `#EXT-X-ALLOW-CACHE:YES`.
- **1.440 entradas `#EXTINF:5.0`** → ventana DVR de ~2 h (7.200 s) sin `#EXT-X-ENDLIST` (directo).
- **Sin `#EXT-X-KEY` ni `#EXT-X-MAP`** en lo capturado: HLS en claro, segmentos MPEG-TS.
- URI de segmentos absolutas: `https://rtvelivestream.rtve.es/rtvesec/la1/GL7/2_v_3_<AAAAMMDD>_<HHMMSS>_<seq>.ts`.

**Segmentos** (5 únicos capturados; ventana 15:17:02–15:17:22 UTC)

| Segmento | `content-type` | `content-length` | Estado |
|---|---|---|---|
| `…_15_17_02_6983.ts` | `video/mp2t` | 2.540.820 B | 200 |
| `…_15_17_07_6984.ts` | `video/mp2t` | 2.659.824 B | 200 |
| `…_15_17_12_6985.ts` | `video/mp2t` | 1.699.332 B | 200 |
| `…_15_17_17_6986.ts` | `video/mp2t` | 1.075.360 B | 200 |
| `…_15_17_22_6987.ts` | `video/mp2t` | 1.277.272 B | 200 |

Tamaño ≈ 1,0–2,7 MB por 5 s → **1,7–4,3 Mbps** instantáneos, consistente con el `BANDWIDTH` declarado (3,01 Mbps).

### 5.3 Cabeceras relevantes (observadas)

- Manifiestos y segmentos: `access-control-allow-origin: *`; en el manifiesto además `access-control-allow-credentials: true`, `access-control-allow-headers: origin,range,hdntl,hdnts,CMCD-Request,CMCD-Object,CMCD-Status,CMCD-Session`, `access-control-max-age: 86400`, `vary: Accept-Encoding`.
- Segmentos: `accept-ranges: bytes`, `cache-control: max-age=18000`, `etag`, `last-modified`, `server: nginx/1.22.1`, caché CDN (`x-cache: HIT`, `via`).
- **No se observaron** cabeceras de autenticación, cookies ni tokens en las peticiones de media (solo `Origin`/`Referer` y cabeceras estándar del navegador).
- El manifiesto se sirve con `cache-control: max-age=3` (debe revalidarse con frecuencia); los segmentos con `max-age=18000` (inmutables).

### 5.4 Consola y errores

- 2 errores `Failed to load resource: … 404` en la página de reproducción (recursos no identificados; no afectaron a la media). Los `status` de red observados: 106×200, 15×302, 5×204, 1×404.
- Publicidad de terceros presente (`googlesyndication`, `fundingchoicesmessages.google.com`), que consume parte del presupuesto de eventos.

### 5.5 Límites de la captura

- Captura declarada `incomplete` por presupuesto de eventos de red (200 transacciones) y por truncado del stream de eventos. Se conservaron 127 transacciones y **10 peticiones de media** (2 manifiestos + 8 peticiones incluyendo recargas y 5 segmentos únicos).
- No se observó el final de la reproducción, ni cambios de pista de audio/subtítulos, ni seek en DVR.
- La media se reprodujo en Chromium headless: no se midió audio real, DRM, calidad percibida ni comportamiento en Safari/iOS.

## 6. Arquitectura de la aplicación del reproductor (`analyze_web_bundle`)

Ejecutado sobre una página viva servida por un Chrome propio (`--remote-debugging-port=9333`, perfil temporal) en `https://player.tdtchannels.com/television/La1`.

- **Resultado:** `completeness.status = partial`; el análisis fue **cancelado** por el plazo del cliente MCP (dos intentos; el registro retenido es el segundo).
- **Scripts observados:** 21; **parseados completos:** 3; **cancelado:** 1; **no iniciados:** 17. `parse_failures: 0`; 157.496 nodos AST visitados.
- **Huella de proveedor:** `Next.js` (2 inferencias de alta confianza).
- **Chunks con análisis completo:** script inline de 742 B, runtime `turbopack-0r79is3dgv9y3.js` (10.618 B) y un chunk grande `0awcil1mo072s.js` (512.196 B, SHA-256 `d94e039e…3073`).
- **Candidatos de endpoint:** 10, todos de **baja confianza** y compatibles con propiedades de pistas de subtítulos/rango (`Content-Range`, `Content-Length`, `region`, `vertical`, `line`, `snapToLines`, `size`, `align`, `position`), no con una API de negocio.
- **Rutas estáticas:** inventario vacío (`routes: 0`, `occurrences: 0`); cobertura de rutas `partial`. No se puede concluir el conjunto de rutas de la app.
- **WebMCP:** 0 declaraciones. **Source maps:** no solicitados/ninguno observado.
- **Desconocidos declarados:** 3 (18 scripts sin analizar; proyección de referencias ampliada en el chunk de 512 KB).

La app es, por tanto, una aplicación **Next.js/Turbopack** con un chunk grande específico de reproducción; el análisis de los chunks del reproductor (p. ej. `069dksvj11.qn.js`, `03~yq9q893hmn.js`) **quedó pendiente** por cancelación y debe repetirse con más plazo si se necesita detalle de módulos.

## 7. DASH: intentos y resultado

No se obtuvo ningún manifiesto `.mpd` en esta tarea. Intentos, todos sobre páginas públicas:

1. **Bitmovin demo DASH** (`https://bitmovin.com/demos/dash`): la página quedó en un **reto Cloudflare Turnstile** (respuestas 403/503, `challenges.cloudflare.com`), sin reproductor ni media. **No se intentó resolver ni evadir el reto.**
2. **Shaka Player demo** (`shaka-player-demo.appspot.com/demo/`): redirige a `shaka-project.github.io/shaka-player-release/demo/#build=uncompiled`; el build sin compilar falla con `TypeError: shaka.util.CmsdManager is not a constructor` y no carga asset.
3. **Shaka demo compilado** (`#build=compiled`): la UI arranca y pide `app_manifest.json` (lista de assets), pero las respuestas asociadas son **503** y no se solicitó ningún `.mpd`; 26 mensajes de consola, ninguno de reproducción.
4. **DASH-IF Reference Client** (`reference.dashif.org/dash.js/latest/...`): se inspeccionó el HTML servido; el cliente **no autocargan** stream (requiere elegir “Streams”/“Load”). La interacción con “Auto Load” + “Load” agotó el plazo del cliente MCP y no produjo evidencia utilizable.

**Conclusión:** la compatibilidad DASH queda **no observada** en este hito; cualquier afirmación sobre DASH en el informe debe marcarse como inferencia de plataforma, no como medición.

## 8. Compatibilidad HTML5 / HLS / DASH

### Observado

- Chromium 157 headless reproduce **HLS en claro sobre MPEG-TS mediante MSE** y una librería JS: pide `.m3u8` por XHR, resuelve URI absolutas y descarga `.ts` con `content-type: video/mp2t`; no hay `#EXT-X-KEY` (sin cifrado en el manifiesto).
- El propio boot de Shaka registró capacidades del navegador: *“Using native MSE as-is”*, *“MediaCapabilities: Native mediaCapabilities support found”*, *“Using native ARIAMixin interface”*, *“Device: Chrome v157; Type: DESKTOP”*. Es evidencia de soporte MSE/MediaCapabilities en el Chromium usado, no de reproducción DASH.
- CORS amplio (`*`) en CDN de RTVE; sin cookies ni tokens; `Range`/`Accept-Ranges` disponibles en segmentos.
- El chunk de 512 KB analizado contiene literales de control de pistas de subtítulos y de rango (`Content-Range`), coherentes con una librería HLS/MSE, aunque **su identidad exacta (hls.js u otra) no quedó probada**.

### Inferido (no medido aquí)

| Plataforma | HLS (TS claro) | DASH | Base de la inferencia |
|---|---|---|---|
| Chrome / Edge (Chromium) | Sí, con MSE + librería (observado en Chrome 157) | Requiere MSE + dash.js/Shaka | Comportamiento estándar de Chromium; DASH no es nativo |
| Firefox | Sí, con MSE + librería | MSE + dash.js/Shaka | Motor Gecko con MSE |
| Safari macOS | **Nativo** (`video.canPlayType('application/vnd.apple.mpegurl')`), también MSE + hls.js | MSE + dash.js/Shaka; no nativo | Soporte nativo HLS de WebKit |
| iOS Safari | **Nativo**; MSE no disponible en iPhone (ManagedMediaSource desde iOS 17.1) | No viable de forma general | Limitación histórica de MSE en iOS |
| Android Chrome | MSE + librería | MSE + dash.js/Shaka | Chromium móvil |

**Riesgo principal para tdt-api01:** si el proxy de reproducción añade autenticación por cabecera o elimina CORS/content-type, rompe tanto la ruta MSE como la nativa de Safari. Si se sirve HLS a Safari sin `Content-Type: application/vnd.apple.mpegurl`, la ruta nativa falla.

## 9. Implicaciones para el proxy/reproductor de TDT-API-01

Recomendaciones derivadas de lo observado (a validar en implementación, fuera del alcance 02A):

1. **No reescribir el manifiesto** salvo necesidad: las URI son absolutas; si se proxifican, resolverlas contra la URI base (RFC 8216) y conservar los grupos `EXT-X-MEDIA` de audio y subtítulos.
2. **Conservar cabeceras**: `Content-Type` exacto (`application/vnd.apple.mpegurl`, `video/mp2t`), `Access-Control-Allow-Origin`, `Accept-Ranges`/`Range`, `ETag`/`Last-Modified`, `Cache-Control` (manifiesto ~3 s; segmentos ~5 h).
3. **Presupuesto de datos**: variante de 135 KB sin comprimir (~7,9 KB gzip) cada ~5 s por cliente; 1.440 segmentos de DVR. Comprimir y no cachear el manifiesto más allá del `TARGETDURATION`. El DVR de 2 h permite *seek*, pero exige recargar el manifiesto y respetar `MEDIA-SEQUENCE`.
4. **Audio/subtítulos**: exponer 3 pistas de audio (incluida accesibilidad `ads`) y 6 de subtítulos; son manifiestos separados. Un proxy que solo reescriba la variante de vídeo pierde estas pistas.
5. **Compatibilidad nativa**: para Safari/iOS, evitar auth por cabecera en la URL de media; preferir cookies de mismo origen o tokens en query solo si el reproductor nativo los admite.
6. **Diagnóstico**: los 404 de terceros (publicidad/Analytics) no deben tratarse como fallo de reproducción; conviene separar dominios de media (`rtvelivestream.rtve.es`) del resto.
7. **DASH**: no prometer compatibilidad DASH en 02A; no hay evidencia observada y el catálogo analizado (La 1) es HLS/TS.

## 10. Incertidumbres y lo que no se pudo observar

- **DASH real**: sin `.mpd` por bloqueos de terceros (Turnstile) y fallos de las demos; no evaluado.
- **DRM/cifrado**: no se observó `EXT-X-KEY`, pero no se probaron canales de pago ni Widevine/PlayReady/FairPlay.
- **Geobloqueo**: la captura se hizo desde España; no se probó desde otras regiones.
- **Autenticación**: los flujos observados son públicos; no se probaron flujos con login.
- **Safari/iOS/Android**: no medidos; solo inferencia de plataforma.
- **Arquitectura del reproductor**: 18 de 21 scripts sin analizar; rutas estáticas no enumeradas; sin source maps.
- **Ciclo de vida de UI**: sin eventos de play/pause/seek; autoplay headless; sin medición de audio.
- **Otros canales**: solo La 1; la compatibilidad del resto del catálogo (768 canales) no se muestreó.
- **Publicidad**: dominios de Google observados; su impacto en latencia no se midió.
- **Snapshot vs. directo**: el manifiesto era directo con DVR; no se probó VOD.

## 11. Reproducibilidad

Llamadas REA equivalentes (parámetros principales):

```text
rea__binary_session {}                                  # inventario de herramientas y versión
rea__capture_browser_scenario {
  browser: {mode:"launch", executable_path:"C:/Program Files/Google/Chrome/Application/chrome.exe", headless:true},
  start_url: {url:"https://player.tdtchannels.com/television/La1"},
  actions: [{step_id:"settle", action:"wait_for_timeout", duration_ms:12000}],
  capture: {at_end:["screenshot","url","storage"], events:["console","page-errors","network"],
            network:{request_body:false,response_body:true,header_values:true},
            limits:{max_events:30000,max_total_event_allocation_bytes:67108864,max_network_transactions:200,
                    max_network_body_bytes:200000,max_network_body_allocation_bytes:16777216,
                    max_network_header_allocation_bytes:8388608,max_network_metadata_allocation_bytes:8388608}},
  command_timeout_ms:30000 }
# Chrome propio para CDP + bundle:
chrome --headless=new --remote-debugging-port=9333 --user-data-dir=%TEMP%\rea-cdp-profile-tdt02a https://player.tdtchannels.com/television/La1
rea__list_browser_targets {cdp_endpoint:"http://127.0.0.1:9333"}
rea__analyze_web_bundle {cdp_endpoint:"http://127.0.0.1:9333", target_id:"E29060DF9E4F5C669F4DD4A31C472B42",
  allowed_origins:["https://player.tdtchannels.com"], detail:"summary",
  view:{kind:"javascript-routes",collection:"summary"}, include_script_sources:true,
  fetch_source_maps:false, observation_ms:2000, command_timeout_ms:60000,
  analysis_timeout_ms:90000, total_analysis_timeout_ms:300000, max_heap_mb:2048}
rea__export_evidence_bundle {path:"…/evidence/rea/sesion-rea-bundle.json", overwrite:true}
```

Notas de reproducibilidad: las URLs de RTVE incluyen marca temporal y número de secuencia; una repetición obtendrá manifiestos y segmentos distintos. Los dominios y el esquema (`master` → `variante` → `.ts` cada 5 s) son estables.

## 12. Cumplimiento, derechos y privacidad

- Solo se accedió a páginas públicas y a medios públicos en abierto; no se eludió ningún control de acceso.
- El reto Cloudflare de Bitmovin se documentó como bloqueo y **no se intentó resolver**.
- No se usaron credenciales ni cookies de usuario; el perfil de Chrome fue temporal.
- Se observó publicidad de terceros (Google AdSense/Funding Choices); no se interactuó con ella.
- Los manifiestos y segmentos pertenecen a RTVE/TDTChannels; este informe no los redistribuye, solo cita URLs y metadatos. El bundle de evidencia incluye cuerpos de respuesta capturados con fines de auditoría interna.

## Anexo — Archivos de evidencia

| Archivo | Contenido |
|---|---|
| `INFORME-REA-REPRODUCCION.md` | Este informe |
| `REA-EVIDENCIA.json` | Índice de evidencias, capacidades, hallazgos e incertidumbres |
| `evidence/rea/sesion-rea-records.json` | Registros REA completos seleccionados (capturas principales, bundle, targets), con procedencia y SHA-256 del bundle original |
| `evidence/rea/capturas-resumen.json` | Resumen factual extraído: transacciones, manifiestos, cabeceras, consola, playlists y análisis estático |
