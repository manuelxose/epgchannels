# Auditoría de arquitectura y backend — TDT-API-01

- **Worktree:** `wt/tdt02a-arch` (rama `feat/tdt02a-arch`, base `febbec4`)
- **Alcance:** auditoría estática, lectura de código, sin cambios de código/tests/CI.
- **Evidencia:** cada afirmación cita `ruta:línea` (rutas relativas a la raíz del worktree).

La plataforma es un monorepo npm con dos aplicaciones y dos paquetes (`package.json:10-13`):
backend Express 5 + TypeScript + MongoDB + Redis opcional (`apps/backend`), frontend Angular 22
(`apps/frontend`), contratos Zod compartidos (`packages/contracts`) y cliente/SDK generado
(`packages/api-client`). El contrato se escribe una sola vez en Zod y de él derivan la validación
de rutas, el documento OpenAPI y el SDK (contrato anti-deriva).

## 1. Aplicación Express y contratos de rutas

**Fábrica y orden de middleware (límite de seguridad).** `createApp` monta, en orden documentado
(`apps/backend/src/server/app.ts:1-14`): request-id → helmet → CORS → compresión + body JSON
limitado a 256kb → métricas → cache headers + ETag → router. Detalles:

- `requestId` valida/inyecta `x-request-id` y lo refleja en respuestas (`app.ts:55`, `server/middleware.ts:13-19`).
- Helmet sin CSP (API JSON), CORP `cross-origin`, `no-referrer` (`app.ts:56-62`).
- CORS restringido a `config.CORS_ORIGINS`; sin `Origin` (server-to-server) se permite (`app.ts:63-78`).
- Body limitado: `express.json({ limit: MAX_JSON_BODY_BYTES })` = 256kb (`app.ts:80`, `middleware.ts:181`).
- `/metrics` (operador) se sirve **antes** del router y nunca se cachea/limita (`app.ts:91-95`).
- El router se monta en `config.API_BASE_PATH` (=`/api/v1`) con rate-limit → cache headers → cache → invalidación → ETag (`app.ts:97-107`).
- Las rutas sin versión devuelven 404 a propósito: "los consumidores deben fijar v1" (`app.ts:109-112`).
- Un único envoltorio de error: `{error:{code,message,details?},requestId}`; los detalles internos nunca salen (`app.ts:114-155`, `server/errors.ts:14-48`).

**Rutas.** `createRouter` (`server/routes.ts:78-752`) registra todos los endpoints con `handle` para
promesas (`routes.ts:82-87`) y `parse` que valida query/body/params con el esquema Zod compartido,
lanzando `AppError.validation` (`routes.ts:89-105`). `requireSlug`/`requireId` validan `:slug`
(1-120) y `:id` (UUID) (`routes.ts:107-117`).

**Contratos Zod.** `server/schemas.ts` re-exporta todos los esquemas desde `@tdt/contracts`
(`schemas.ts:8-35`), de modo que la ruta no puede validar contra un esquema que el cliente no conoce.
Primitivas en `packages/contracts/src/common.ts`: `idSchema` UUID (`:11`), `slugSchema` ASCII
`^[a-z0-9]+(?:-[a-z0-9]+)*$` 1-120 (`:17-21`), `countryCodeSchema` ISO 3166-1 (`:29-31`),
`editorialStatusSchema` (`:72`), `playbackStatusSchema`/`playbackEngineSchema`/`permissionSchema`
(`:80-127`), `apiErrorSchema` (`:183-199`), `paginationSchema` (`:203-211`), `attributionSchema`
(`:214-220`). Contratos por dominio en `channels.ts`, `playback.ts`, `epg.ts`, `integration.ts`,
`health.ts`, `admin.ts`.

**OpenAPI 3.1 y SDK.** `server/openapi.ts` construye el documento desde los **mismos** esquemas Zod
(`openapi.ts:67-121`, conversor `zod-to-json.ts`); el fichero exportado es `openapi/openapi.json`
(~131 KB). El SDK `packages/api-client` genera tipos desde ese documento
(`packages/api-client/scripts/generate-types.mjs:1-11`), cerrando el triángulo ruta↔contrato↔SDK.

## 2. Esquemas e índices MongoDB

