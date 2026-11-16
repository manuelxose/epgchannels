# Plan de compatibilidad y migración (catálogo/M3U/EPG → modelo existente)

**Milestone:** TDT-API-02A · **Tarea:** t3 · **Autor:** catalogue
**Destino:** prepara la incorporación compatible de fuentes de catálogo (TDTChannels ya integrado;
iptv-org candidato; Free-TV bloqueado) para la fase **02B** (fuera del alcance de implementación de
este milestone).

---

## 1. Objetivo y no-objetivos

**Objetivo.** Definir, campo a campo, cómo se proyectan los catálogos externos sobre el modelo
existente (`ChannelDoc`, `PlaybackSourceDoc`, `ProgrammeDoc`, `EpgSourceDoc`), **sin reemplazar el
producto**: la base de datos, los contratos públicos y la política de publicación siguen siendo los
canónicos; las fuentes externas son solo proveedoras de instantáneas con procedencia.

**No-objetivos.**
- No implementar 02B aquí (solo plan y criterios de aceptación).
- No cambiar el modelo/contratos públicos sin un cambio de contrato aprobado (los mapeos deben
  caber en el modelo actual; cuando no quepan, se registra como hallazgo, no se fuerza).
- No importar Free-TV (sin licencia).
- No relajar la política de publicación (`docs/PROVENANCE-AND-LICENCES.md`).

**Principios no negociables:** fail-closed (sin permiso no se publica), idempotencia (re-ingesta no
duplica), atrás-compatible (una migración nunca rompe un campo ya publicado), procedencia en cada
registro, sin proxy/transcodificación, sin forjar cabeceras.

---

## 2. Estado actual (lo que ya existe y se conserva)

- `apps/backend/src/jobs/catalogue-import.ts` — extrae `ReferenceChannelRecord` desde el snapshot y
  planifica fuentes (`planSources`, `effectiveSourceType`, `categoryForAmbit`).
- `apps/backend/src/jobs/migration-executor.ts` — persiste canales/fuentes con procedencia
  `tdtchannels-snapshot` (Apache-2.0 + atribución).
- `apps/backend/src/modules/epg/epg.parsers.ts` — `parseJsonGuide` (json-tdtchannels) y
  `parseXmltv` (XMLTV).
- `apps/backend/src/modules/providers/emitters.ts` — allowlist de emisores (decisión por host).
- `apps/backend/src/infrastructure/schema.ts` + `packages/contracts/src/*` — modelo y contratos.
- `docs/DATA-MODEL.md`, `docs/PROVENANCE-AND-LICENCES.md` — documentación canónica.

---

## 3. Mapeo campo a campo

Leyenda: `→` mapeo directo; `(derivado)` calculado; `(editorial)` requiere decisión humana;
`—` no existe en la fuente (se deja vacío/por defecto seguro).

### 3.1 Canal — TDTChannels `tv.json` `channel` → `ChannelDoc`

| Fuente (`channel` + contexto) | Destino `ChannelDoc` | Nota |
| --- | --- | --- |
| — (generado) | `_id` | UUID nuestro, nunca identidad externa. |
| `name` (slugificado) | `slug` | `slugSeed=name`; colisiones → sufijo. |
| `name` | `name` | |
| `name` (1er token) *(editorial)* | `shortName` | No hay shortName en la fuente. |
| `country.name` ∈ {Spain, España} | `country` | `ES` si España, si no **ver H1**: hoy `INT` rompe `countryCodeSchema`. |
| `ambit.name` (`resolveRegionCode`) | `region` | Solo para España; `{code,name}` ISO 3166-2:ES. |
| — *(editorial)* | `locality` | |
| `options[].lang` / tags de idioma *(editorial)* | `languageTag` | Default `es`. |
| `ambit.name` (`categoryForAmbit`) | `category` | Taxonomía canónica (generalista…otros). |
| tags `EVT`/`NOEM`/resto | `kind` | `EVT`→eventual, `NOEM`→guide-only, si no linear/online. |
| `web` | `websiteUrl` | |
| — (vacía) | `description` | Nunca copiar prosa de terceros. |
| `logo` + permiso *(editorial)* | `branding.logoSrc` / `logoSrcPermission` | H4: no asumir `open-data`. |
| — (importado) | `editorialStatus` | `review` (revisión editorial) o `published` solo si hay fuente publicable. |
| — *(editorial)* | `timezone` | `Europe/Madrid` por defecto en EPG. |
| snapshot | `provenance[]` | `{source:'tdtchannels-snapshot', licence:'Apache-2.0', attribution, digestSha256, capturedAt, editorial:false}`. |
| `legacyId` / `epg_id` | `aliases[]` | `{namespace:'legacy-tdt', value:'Country/Ambit/Name'}`; `{namespace:'epg', value:epg_id}`. |
| `epg_id` | `epg` | `{sourceId, externalId:epg_id}` cuando hay guía mapeada. |
| derivado | `searchText`, `mergedInto`, timestamps, `revision` | |

