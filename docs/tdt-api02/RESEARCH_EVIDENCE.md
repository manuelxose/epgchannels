# RESEARCH_EVIDENCE — TDT-API-02

Evidencia de investigación del programa. Cada entrada tiene: **afirmación**, **método**,
**evidencia**, **confianza** y, cuando aplica, **lo que no se pudo verificar**.

Regla de este documento: una afirmación sin evidencia citable no se escribe aquí. Las
incertidumbres se declaran, no se ocultan.

Base del repositorio: `main` @ `febbec464763ffd5812f5b80bf3f6901774dde65` (`febbec4`).
Milestone: **02A** · 2026-11-16.

---

## E-01 · Línea base ejecutable (verificada por el capitán)

| Campo | Valor |
|---|---|
| Afirmación | La línea base compila, tipa y pasa todas las suites declaradas |
| Método | Ejecución real de `qa/qa-manifest.json` en el worktree `tdt02a-base` |
| Tipo de cambio | `build` **antes** de `typecheck` (dependencia real de declaraciones) |
| Confianza | Alta — exit codes reales |

Resultados medidos en el tree de integración (`tdt02a-base`, base `febbec4`):

| Etapa | Exit | Resultado observado |
|---|---|---|
| `build` | 0 | `tsc` de contracts, api-client y backend |
| `typecheck` | 0 | Los tres workspaces tipan sin errores (en frío **falla**, ver D-007) |
| `unit` | 0 | 5 ficheros, **67 tests** |
| `integration` | 0 | 6 ficheros, **102 tests** |
| `independence` | 0 | 1 fichero, **15 tests** |
| `client` | 0 | 1 fichero, **14 tests** |

Comprobación adicional en el checkout principal antes de crear la rama: `npm run test` →
12 ficheros / 184 tests + 1 fichero / 14 tests, todo en verde (28,4 s y 1,3 s).

**Reconciliación honesta:** un recuento intermedio por coincidencia de texto en la salida sugirió
"14" y "16" tests de independencia. Verificado por ejecución con reporter `verbose`: son **15**
casos, los **15 declarados** en la spec, todos en verde. La discrepancia era del patrón de conteo,
no una brecha de cobertura. No se registra como incidencia.

---

## E-02 · Hallazgos de arquitectura (re-verificados por el capitán)

Confirmados leyendo el código real, no aceptados por relato:

| ID | Afirmación | Evidencia verificada |
|---|---|---|
| R1 / SEC-11 | Ternario muerto en el guard de egress | `server/bootstrap.ts:38` — ambas ramas del ternario son idénticas |
| R2 | `playable=true` hace full scan en memoria | `channels.service.ts:214` `find().toArray()` + `:216` `.filter(...)` sobre todo el catálogo |
| R3 | No hay CI/CD | no existe `.github/`; el único YAML es `infra/docker-compose.yml` |
| R7 / SEC-01 | Sin filtro de rangos privados en egress | `infrastructure/egress.ts` no contiene `private`/`loopback`/`127.`/`169.254`/`dns`/`lookup` |
| R12 / SEC-15 | `/health` filtra `error.message` | `routes.ts:144` |

---

## E-03 · Hallazgos de seguridad y licencias (re-verificados por el capitán)

| ID | Severidad | Afirmación | Verificación independiente del capitán |
|---|---|---|---|
| SEC-02 | high | La clave de servicio GuíaTV **no se aplica** | Búsqueda exhaustiva: `secretMatches` aparece en `admin.auth.ts:51` (definición) y solo en `security.unit.spec.ts`. `serviceKeyEnabled` se computa (`bootstrap.ts:41`) y solo **se anuncia** (`routes.ts:317`). No hay middleware que valide `x-api-key` |
| SEC-01 | high | SSRF: sin bloqueo de IP privadas | Mismo grep que R7/SEC-01: ausencia confirmada |
| LIC-01 | high (para publicación) | No hay licencia declarada | No existe `LICENSE*` en el árbol; `README.md:66-69` lo reconoce |

Esto significa que la plataforma **anuncia** una autenticación server-to-server que **no aplica**.
Es el hallazgo más importante de 02A y una condición bloqueante de 02B/publicación.

**Positivo verificado:** no hay redifusión (no existe proxy/relay de medios; se entrega la URL del
emisor). La base de autenticación es sólida (`scrypt` + salt, sesiones opacas con SHA-256 en
reposo, comparación en tiempo constante, bootstrap one-shot).

