# Informe de análisis de catálogo, M3U y repositorios

> **AVISO (2026-11-16): las conclusiones normativas de este informe sobre licencias estan
> REEMPLAZADAS por el modo demo (D-016).** Las licencias se registran como procedencia y no bloquean
> nada; Free-TV se incluye y se puede publicar. Ver `VIGENCIA-LICENCIAS-MODO-DEMO.md`.

**Milestone:** TDT-API-02A · **Tarea:** t3 (catálogo/M3U/repositorios)
**Autor:** catalogue · **Worktree:** `wt/tdt02a-cat` (branch `feat/tdt02a-cat`, base `febbec4`)
**Alcance:** análisis de compatibilidad entre el modelo propio (tdt-api01) y tres fuentes de
catálogo — TDTChannels (local), iptv-org/iptv (upstream) y Free-TV/IPTV (upstream) — con foco en
formato de playlists/M3U, campos, licencias y derechos.

> Método: no se ha cargado ninguna playlist completa ni árbol de repositorios en contexto. Las
> cifras proceden de scripts Node deterministas con muestreo acotado sobre los activos locales, y
> de consultas web acotadas a `README.md`, `CONTRIBUTING.md`, `LICENSE` y la API pública de GitHub.
> Los URLs citados son datos externos no ejecutados.

---

## 1. Resumen ejecutivo

1. **El producto ya integra TDTChannels.** tdt-api01 importa el catálogo de referencia
   (`apps/backend/src/jobs/catalogue-import.ts`), normaliza sus *tags* de comportamiento
   (`planSources`) y su EPG JSON (`apps/backend/src/modules/epg/epg.parsers.ts`), y bloquea los
   hosts de TDTChannels en el egress para garantizar independencia operativa. Este informe **no
   propone reemplazar** esa integración, sino documentarla y preparar la incorporación compatible
   de las dos fuentes globales.

2. **Tres licencias distintas, tres riesgos distintos.** TDTChannels declara **Apache-2.0** (sobre
   el contenido del repositorio) **más** un aviso legal que separa el listado del stream;
   iptv-org/iptv declara **Unlicense** (dominio público; su README muestra un badge CC0, a
   conciliar con el texto `LICENSE`); Free-TV/IPTV **no declara licencia alguna** (`license: null`
   en la API de GitHub). La distinción crítica — *licencia del repositorio* ≠ *permiso para
   redistribuir el stream* — se desarrolla en §7.

3. **Hallazgo de compatibilidad que 02B debe resolver:** el campo interno `country` usa `ES` o
   `INT`, pero el contrato público (`countryCodeSchema`) exige `^[A-Z]{2}$`. Al importar
   iptv-org/Free-TV (que traen códigos ISO reales) hay que decidir el valor canónico para el
   agregado internacional (ver Plan, §3.1 y §6).

4. **Free-TV/IPTV queda bloqueado para importación** por ausencia de licencia (§6.3, §7.4).

---

## 2. Inventario de activos locales (solo lectura)

| Activo | Tamaño | Contenido (muestreado) |
| --- | --- | --- |
| `reference/data/tv.json` | 515 KB | Catálogo TDTChannels TV. Objeto `{license, epg, countries[], updated}`; `countries[] → ambits[] → channels[]`. |
| `reference/data/TV.epg.json` | 3,9 MB | Array de 185 entradas `{name, events[{hi,hf,t,d,g,c}]}` (tiempos en epoch seconds). |
| `reference/data/hls-probe.json` | 2,9 KB | 573 sondeos `{channel,url,status,contentType,cors,isManifest,preview}`. |
| `reference/TDTChannels/` | — | Repo TDTChannels: `TELEVISION.md`, `RADIO.md`, `CONTRIBUTING.md`, `MENTIONS.md`, `AUTHORS.md`, `LICENSE` (Apache-2.0), `AGENTS.md`, `scripts/pr_review`, `.github/workflows/catalog-validation.yml`. |

### 2.1 `tv.json` — estadísticas deterministas (muestreo acotado)

```
countries: Spain, International
totalChannels: 768   totalOptions: 855   channelsConOpcionesVacias: 109
conEpgId: 219   conLogo: 768   conWeb: 768
formatos de opción:   m3u8=573  youtube=215  stream=67
tags extra_info:      GEO=44  EXTA=102  EMB=232  NOEM=7  EVT=130  EXTB=23
                      REF=7  REG=24  UAG=24  UAGB=5  NONAV=24  REFI1=19  REFC1=2
updated (epoch): 1793918983
```

Interpretación:

- `m3u8` (573) coincide con los 573 sondeos de `hls-probe.json` → la cobertura de verificación
  HLS es total para las opciones `m3u8`.