### 3.2 Fuente (playback) — TDTChannels `option` → `PlaybackSourceDoc`

| Fuente (`option` + tags + `web`) | Destino `PlaybackSourceDoc` | Nota |
| --- | --- | --- |
| — | `_id`, `channelId` | UUIDs. |
| `emitterFor(url)` | `provider` | `emitter:<host>` o `platform:<host>`. |
| `effectiveSourceType(format, url)` | `type` | `hls`/`dash`/`youtube`/`official-embed`/`external`. |
| `option.url` | `url` | |
| `web` (o `option.url` en plataformas) | `officialPageUrl` | |
| decisión emisor + tags | `permission` | `emitter-public-stream`/`emitter-embeddable`/`official-player-only`/`unlicensed`. |
| — (puntero externo) | `authorisationEvidence` | |
| `geo2` | `conditions.worldwide` / `restrictedRegions` | `geo2`≠null → `worldwide:false`, `restrictedRegions:['ES']`. |
| `platform-embed` | `conditions.embedAllowed` | true solo si plataforma embebible. |
| — (fijo) | `conditions.proxyAllowed` | `false` siempre. |
| tags `REF*` | `conditions.requiresForgedHeader` | → retenida. |
| tags `UAG*` | `conditions.emitterAppOnly` | → retenida. |
| tag `NONAV` | `conditions.browserCompatibility` | ≠ `all`. |
| tipo | `priority` | 100 directo / 200 plataforma / 500 external. |
| publicable | `editorialStatus` | `published` solo si hay permiso; si no `draft`. |
| `hls-probe.json` | `technicalStatus`, `lastVerification` | status/httpStatus/isManifest. |
| procedencia | `provenance[]`, timestamps, `revision` | |

### 3.3 EPG — TDTChannels `TV.epg.json` → `ProgrammeDoc` + `EpgSourceDoc`

| Fuente | Destino | Nota |
| --- | --- | --- |
| — | `EpgSourceDoc.name/kind/url` | `kind:'json-tdtchannels'`, `url:'https://www.tdtchannels.com/epg/TV.json'`. |
| `licence/attribution` | `EpgSourceDoc.licence/attribution` | Apache-2.0 + atribución. |
| `entry.name` | join: `ChannelDoc.epg.externalId` (o alias `epg`) | clave de reconciliación. |
| `event.hi/hf` | `ProgrammeDoc.start/end` | epoch seconds → `Date(ms*1000)`. |
| `event.t` | `title` | |
| `event.d` | `description` | de terceros → con atribución de guía. |
| `event.g` | `genre` | normalizar vocabulario (editorial). |
| `event.c` | `coverUrl` | |
| — | `externalKey` | `${sourceId}|${upstreamChannel}|${start}` (idempotencia). |
| `event.hi` (join + start) | `externalKey`/índice único | `(channelId, externalKey)` único. |

### 3.4 iptv-org → modelo (nueva fuente, 02B)

Se requieren **dos instantáneas**: `streams/*.m3u` (streams) y `iptv-org/database` (metadatos).