`infrastructure/mongo.ts` define `COLLECTIONS` (mapa tipado; un error de nombre es error de tipo,
`mongo.ts:11-24`) y `connectDatabase`, que hace `ping` **antes** de que el servidor escuche
(`mongo.ts:40-64`). `_id` es siempre UUID propio en string (`mongo.ts:33-35`).

`infrastructure/schema.ts` define cada documento una sola vez (ChannelDoc, PlaybackSourceDoc,
ProgrammeDoc, EpgSourceDoc, AuditDoc, AdminUserDoc, AdminSessionDoc, JobRunDoc, YoutubeChannelDoc,
IntegrityRefusalDoc; `schema.ts:11-215`) y `ensureIndexes` crea los índices de forma idempotente
(`schema.ts:218-281`). Índices destacados:

- `channels`: `slug` único, `(editorialStatus,category,name)`, `(country,region.code,name)`,
  `languageTag`, `searchText` texto, `(aliases.namespace,aliases.value)`, `updatedAt` (`schema.ts:221-229`).
- `sources`: `(channelId,priority)`, `(channelId,editorialStatus)`, cola de verificación `(technicalStatus,lastVerifiedAt)` (`schema.ts:233-237`).
- `programmes`: `(channelId,start)`, `(channelId,externalKey)` único (idempotencia), `end` (expiración), `(sourceId,start)` (`schema.ts:241-246`).
- `admin_sessions`: `tokenSha256` único + TTL `expireAfterSeconds:0` (`schema.ts:265-268`).
- `youtube_channels`: `(nextCheckAt,failures)` cola de resolución (`schema.ts:279-280`).

**Migraciones.** `migrations/` (`run.ts`, `runner.ts`, `types.ts`) ejecuta migraciones versionadas;
`003-reclassify-source-types.ts` corrige 26 fuentes etiquetadas `hls` que en realidad eran páginas
de reproductor (`migrations/003-reclassify-source-types.ts:1-11`). El ejecutor de importación
(`jobs/migration-executor.ts`) escribe un ledger `migration_ledger` con digest SHA-256 de la
instantánea (`migration-executor.ts:30-44`, `251-267`).

## 3. Identificadores independientes de canal

- **UUID interno nunca en URL.** El slug es el único identificador público (`packages/contracts/src/common.ts:10-21`); el UUID es "interno" (`channels.ts:52-53`).
- **Slug estable y derivado una vez.** `shared/slug.ts:24-36` normaliza NFD/diacríticos/entidades; `canonicalSlug(name, preferred?)` prefiere un slug canónico de un consumidor (GuíaTV) para evitar una segunda URL pública (`slug.ts:38-55`); nunca genera slug vacío (`slug.ts:52-54`).
- **Alias por namespace** (`common.ts:161-166`): `legacy-tdt`, `epg`, `guiatv`, `merged-from` son identidades externas, no URLs.
- **Taxonomía canónica.** `shared/taxonomy.ts` define categorías (`:11-43`), `kind` (`:45-50`) y las 19 regiones ISO 3166-2:ES (`:64-84`) más el agregado `INTL` (`routes.ts:296-304`); `resolveRegionCode` pliega sinónimos y abreviaturas administrativas (`taxonomy.ts:130-154`).
- **Búsqueda sin acentos** normalizada en servidor y cliente (`shared/search.ts:54-99`), almacenada en `searchText` al escribir (`channels.service.ts:257-259`).

## 4. Registro de fuentes y puertas de autorización

**Adaptadores por tipo.** `providers.registry.ts` registra cinco adaptadores (`emitter-hls`,
`emitter-dash`, `youtube-iframe`, `official-embed`, `external-reference`; `:15-20`, `:247-254`).
Cada uno `accepts` un tipo y `verify` con honestidad: HLS valida `#EXTM3U` (`:78-110`), DASH valida
`<MPD` (`:129-156`), YouTube/embed/external devuelven `technicalStatus:'unknown'` sin sondear
(`:181-192`, `:214-219`, `:238-244`). Sin adaptador para un tipo → `blocked` (`:268-279`).

**Política de publicación (puerta única).** `publication-policy.ts` separa tres preguntas que
"nunca se colapsan": ¿podemos exponerla? (permission+conditions), ¿está sana? (technicalStatus),
¿qué motor? (type) (`:1-18`). `decidePublication` resuelve en orden: canal publicado → fuente no
retirada → permiso en `PUBLIC_PERMISSIONS` (`:23-29`) → sin cabecera falsificada → no `emitterAppOnly`
→ no `blocked` (`:61-85`). La autorización **siempre** manda sobre la disponibilidad técnica.