- `youtube` (215) son canales de YouTube (reproductor oficial) → `engine: youtube-iframe`.
- `stream` (67) son enlaces oficiales "otros" que la plataforma debe tratar caso a caso
  (efectivamente `hls` si la URL es un `.m3u8`, o `official-embed` si es página de reproductor).
- 109 canales con `options: []` existen solo como referencia externa (link-out al `web` oficial).

### 2.2 `TV.epg.json` — estructura

Entrada `{ "name": "La1.TV", "events": [ { "hi": epoch, "hf": epoch, "t": título, "d": descripción,
"g": género, "c": coverUrl } ] }`. La clave de join es `name` (= `epg_id` del catálogo). Los
géneros `g` vienen en mayúsculas inglesas (`NEWS`, `SPORTS`, …). Las descripciones `d` y las
carátulas `c` apuntan a proveedores de EPG de terceros (p. ej. `movistarplus.es/recorte/…`) → son
prosa/datos de terceros, no editoriales nuestros.

### 2.3 `hls-probe.json` — estructura

`{probedAt, total, results[{channel,url,status,contentType,cors,isManifest,preview}]}`. Aporta
evidencia de salud técnica y de `cors` (observado: `*`, `http://localhost:4200`, y ausente) →
insumo para `technicalStatus` y para `conditions.browserCompatibility`.

---

## 3. Análisis de TDTChannels (local)

### 3.1 Organización del repositorio

- Catálogo humano en `TELEVISION.md` / `RADIO.md` (tablas Markdown); generación de listas M3U/M3U8/
  MPD/Enigma2 y JSON servidas desde `tdtchannels.com` (no versionadas en el repo).
- Validación de PR vía `scripts/pr_review` y `.github/workflows/catalog-validation.yml`.
- `AGENTS.md` local fija el marco legal del repo: solo enlaces oficiales, sin restreams/mirrors,
  sin elusión de DRM/geobloqueo, sin tokens/cookies.

### 3.2 Formato del catálogo `tv.json`

Cada canal tiene: `name`, `web`, `logo`, `epg_id`, `options[]` (cada una con `format`, `url`,
`geo2`, `res`, `lang`) y `extra_info[]`. El contexto jerárquico (`country.name`, `ambit.name`)
proporciona país y categoría/región.

### 3.3 Semántica de `extra_info` (columna `Info` de `CONTRIBUTING.md`)

| Tag | Significado declarado | Implicación en nuestro modelo |
| --- | --- | --- |
| `GEO` | Bloqueo regional/territorial | `conditions.worldwide=false`, `restrictedRegions`; descriptor `geoRestricted`. |
| `NOEM` | Sin emisión online (solo indexación/EPG) | `kind=guide-only` (o sin fuente publicable). |
| `REG` | Requiere registro gratuito | No publicable sin decisión editorial (`unlicensed`/`official-player-only`). |
| `EXTA` | Buscar emisión oficial desde `web` | Fuente `external` (link-out), no embebida. |
| `EXTB` | Buscar emisión oficial desde `M3U8` | Tratamiento de enlace indirecto (verificar antes). |
| `EMB` | Emisión embebida desde plataforma oficial (YouTube/Twitch) | `platform-embed`, `engine youtube-iframe`/`official-embed`. |
| `UAG` / `UAGB` | Requiere User-Agent de navegador | `conditions.emitterAppOnly=true` → **nunca publicado** (`emitter-app-only`). |
| `REF` / `REFI1` / `REFG1` / `REFC1` | Requiere Referer | `conditions.requiresForgedHeader=true` → **nunca publicado** (`requires-forged-header`). |
| `EVT` | Emisión intermitente/eventual | `kind=eventual`, `playbackStatus=eventual`. |
| `NONAV` | No funciona bien en navegadores | `conditions.browserCompatibility` ≠ `all`. |

### 3.4 Semántica de `options[].format`

| format | Significado | Tipo/engine nuestro |
| --- | --- | --- |
| `m3u8` | HLS (master/playlist) | `hls` |
| `mpd` | DASH | `dash` |
| `youtube` | Canal/emisión en YouTube | `youtube` → `youtube-iframe` |
| `stream` | Otros embebidos oficiales | `hls` si `.m3u8`, si no `official-embed` |

La regla real del importador (`effectiveSourceType`) no confía en el `format` declarado: la
**dirección decide** (`.m3u8`→hls, `.mpd`→dash, host YouTube→youtube, hosts Twitch/Dailymotion/
Vimeo→official-embed). Esta decisión ya está audita y es la referencia para 02B.

### 3.5 Licencia de TDTChannels