| Fuente iptv-org | Destino | Nota |
| --- | --- | --- |
| `tvg-id` | `aliases[{namespace:'iptv-org'}]` + `epg.externalId` | join con `database` y `iptv-org/epg`. |
| `database` nombre | `name` | |
| `database` categorías | `category` | mapeo editorial a taxonomía. |
| `tvg-country` / `database` país | `country` | **ISO real** → resuelve H1. |
| `tvg-logo` | `branding.logoSrc` | permiso por emisor. |
| `group-title` | `category`/`region` | editorial. |
| URL del stream | `PlaybackSourceDoc.url` | con `effectiveSourceType`. |
| `#EXTVLCOPT http-user-agent/referrer` | `conditions.requiresForgedHeader=true` | → retenida, no publicada. |
| `tvg-shift` | timezone/shift del EPG | editorial. |

Licencia del listado: **Unlicense** (dominio público; conciliar badge CC0 → H2). `provenance.licence`
debe registrar el SPDX exacto leído del `LICENSE`. El **stream** sigue sujeto a permiso por emisor.

### 3.5 Free-TV → modelo

**No aplica.** Sin licencia declarada (`license: null`), no se importa lista ni enlaces. Si en el
futuro se obtiene permiso escrito: mapear `group (<h1>)` → categoría, nombre → `name`, URL `[>]` →
`source.url`, `Ⓖ` → geo, `Ⓨ` → `youtube`, `Ⓢ` → calidad (informativo).

---

## 4. Fases

- **F0 — Contratos de instantánea.** Fijar y versionar el esquema de cada instantánea (JSON/M3U)
  con un *fixture* pequeño + hash SHA-256; documentar el `provenance.digestSha256`.
- **F1 — TDTChannels consolidado (estado actual auditado).** Congelar el mapeo actual; añadir
  pruebas de contrato para `tv.json` y `TV.epg.json` que fijen los campos/tags documentados en §3.
- **F2 — Resolver H1 (country).** Decidir el valor canónico para internacional (p. ej. país real
  por canal, o un agregado fuera del enum público con traducción en el adaptador) y añadir
  migración atrás-compatible.
- **F3 — iptv-org (opt-in, no por defecto).** Importador de dos instantáneas (streams + database),
  reutilizando `planSources`/`emitters.ts`; todo canal/stream sin decisión de emisor queda
  `draft`/`unlicensed`.
- **F4 — Contratos de regresión.** Tests de contrato sobre respuestas públicas (canales, fuentes,
  EPG) para garantizar que la incorporación de una fuente no altera los payloads existentes.
- **F5 — Criterios de aceptación 02B** (ver §6) + informe de migración con conteos de
  importados/retenidos/rechazados y sus razones.

---

## 5. Migraciones compatibles hacia atrás

1. **Aditiva y no destructiva.** Toda incorporación añade `provenance`, `aliases` y fuentes; nunca
   reescribe campos ya publicados sin dejar historial (`audit_log`, `revision`).
2. **Versión de snapshot.** Cada importación registra `digestSha256` + `capturedAt`; re-ingesta
   con mismo digest es no-op (idempotencia por `externalKey` en EPG y por `legacyId`/alias en
   canales).
3. **Campos nuevos = opcionales en el contrato.** Si 02B requiere un campo nuevo (p. ej. país real
   de iptv-org), se añade como opcional y el cliente antiguo sigue funcionando; nada se elimina del
   contrato público.
4. **Enum cerrados.** No se amplían los enums públicos sin migración de datos previa y actualización
   de `contracts`; los valores externos no reconocidos se mapean a un valor canónico existente
   (nunca se inventa uno).
5. **Retención vs publicación.** Fuentes que no cumplen condiciones se **retienen** (draft +
   razón), nunca se eliminan en silencio; la retirada es `withdrawn` (historial conservado).
6. **Rollback.** Cada fase es reversible: un importador nuevo puede desactivarse sin tocar datos
   ya servidos (las fuentes de otra procedencia se marcan `withdrawn`, no se borran).

---

## 6. Criterios de aceptación para 02B

1. **Mapeo completo y sin pérdida silenciosa:** para cada registro de entrada se produce un canal
   publicado, un canal en revisión, o una exclusión documentada con razón (paridad con el contrato
   `ImportExclusionReason`).