**Allowlist de emisores.** `providers/emitters.ts` clasifica hosts por `basis`
(`public-broadcaster`, `operator-published`, `platform-embed`, `reference-only`) y, por defecto,
todo host no listado es `unreviewed` con `exposeSources:false`, de modo que nada no revisado se
expone (`:1-9`, `:109-130`).

## 5. Ingesta EPG

`epg.ingestion.ts` descarga solo fuentes habilitadas, reconcilia por el alias de namespace `epg`
(`reconcile`, `:41-61`) y **nunca crea canales**: cada id upstream no mapeado se reporta (`:1-9`,
`:122-163`). Cada ejecución escribe `job_runs` éxito o fallo (`:82-105`, `:177-191`). `runAll` itera
secuencialmente (`:204-211`).

`epg.service.ts` es idempotente: el programa se clava por `(channelId, externalKey)` con `upsert`
(`:102-139`), normaliza/descarta eventos inválidos o duplicados (`:50-78`), y expone `scheduleFor`
(`:193-223`) y `feed` now/next (`:225-263`) con `availability` explícito
`available|empty|not-mapped|withdrawn` (`packages/contracts/src/epg.ts:19-28`) — nunca fabrica una
emisión.

`epg.parsers.ts` implementa dos parsers puros y estrictos: XMLTV (subconjunto documentado, con
conversión de zona horaria y DST, `:41-105`, `:139-174`) y `json-tdtchannels` (`:181-233`).

## 6. Modelo de reproducción

`playback.service.ts` ensambla el descriptor y es el único sitio que decide qué fuente gana
(`:1-13`). `buildDescriptor` ordena por prioridad, filtra in-app (públicas + sanas + no external)
y produce `available` con opciones, o cae a `external`/`eventual`/`degraded`/`unavailable` sin
inventar nada (`:150-268`). Caso YouTube **offline**: si la única fuente in-app es un canal resuelto
como no emitiendo, devuelve `eventual` con motor `none` en lugar de un reproductor vacío
(`:184-211`). El estado de YouTube se lee de la BD propia, nunca de YouTube en el camino de petición
(`youtubeStateFor`, `:303-328`). `statusesFor` resuelve estados de N canales con una sola consulta de
fuentes (`:339-371`).

`youtube-channel-resolver.ts` resuelve un canal a su vídeo en directo leyendo solo el
`<link rel="canonical">` de la página pública (`:13-27`, `:89-130`); sin Data API, sin manifiestos,
sin tokens (`:20-27`). La cola la mantiene `jobs/youtube-resolution.ts` (batch acotado, backoff) y
`youtube-channel-cache.ts` (`youtube-channel-resolver.unit.spec.ts` cubre el parseo).

## 7. Administración y métricas

**Autenticación.** `admin.auth.ts`: scrypt con salt aleatorio, comparación en tiempo constante
(`:27-39`); sesiones = token aleatorio del que se almacena **SHA-256** (`:41-44`); bootstrap solo con
cero administradores (`:60-63`). `admin-auth.service.ts`: `bootstrap`/`login`/`logout`/`requireRole`
(`:59-171`), sin API key que viaje al navegador (`admin.auth.ts:6-7`).

**Editorial.** `editorial.service.ts` garantiza que la pérdida accidental es imposible: no se borra
(un canal se retira), el merge pliega aliases/fuentes/guía y retira el duplicado con `mergedInto`
(`:224-285`), el revert restaura desde una revisión auditada (`:195-222`), y toda escritura guarda
`before/after` en `audit_log` con control optimista `expectedUpdatedAt` (`:155-193`). `sources.service.ts`
exige permiso explícito y condiciones al crear una fuente y retira (no borra) (`:35-146`).

**Caché y ETag.** `etag.ts` firma el cuerpo serializado (SHA-1 base64url) y responde 304
(`:10-37`). `response-cache.ts` cachea solo lecturas caras del catálogo (`/categories`, `/regions`,
`/channels`; `:34-40`), clava por URL efectiva, está acotado (256 entradas, evicción por antigüedad)
y se invalida en escrituras editoriales (`:130-145`). Es **local al proceso** por diseño (`:12-14`).