---

## E-04 · Catálogo y formatos (muestreo determinista, sin cargar datos en contexto)

| Afirmación | Evidencia |
|---|---|
| Activo de referencia: 768 canales, 855 opciones de reproducción | recuento programático sobre `reference/data/tv.json` |
| **Re-medido por el capitán** (estructura real `countries[].ambits[].channels[].options[]`) | **768 canales y 855 opciones** — coincide con el informe de catálogo |
| Reparto por tipo: 573 `m3u8`, 215 `youtube`, 67 `stream`, 109 canales sin opción | idem |
| Guía de referencia: 185 canales con eventos `{hi,hf,t,d,g,c}` | `reference/data/TV.epg.json` |
| Tags de `extra_info`: `GEO`, `EXTA`, `EMB`, `NOEM`, `EVT`, `EXTB`, `REF`, `REG`, `UAG`, `UAGB`, `NONAV` | scripts de TDTChannels |
| TDTChannels: Apache-2.0 + aviso, con scripts de extracción | `reference/TDTChannels/README.md`, `LICENSE` |

**Distinción que gobierna todo el plan:** la licencia del repositorio permite copiar el *listado*;
no autoriza redistribuir la *señal*. El producto no proxya y por tanto no redistribuye señal.

---

## E-05 · Upstreams autorizados

| Repositorio | Licencia observada | Estado para 02B | Incertidumbre |
|---|---|---|---|
| `iptv-org/iptv` | **Unlicense** (API de GitHub) + badge **CC0** en README | candidato **condicionado** (D-004) | las dos declaraciones hay que conciliarlas |
| `Free-TV/IPTV` | **ninguna** (`license:null`, sin `LICENSE`) | **BLOQUEADO** | ninguna: sin licencia no se ingiere |
| `TDTChannels` | Apache-2.0 | integrado como instantánea + atribución | ninguna |

Organización de iptv-org documentada: `streams/*.m3u` (listas por país), `iptv-org/database`
(metadatos), `iptv-org/epg` (guías), unión por `tvg-id`, y cabeceras vía `#EXTVLCOPT`. Free-TV
usa un formato M3U plano por país sin metadatos estructurados.

**Lo que NO se hizo:** no se descargaron playlists completas a disco ni se clonaron repositorios
gigantes. La licencia exacta de los datos de guía de iptv-org no se inspeccionó en 02A.

---

## E-06 · Incompatibilidad de contrato detectada (nueva, verificada)

- **Afirmación:** el código importa `country: 'INT'`, pero el contrato público exige códigos ISO
  de dos letras.
- **Evidencia:** `apps/backend/src/jobs/catalogue-import.ts:226` (`isSpain ? 'ES' : 'INT'`),
  `migration-executor.ts:172`; `packages/contracts/src/common.ts:29-31`
  (`^[A-Z]{2}$`).
- **Matiz importante:** `'INT'` tiene **3** letras y **no** cumple `^[A-Z]{2}$`; el agregado del
  contrato es `INTL` (`routes.ts:296-304`). La incompatibilidad es real y afecta a qué se publica,
  no solo a la validación de entrada.
- **Consecuencia:** decisión pendiente **D-010** para 02B.
- **Confianza:** alta (verificado por lectura directa).

---

## E-07 · REA: instalación e investigación de reproducción

- **Instalación verificada (no se reinstaló nada):** `rea-agents` **6.8.0** servido por MCP
  (`dsh-mcp-client` 0.0.1), protocolo `2026-07-28`; skill `reverse-engineer-anything` **v49**;
  catálogo de **229** herramientas MCP, digest `tools_sha256 a98940ba…`.
- **Proveedores disponibles (observados):** captura de navegador CDP (`capture_browser_scenario`,
  `inspect_web_page`, `capture_web_screenshot`), análisis estático de bundles
  (`analyze_web_bundle`, `export_web_scripts`), captura de red
  (`inspect_web_network_capture`), perfilado de artefactos. **No disponibles en este host:**
  utilidades nativas macOS, `adb` (no instalado), JADX/JEB, WABT, pwnfuzz/sigrok (solo Linux).