2. **Fail-closed:** ningún `PlaybackSourceDoc` público con `permission=unlicensed`,
   `requiresForgedHeader=true`, `emitterAppOnly=true`, o sin decisión de emisor.
3. **Procedencia:** todo canal/fuente/programa no editorial lleva `provenance` con `licence`,
   `attribution` (cuando aplica) y `digestSha256`.
4. **Idempotencia:** re-ejecutar la importación con el mismo snapshot produce el mismo estado
   (sin duplicados de canal, fuente ni programa).
5. **Atrás-compatible:** los payloads públicos de canales ya publicados son byte-equivalentes antes
   y después de incorporar una fuente nueva (salvo campos nuevos opcionales declarados).
6. **Contratos verdes:** suite de contrato (fixtures de `tv.json`, `TV.epg.json`, M3U iptv-org
   reducido, XMLTV) pasa determinísticamente.
7. **Bloqueo de Free-TV:** ningún dato de Free-TV aparece en datos ni en código de importación; se
   documenta la razón (`no-licence`).
8. **Resolución de H1:** `country` emitido por el contrato público cumple `^[A-Z]{2}$` para todo
   canal publicado.
9. **Informe de migración:** conteos verificables de importados / retenidos / rechazados por razón
   y por fuente.

### Pruebas de contrato (comandos de verificación)

| # | Contrato | Comando (a ejecutar en 02B) |
| --- | --- | --- |
| 1 | Fixture `tv.json` → `extractReferenceChannels` sin rechazos inesperados | `pnpm --filter @tdt/backend test -- catalogue-import` |
| 2 | Fixture `TV.epg.json` → `parseJsonGuide` (tiempos UTC, join por `name`) | `pnpm --filter @tdt/backend test -- epg` |
| 3 | M3U iptv-org reducido → atributos `tvg-*` + `#EXTVLCOPT` | test de contrato nuevo (fixture + hash) |
| 4 | Public API no regresiona (canales/fuentes/EPG) | `pnpm --filter @tdt/backend test -- integration` |
| 5 | Independencia (hosts TDTChannels bloqueados, sin URL en runtime) | `pnpm --filter @tdt/backend test -- independence` |

---

## 7. Qué NO debe importarse por derechos

1. **Streams que exigen forjar cabeceras** (`UAG*`, `REF*`, `#EXTVLCOPT http-user-agent/referrer`).
2. **URLs tokenizadas / con placeholders** (`[DEVICE_ID]`, parámetros no reproducibles).
3. **Todo el repositorio Free-TV/IPTV** (sin licencia).
4. **Logos sin permiso de exhibición** (`logoSrcPermission='none'`): una URL de logo de terceros no
   es una licencia para mostrarla.
5. **Entradas del blocklist de iptv-org** y enlaces a servidores Xtream Codes / DRM / pago /
   suscripción (los tres proyectos ya los excluyen; re-verificar al importar).
6. **Prosa editorial de terceros**: descripciones de canal (nunca) y descripciones largas de
   programa (solo con atribución de la guía; retirar si los términos de la guía lo exigen).
7. **Señales geobloqueadas** sin marcar `geoRestricted` y sin decisión del emisor.
8. **Ningún stream se proxya, graba ni transcodifica** — el navegador reproduce la dirección del
   emisor; importar un enlace nunca implica alojar la señal.

---

## 8. Riesgos y decisiones pendientes

| # | Riesgo/Decisión | Dueño | Antes de |
| --- | --- | --- | --- |
| D1 | Valor canónico de `country` para internacional (H1) | editorial/arquitectura | F2 |
| D2 | SPDX exacto de iptv-org (CC0 vs Unlicense) | verificación | F3 |
| D3 | `branding.logoSrcPermission` para logos de terceros (H4) | editorial | cualquier publicación |
| D4 | Vocabulario de `genre` del EPG (normalización) | editorial | F1/F3 |
| D5 | Confirmar permiso escrito de Free-TV (si se decide incluirlo) | legal | n/a (bloqueado) |