**Métricas y rate-limit.** `middleware.ts`: rate-limit de ventana fija, compartido con Redis o
en-proceso sin Redis (lo declara en `ratelimit-mode`, `:33-77`); `Metrics` en memoria exportadas en
formato Prometheus (`:80-117`); etiquetas por patrón de ruta, no por path crudo (`:132-152`).

**Logging.** `logging.ts` usa pino con redacción de `authorization`/`cookie`/`x-api-key`/`set-cookie`
(`:11-27`). `/health` comprueba Mongo (ping) y Redis (o `disabled`) y devuelve 503 si Mongo cae
(`routes.ts:125-172`).

## 8. Pruebas existentes y cobertura

`vitest.config.ts` define tres proyectos (`:12-49`): **unit** (`*.unit.spec.ts`), **integration**
(`*.integration.spec.ts`, MongoDB y HTTP reales, secuencial), **independence**
(`*.independence.spec.ts`).

- **Unit** (lógica pura): `publication-policy.unit.spec.ts`, `epg.parsers.unit.spec.ts`,
  `youtube-channel-resolver.unit.spec.ts`, `security.unit.spec.ts` (hashing/tokens/egress-block),
  `catalogue-import.unit.spec.ts`.
- **Integration**: `contracts.integration.spec.ts`, `public-api.integration.spec.ts`,
  `admin-workflow.integration.spec.ts`, `epg.integration.spec.ts`, `migration.integration.spec.ts`,
  `youtube-resolution.integration.spec.ts`.
- **Independence**: `independence.independence.spec.ts` reemplaza `fetch` a nivel de proceso para
  bloquear hosts TDTChannels y verifica que catálogo, búsqueda, guía, reproducción, SDK y workflow
  editorial siguen funcionando sin contacto con el proveedor (`:47-64`, `:101-254`), además de
  escanear el árbol fuente buscando URLs/scripts del proveedor (`:256-298`).

**Frontend.** Pruebas unitarias Angular (`@angular/build:unit-test`, `apps/frontend/angular.json:67-69`;
specs en `core/*`), y Playwright E2E contra build de producción servido estáticamente
(`playwright.config.ts:1-44`): `catalogue`, `epg`, `player`, `youtube*`, `cast*`,
`real-backend` (sin stubs, contra la API real), `a11y-responsive`, `engine-selection`.

**Lo que NO cubren:** (a) verificación de streams reales de emisores de forma continua (las
verificaciones HLS/DASH requieren red y son por job/admin, no aserción E2E estable); (b) carga/
concurrencia real (existe `test:load` en `package.json:21` pero no es parte de `test`); (c)
despliegue/productivo, secretos y Redis en clúster (solo se prueba el degradado NullCache); (d)
seguridad ofensiva (pentest, SSRF con rangos privados, fuzzing de entradas); (e) accesibilidad
completa (solo una spec e2e).

## 9. Redis y despliegue; ausencia de CI/CD

**Configuración.** `config/config.ts` valida todo con Zod al arranque y falla alto ante config
inválida (`:122-135`); carga `.env` con `process.loadEnvFile` sin dependencia (`:18-30`); `REDIS_URL`
opcional (`:52`), `CACHE_TTL_SECONDS`, rate-limit, egress y jobs con defaults (`:41-117`);
`EGRESS_GUARD_ENABLED` se **rechaza en producción** por ser de prueba (`:131-133`).