- **Repositorio:** Apache-2.0 (`LICENSE`), aplicable "al contenido publicado en este repositorio".
- **Aviso legal adicional** (`README.md`, §Legal): el acceso a los JSON/M3U/EPG alojados en
  `tdtchannels.com` está sujeto además a las condiciones del [aviso legal](https://www.tdtchannels.com/avisolegal).
- **Sobre el stream:** TDTChannels no almacena, emite ni retransmite señal alguna; solo recopila
  enlaces publicados oficialmente. Los derechos de emisión son del operador.

**Conclusión de derechos:** importar y transformar la **lista de canales + metadatos + EPG** es
compatible con Apache-2.0 (con atribución "Datos de referencia: proyecto TDTChannels (Apache-2.0)").
Eso **no** autoriza a redistribuir/embebido/proxy del **stream**: cada señal exige el permiso de su
emisor, que es exactamente el modelo de permisos del producto (`emitters.ts` + `permission`).

---

## 4. Análisis de iptv-org/iptv (upstream)

Fuentes: [README](https://github.com/iptv-org/iptv), [CONTRIBUTING.md](https://github.com/iptv-org/iptv/blob/master/CONTRIBUTING.md),
[API GitHub](https://api.github.com/repos/iptv-org/iptv).

### 4.1 Organización del ecosistema (multi-repo)

| Repo | Rol |
| --- | --- |
| `iptv-org/iptv` | Listas de streams (`streams/*.m3u`), `PLAYLISTS.md`, scripts y docs. |
| `iptv-org/database` | Datos maestros del canal (nombre, categorías, idiomas, área, logo). |
| `iptv-org/epg` | Guía de programación (EPG). |
| `iptv-org/api` | API. |

Dato clave: en el playlist **solo vive el stream-id**; el resto de la descripción (nombre,
categoría, idioma, área, logo) se carga desde `iptv-org/database` usando ese id. Por tanto,
importar iptv-org de forma completa requiere **dos artefactos**: el M3U (streams) y el snapshot de
`database` (metadatos).

### 4.2 Formato de playlist / campos M3U

- Playlist principal: `https://iptv-org.github.io/iptv/index.m3u`; listas por país/categoría en
  `PLAYLISTS.md`.
- Línea tipo (a confirmar contra snapshot en el contrato): atributos `tvg-id` (stream/channel id →
  join con `database`), `tvg-logo`, `group-title`, y según playlist `tvg-name`, `tvg-country`,
  `tvg-language`, `tvg-shift`.
- Directivas de cabecera por stream: `#EXTVLCOPT:http-user-agent=…` y `#EXTVLCOPT:http-referrer=…`
  → en nuestro modelo son `requiresForgedHeader=true` (no forjamos cabeceras) → fuente retenida,
  no publicada.
- Restricciones autoimpuestas por el proyecto (`CONTRIBUTING.md`): no acepta enlaces tokenizados,
  ni servidores Xtream Codes, ni enlaces con geobloqueo no declarado, y mantiene un *blocklist*
  (`iptv-org/database/data/blocklist.csv`).

### 4.3 Licencia de iptv-org/iptv

- La API de GitHub reporta **`Unlicense`** (dominio público).
- El `README.md` muestra un badge **CC0**. → **Riesgo a conciliar:** el texto real del archivo
  `LICENSE` manda; verificar en el momento de importar y registrar el SPDX correcto en
  `provenance.licence`. Ambas son de dominio público, sin copyleft ni atribución obligatoria, pero
  el identificador debe ser exacto.

### 4.4 Derechos sobre el stream

Igual que TDTChannels: el repositorio es una colección de **enlaces enviados por usuarios** sin
control sobre el destino; "linking no infringe directamente copyright porque no se hace copia". El
dominio público cubre **el listado**, no **la señal**. Cada stream sigue exigiendo permiso de su
emisor antes de publicarse (el allowlist `emitters.ts` + `permission` sigue aplicando).

---

## 5. Análisis de Free-TV/IPTV (upstream)

Fuentes: [README](https://github.com/Free-TV/IPTV), [API GitHub](https://api.github.com/repos/Free-TV/IPTV).

### 5.1 Organización

- `lists/*.md` (uno por país), generación del playlist con `make_playlist.py`, salida
  `playlist.m3u8` (URL: `https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8`).
- Cada `.md` = un grupo (el `<h1>` es el título del grupo).
- Solo se incluyen canales cuya columna URL empieza por `[>]`; `[x]()` = sin stream válido
  (categoría "Invalid").
- Marcadores: `Ⓢ` (no HD), `Ⓖ` (GeoIP), `Ⓨ` (canal YouTube en vivo).
- Filosofía: calidad sobre cantidad, solo canales gratuitos, mainstream (sin adultos, sin
  dedicación religiosa/partidista, sin canales financiados por otro país).

### 5.2 Licencia de Free-TV/IPTV

- **No hay archivo `LICENSE`** (`raw.githubusercontent.com/.../LICENSE` → 404) y la API de GitHub
  reporta **`license: null`**.

**Conclusión:** sin licencia declarada no existe base legal clara para copiar, transformar o
redistribuir ni el listado ni los enlaces. **Free-TV/IPTV queda excluido de cualquier importación**
hasta obtener permiso explícito por escrito del propietario (señalarlo en el plan como bloqueado).

---

## 6. Tabla comparativa de los tres catálogos

| Dimensión | TDTChannels | iptv-org/iptv | Free-TV/IPTV |
| --- | --- | --- | --- |
| Ámbito | España + internacionales seleccionados | Mundial | Mundial (mainstream) |
| Licencia repo | Apache-2.0 (+ aviso legal) | Unlicense (badge CC0 a conciliar) | **Ninguna** |
| Formato fuente | JSON (`tv.json`) + MD (`TELEVISION.md`) | M3U (`streams/*.m3u`) + DB separada | MD (`lists/*.md`) → M3U8 generado |
| Identidad canal | `name` + `epg_id` | `tvg-id` → `database` | nombre + grupo (`<h1>`) |
| Metadatos | `web`, `logo`, `epg_id`, `extra_info[]`, `options[]` | `tvg-logo`, `group-title`, `tvg-country/language`, cabeceras VLC | `Ⓢ/Ⓖ/Ⓨ`, `[>]/[x]` |
| Geo | `extra_info GEO` + `options.geo2` | `tvg-country` / doc geo-blocking | `Ⓖ` |
| EPG | `TV.epg.json` (join por `epg_id`) | `iptv-org/epg` (join por `tvg-id`) | no propio |
| Cabeceras requeridas | `UAG*`, `REF*` | `#EXTVLCOPT http-user-agent/referrer` | no documentado |
| Estado integración | **Integrado** (tdt-api01) | Candidato 02B | **Bloqueado (sin licencia)** |

---

## 7. Derechos y licencias: distinción crítica

La distinción que el plan debe preservar en todo momento es:

> **A. Licencia del repositorio/lista** (los *metadatos*: nombre, categoría, país, logo-URL,
> enlaces) — determina si podemos **copiar, transformar e indexar** el catálogo.
>
> **B. Permiso para redistribuir el stream** (la *señal audiovisual*) — determina si podemos
> **enlazar/embebir** la emisión, y nunca autoriza proxy/transcodificación (que el producto no hace).

Por fuente:

| Fuente | A (lista) | B (stream) |
| --- | --- | --- |
| TDTChannels | Apache-2.0, con atribución | Por emisor (`emitters.ts` + `permission`); aviso legal declina responsabilidad |
| iptv-org | Dominio público | Por emisor; sin control sobre el destino; blocklist propia |
| Free-TV | **Sin licencia → no importable** | n/a |

Reglas que el producto ya aplica y que 02B debe conservar (ver
`docs/PROVENANCE-AND-LICENCES.md`):

1. Ninguna fuente pública sin `permission` registrada (`unlicensed` → nunca publicada).
2. Ninguna fuente que exija forjar cabeceras (`requiresForgedHeader` / `emitterAppOnly`).
3. Nunca proxy/transcodificar; el navegador reproduce la dirección del emisor.
4. Nunca copiar prosa editorial de terceros (descripciones de canal vacías; las descripciones de
   programa se sirven con atribución de la guía).

---

## 8. Hallazgos y riesgos (resumen)

| # | Hallazgo | Severidad | Acción |
| --- | --- | --- | --- |
| H1 | `country='INT'` no cumple el contrato público `^[A-Z]{2}$` | alta | Decidir valor canónico para internacional en 02B (Plan §3.1). |
| H2 | iptv-org: discrepancia badge CC0 vs API `Unlicense` | media | Leer `LICENSE` exacto al importar y registrar SPDX correcto. |
| H3 | Free-TV sin licencia (`license: null`) | bloqueante | Excluir de importación; solo permiso escrito. |
| H4 | Logos de TDTChannels son URLs de terceros (`graph.facebook.com/…`) | media | `branding.logoSrcPermission` no debe asumir `open-data`; revisar por emisor. |
| H5 | Descriptores de EPG (`d`) y carátulas (`c`) son de terceros | media | Servir con atribución de la guía; retirar si los términos lo exigen. |
| H6 | `stream`/`youtube`/cabeceras requieren verificación caso a caso | baja | Mantener `effectiveSourceType` y retención por cabeceras. |