- **Carpeta local `rea`:** **no existe** `C:\Users\Admin\Documents\workspace\streaming\rea`. La
  integración es la instalación MCP ya presente (`C:\Users\Admin\AppData\Local\blg\toolchain\…\node_modules\rea-agents`),
  no un checkout local del proyecto `morluto/rea`. Por tanto no se inspeccionó código fuente de REA:
  solo su superficie instalada (versión, catálogo de herramientas, capacidad de proveedores).
- **Hallazgo relevante para el producto:** las herramientas de navegador de REA son aplicables a
  reproductores web públicos (HLS/DASH/HTML5) y permiten observar el ciclo de vida de carga y las
  peticiones de media — justo lo que 02B necesita para el modelo de reproducción.

**Resultados de captura:** ver `REA-EVIDENCIA.json` y el informe
[`INFORME-REA-REPRODUCCION.md`](INFORME-REA-REPRODUCCION.md). Ninguna captura implicó evasión de
DRM, geobloqueo, autenticación o restricciones de acceso.

### E-07.1 · HLS observado (verificado por captura REA)

| Afirmación | Evidencia |
|---|---|
| El flujo público de `player.tdtchannels.com/television/La1` sirve **HLS sobre MPEG-TS en claro** | `capture_browser_scenario` (`ev_51df…`): manifiesto maestro 2 118 B + variante 135 498 B + 5 segmentos `video/mp2t` de 1,0–2,7 MB, HTTP 200 |
| El maestro declara **3 pistas de audio** (incl. accesibilidad) y **6 de subtítulos**, con 1 variante 1280×720 (`avc1.640029`/`mp4a.40.2`) | manifiesto capturado |
| Hay **DVR ≈ 2 h** (1 440 segmentos de 5 s) y el manifiesto se revalida ≈ cada 3 s | variante capturada + 3 recargas en 12 s |
| **No** se observa `EXT-X-KEY`, cookies ni tokens; CORS `*` | cabeceras capturadas |
| La reproducción se sirve por **MSE + librería JS** (Chrome no reproduce HLS nativo), con `Origin`/`Referer` del reproductor | XHR capturados |

- **Confianza:** alta para lo observado; la captura se detuvo por presupuesto en 127/200
  transacciones, así que es **parcial**, no exhaustiva.
- **Implicación de producto:** si algún día se proxificara media (hoy **no** se hace, D-003), un
  reescritor de manifiestos que solo toque la variante de vídeo **perdería** las pistas de audio y
  subtítulos. Es una advertencia de diseño, no una recomendación de implementarlo.

### E-07.2 · DASH **no** verificado

Intentos: demo Bitmovin bloqueada por **Cloudflare Turnstile** y demos Shaka con errores
(`CmsdManager`, y la variante compilada no solicita ningún `.mpd`, respuestas 503).

- **Conclusión honesta:** **no hay evidencia observada de DASH** en 02A. No se debe tratar DASH como
  compatibilidad verificada, y el catálogo analizado es HLS/TS.
- **No se evadió** el reto anti-bot: habría sido una violación del contrato. La incertidumbre se
  declara en lugar de disimularse.

### E-07.3 · Arquitectura del reproductor (parcial)

`analyze_web_bundle` se canceló por plazo del cliente MCP tras 157 496 nodos AST: **Next.js
(App Router/Turbopack)** confirmado, 21 scripts observados, 3 parseados, **18 sin analizar** y sin
enumeración de rutas. Una arquitectura de aplicación **no** queda caracterizada con eso, y así se
reporta.

**Nota de evidencia:** el bundle completo exportado por REA (24 MB) contenía registros de otros
miembros del equipo, por lo que **no** se archivó; se conservó una copia filtrada con el SHA-256 del
original. Los registros crudos de 4,17 MB no se incluyen en el repositorio (volumen desproporcionado
para documentación); se conservan `capturas-resumen.json` (41 KB) y este resumen factual. La
reproducción exacta de las capturas está documentada en `INFORME-REA-REPRODUCCION §11`.

---

## E-08 · Lo que este documento NO verifica (declaración explícita)

- Comportamiento en runtime de producción (solo se ejecutó localmente contra MongoDB/Redis locales).
- Restricciones reales en un despliegue (claves de YouTube, auth de Mongo/Redis, reverse proxy).
- Licencia exacta de los datos de guía de iptv-org.
- Rendimiento bajo carga real: existe `test:load`, **no** se ejecutó en 02A.
- Los E2E Playwright no se ejecutaron en 02A (no forman parte del gate declarado).