**Redis opcional y honesto.** `infrastructure/cache.ts`: sin `REDIS_URL` usa `NullCache`; una caída
de Redis devuelve `null`/no-op y la petición se sirve desde la BD ("no existe camino donde una caída
de caché cambie una respuesta", `:1-7`, `:93-110`).

**Arranque y cierre.** `main.ts` ordena: config → context → `ensureIndexes` → escuchar → jobs
(opcionales) → shutdown limpio con SIGINT/SIGTERM (`main.ts:16-53`). `bootstrap.ts` construye el
`AppContext` una sola vez (`bootstrap.ts:18-43`).

**Infra local.** `infra/docker-compose.yml`: Mongo 7 con replica set `rs0` (puerto 27117, init
one-shot, `:2-38`) y Redis 7 sin persistencia (`:40-50`). El backend no se despliega aquí: solo las
dependencias.

**Sin CI/CD.** No existe directorio `.github` ni configuración de pipeline; el único YAML es
`infra/docker-compose.yml`. Build, typecheck, tests y despliegue se ejecutan manualmente vía scripts
npm (`package.json:14-37`: `build`, `typecheck`, `test`, `test:unit`, `test:integration`,
`test:independence`, `test:e2e`, `migrate`, `import:catalogue`, `openapi:export`, `client:generate`,
`audit:bootstrap`, `audit:acceptance`). No hay puerta automatizada que impida mergear código que no
compila o no pasa tests.

## 10. Dependencias residuales de TDTChannels

La plataforma **ya no depende en runtime** del proveedor, pero conserva trazas documentadas:

- **Provenance**: los registros importados llevan `source:'tdtchannels-snapshot'`,
  `licence:'Apache-2.0'`, URL `github.com/LaQuay/TDTChannels` y atribución obligatoria
  (`jobs/migration-executor.ts:147-165`, `modules/channels/channels.service.ts:16-18`).
- **Alias de legado**: `namespace:'legacy-tdt'` como clave idempotente de importación
  (`migration-executor.ts:55`, `:129-131`).
- **Formato EPG**: el parser `json-tdtchannels` y el `epgSourceKindSchema` conservan el shape de la
  guía de referencia (`epg.parsers.ts:181-233`, `packages/contracts/src/epg.ts:111`), usado solo para
  importar instantáneas suministradas por el operador.
- **Independencia verificada**: `independence.independence.spec.ts` bloquea `tdtchannels.com` y
  subdominios en egress (`:26-32`) y escanea el árbol fuente en busca de URLs/scripts del proveedor
  (`:257-298`). `jobs/catalogue-import.ts` nunca descarga nada (`:1-16`).

---

## Tabla de riesgos

| ID | Severidad | Impacto | Recomendación |
|---|---|---|---|
| R1 | Media | `EGRESS_GUARD_ENABLED` es un flag muerto: en `bootstrap.ts:38` ambas ramas del ternario devuelven `config.BLOCKED_EGRESS_HOSTS`, de modo que la blocklist de egress se aplica siempre (aunque por defecto esté vacía) y el guard "test-only" no actúa como tal. | Gatear de verdad la blocklist por el flag o eliminar el flag y documentar que `BLOCKED_EGRESS_HOSTS` es operativo. |
| R2 | Alta | `playable=true` (`channels.service.ts:207-226`) carga **todo** el catálogo filtrado a memoria y pagina en JS; con miles de canales es O(N) sin límite y rompe la promesa de "over-fetch pequeño". | Paginar en BD con agregación `$lookup` o índice derivado, o acotar el scan. |
| R3 | Alta | Sin CI/CD: ningún pipeline ejecuta build/typecheck/tests/independence de forma automática; el merge puede entrar roto. | Añadir workflow (build+typecheck+unit+integration+independence+e2e) como puerta de merge. |
| R4 | Media | Métricas, rate-limit y response-cache son **locales al proceso** (`middleware.ts:80-117`, `:52-64`, `response-cache.ts:12-14`); en multi-instancia sin Redis el rate-limit no es global y las métricas no se agregan. | Documentar y exigir Redis compartido + agregador de métricas para HA. |
| R5 | Baja | El response-cache de `/channels` no se invalida en los jobs de verificación/EPG (escriben la BD sin pasar por el router); el estado derivado puede quedar obsoleto hasta `CACHE_TTL_SECONDS`. | Invalidar explícitamente el cache en `verifySource`/ingesta, o aceptar y documentar la ventana TTL. |
| R6 | Media | Los adaptadores `youtube`/`official-embed`/`external` devuelven `technicalStatus:'unknown'` (`providers.registry.ts:181-243`); su `available` se deriva solo de presencia+permiso, no de salud real. | Verificar con Data API (YouTube, si hay clave) y sondas seguras, o etiquetar el estado como "no verificado" en el descriptor. |
| R7 | Media | SSRF parcial: `egress.ts` valida esquema http/https y blocklist (`:78-83`, `:101-106`) pero **no** bloquea rangos privados/link-local (127.0.0.1, 169.254.169.254, RFC1918); las URLs de verificación/ingesta las introduce un operador. | Añadir denegación de direcciones privadas/link-local antes de abrir socket. |
| R8 | Baja | El resolver de YouTube lee `<link rel="canonical">` de HTML (`youtube-channel-resolver.ts:77-80`); un cambio de markup lo rompe y no es un endpoint documentado. | Monitorizar `state:'unavailable'` agregado y tratar como señal de revisión; considerar Data API para el subconjunto crítico. |
| R9 | Baja | Colección `channel_epg_map` declarada (`mongo.ts:16`) pero sin uso ni índice: código muerto que puede confundir. | Eliminar o documentar como reservado. |
| R10 | Baja | Inconsistencia de validación: `epgFeedQuerySchema.country` es `z.string().length(2)` (`epg.ts:87`) frente a `countryCodeSchema` (mayúsculas). | Unificar con `countryCodeSchema`. |
| R11 | Baja | Casts `permission as never` dispersos (`playback.service.ts:55,132,172,235,362`) debilitan el tipado del enum `Permission`. | Tipar `PublicationContext.permission` como `Permission` y eliminar casts. |
| R12 | Baja | `/health` devuelve `error.message` de Mongo en `dependencies[].message` (`routes.ts:144`), lo que puede filtrar cadena de conexión/host. | Devolver texto genérico + log interno. |
| R13 | Baja | `CORS_ORIGINS` por defecto son solo localhost (`config.ts:58-66`); un despliegue productivo mal configurado queda abierto o cerrado de más. | Validar en producción (rechazar arranque sin `CORS_ORIGINS` explícito). |

## Contratos que 02B no debe romper

1. **URL pública = slug, nunca UUID.** `slug` ASCII lowercase `^[a-z0-9]+(?:-[a-z0-9]+)*$`, 1-120,
   estable (`common.ts:17-21`, `slug.ts:38-55`). El `id` UUID permanece interno (`common.ts:10-11`).
2. **Descriptor de reproducción tipado.** `engine ∈ {hls,dash,youtube-iframe,official-embed,external,none}`
   y `status ∈ {available,degraded,external,eventual,unavailable}` (`common.ts:80-107`); **nunca**
   credenciales/cookies/tokens en el payload (`playback.ts:12-13`).
3. **Autorización antes que disponibilidad.** Un `permission` fuera de `PUBLIC_PERMISSIONS`, o una
   condición prohibida, nunca se expone aunque esté sana (`publication-policy.ts:61-85`,
   `common.ts:113-127`). Default emisor no listado = `unreviewed`/no expuesto (`emitters.ts:1-9`).
4. **Envelope de error único** `{error:{code,message,details?},requestId}` con `apiErrorCode`
   (`common.ts:169-199`) y 500 genérico sin detalles internos (`app.ts:114-155`).
5. **Paginación** `{page,pageSize,total,pageCount,hasNext,hasPrevious}` (`common.ts:203-211`).
6. **Atribución obligatoria** `attributionSchema {notices,includesThirdPartyData}` en todo payload
   derivado de terceros (`common.ts:214-220`, `channels.service.ts:20-36`).
7. **API versionada `/api/v1`** fija, sin rutas sin versión (`app.ts:45,109-112`;
   `integration.ts:69-72` fija `basePath:'/api/v1'`).
8. **Redis opcional y no-semántico:** su ausencia o caída nunca cambia una respuesta (`cache.ts:1-7`).
9. **EPG independiente y honesto:** `availability` explícito, nunca se fabrica una emisión
   (`epg.ts:19-28`, `epg.service.ts:50-78`).
10. **Procedencia y licencias:** todo dato de terceros conserva `provenance` (source, licence,
    attribution, digestSha256) (`common.ts:134-157`).
11. **Registro de proveedores de 5 tipos** y taxonomía canónica de categorías/regiones
    (`providers.registry.ts:15-20`, `common.ts:41-56`, `taxonomy.ts`).
12. **GuíaTV:** `slugPolicy {authoritative:'tdt-platform', guiatvSlugWinsWhenPresent:true}` y el
    `identity-map` con `match` nunca adivinado (`integration.ts:47-83`, `routes.ts:336,384-420`).
13. **No re-depender de TDTChannels en runtime:** solo instantáneas suministradas por el operador
    con atribución; el test de independencia debe seguir pasando (`independence.independence.spec.ts`).
