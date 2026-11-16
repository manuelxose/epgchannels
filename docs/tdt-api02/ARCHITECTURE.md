# ARCHITECTURE — TDT Platform (TDT-API-01, base de TDT-API-02)

Estado: **baseline auditado** en 02A (evidencia: `AUDITORIA-ARQUITECTURA.md`,
`AUDITORIA-INDEPENDIENTE.md`). Este documento es memoria persistente: describe lo que **existe**,
no lo que se desea. Toda afirmación cita `ruta:línea` del repositorio real.

Base verificada: `main` @ `febbec464763ffd5812f5b80bf3f6901774dde65`.

---

## 1. Forma del sistema

Monorepo npm (`package.json:10-13`) con dos aplicaciones y dos paquetes:

| Pieza | Ruta | Rol |
|---|---|---|
| Backend | `apps/backend` | Express 5 + TypeScript, MongoDB, Redis opcional |
| Frontend | `apps/frontend` | Angular 22, consumo del SDK generado |
| Contratos | `packages/contracts` | Esquemas Zod compartidos: la **única** fuente de verdad |
| SDK | `packages/api-client` | Tipos generados desde `openapi/openapi.json` |

**Contrato anti-deriva.** El contrato se escribe una sola vez en Zod
(`packages/contracts/src/*`); de él derivan el validador de rutas (`server/schemas.ts:8-35`), el
documento OpenAPI (`server/openapi.ts:67-121`) y el SDK
(`packages/api-client/scripts/generate-types.mjs:1-11`). Cambiar el contrato sin regenerar el SDK
rompe el triángulo ruta↔contrato↔SDK.

---

## 2. Aplicación Express y límite de seguridad

`createApp` (`server/app.ts`) monta, en orden: request-id → helmet → CORS → compresión + JSON
limitado a 256 KB → métricas → cache headers + ETag → router.

- CORS con lista explícita de orígenes; sin `Origin` (server-to-server) se permite (`app.ts:63-78`).
- `/metrics` se sirve **antes** del router y sin autenticación ni rate-limit (`app.ts:91-95`) —
  ver hallazgo **SEC-09**.
- Router en `/api/v1` (`config.API_BASE_PATH`) con rate-limit → cache → ETag (`app.ts:97-107`).
- Las rutas sin versión devuelven 404 a propósito (`app.ts:109-112`).
- Envelope de error único `{error:{code,message,details?},requestId}`; 500 genérico
  (`app.ts:114-155`, `server/errors.ts:14-48`).
- `trust proxy = 'loopback'` (`app.ts:53`): correcto frente a *spoofing*, pero el rate-limit por IP
  se colapsa detrás de un proxy no-loopback (**SEC-10**).

---

## 3. Modelo de datos MongoDB

Colecciones tipadas en `infrastructure/mongo.ts:11-24`; `_id` es siempre un UUID propio en string
(`mongo.ts:33-35`). Esquemas en `infrastructure/schema.ts:11-215`, índices idempotentes en
`schema.ts:218-281`.

Índices que importan para el rendimiento y la corrección:

- `channels`: `slug` **único**, `(editorialStatus,category,name)`, `(country,region.code,name)`,
  `languageTag`, `searchText` (texto), `(aliases.namespace,aliases.value)`, `updatedAt`
  (`schema.ts:221-229`).
- `sources`: `(channelId,priority)`, `(channelId,editorialStatus)`, cola de verificación
  `(technicalStatus,lastVerifiedAt)` (`schema.ts:233-237`).
- `programmes`: `(channelId,start)`, `(channelId,externalKey)` **único**, `end` (expiración)
  (`schema.ts:241-246`) — la idempotencia del EPG depende de este índice.
- `admin_sessions`: `tokenSha256` único + TTL (`schema.ts:265-268`).

Migraciones versionadas (`migrations/`), con ledger `migration_ledger` que registra el digest
SHA-256 de la instantánea importada (`jobs/migration-executor.ts:30-44`).

---

## 4. Identidad de canal (independiente del proveedor)

- **La URL pública es el slug, nunca el UUID.** `slug` ASCII `^[a-z0-9]+(?:-[a-z0-9]+)*$`, 1–120
  (`packages/contracts/src/common.ts:17-21`); el UUID es interno (`channels.ts:52-53`).
- `canonicalSlug` normaliza NFD/diacríticos y prefiere un slug canónico de consumidor
  (`shared/slug.ts:38-55`); nunca genera un slug vacío.
- **Alias por namespace** (`common.ts:161-166`): `legacy-tdt`, `epg`, `guiatv`, `merged-from` —
  son identidades externas, no URLs. Es el mecanismo que permite migrar de proveedor sin romper
  enlaces.
- Taxonomía canónica de categorías y 19 regiones ISO 3166-2:ES + `INTL`
  (`shared/taxonomy.ts:11-84`).

---

## 5. Registro de fuentes y puertas de autorización

Cinco adaptadores (`providers.registry.ts:15-20`): `emitter-hls`, `emitter-dash`,
`youtube-iframe`, `official-embed`, `external-reference`. Los adaptadores verifican con honestidad:
HLS comprueba `#EXTM3U` (`:78-110`), DASH `<MPD` (`:129-156`), y YouTube/embed/external devuelven
`technicalStatus:'unknown'` **sin sondear** (`:181-244`).

**Puerta única de publicación** (`modules/playback/publication-policy.ts`): separa tres preguntas
que nunca se colapsan — ¿podemos exponerla? (permiso + condiciones), ¿está sana? (estado técnico),
¿qué motor? (tipo). El orden de `decidePublication` (`:61-85`) hace que **la autorización manda
sobre la disponibilidad**.

**Allowlist de emisores** (`providers/emitters.ts:1-9, 109-130`): un host no listado es
`unreviewed` con `exposeSources:false`. Por defecto no se expone nada no revisado.

---

## 6. Ingesta EPG

- `epg.ingestion.ts` descarga **solo** fuentes habilitadas, reconcilia por el alias de namespace
  `epg` y **nunca crea canales**: un id upstream no mapeado se reporta (`:1-9, 122-163`). Cada run
  escribe `job_runs`.
- `epg.service.ts` es idempotente: `upsert` por `(channelId, externalKey)` (`:102-139`), descarta
  eventos inválidos/duplicados, y expone `availability` explícito
  `available|empty|not-mapped|withdrawn` (`packages/contracts/src/epg.ts:19-28`). **Nunca fabrica
  una emisión.**
- Parsers puros y estrictos: XMLTV (con conversión de zona y DST) y `json-tdtchannels`
  (`epg.parsers.ts:41-233`).

---

## 7. Modelo de reproducción

`playback.service.ts` es el único lugar que decide qué fuente gana. `buildDescriptor` ordena por
prioridad, filtra in-app, y cae a `external`/`eventual`/`degraded`/`unavailable` sin inventar nada
(`:150-268`).

- **YouTube offline** → `eventual` con motor `none`, en lugar de un reproductor vacío
  (`:184-211`), corregido en `febbec4`.
- El estado de YouTube se lee de la **BD propia** en el camino de petición, nunca de YouTube
  (`youtubeStateFor`, `:303-328`).
- `youtube-channel-resolver.ts:89-130` resuelve el directo leyendo el `<link rel="canonical">` de la
  página pública — **scraping**, sin Data API (**SEC-04**, riesgo de ToS y contradicción con el
  frontend).
- **No hay redifusión**: se entrega la URL del emisor, el cliente reproduce contra el emisor. No
  existe implementación de proxy/relay/transcodificación.

---

## 8. Administración, métricas y caché

- Auth admin: `scrypt` + salt, sesiones opacas con SHA-256 en reposo, comparación en tiempo
  constante, bootstrap solo con cero administradores (`admin.auth.ts:27-63`).
- Editorial: nada se borra (se retira), merge pliega aliases/fuentes/guía, revert desde revisión
  auditada, y toda escritura guarda `before/after` con control optimista (`editorial.service.ts`).
- ETag + `response-cache` **local al proceso** (256 entradas) para lecturas caras; se invalida en
  escrituras editoriales, pero **no** en los jobs de verificación/EPG (**R5**).
- Rate-limit de ventana fija, compartido por Redis o en proceso (`middleware.ts:33-77`); métricas
  Prometheus en memoria (`:80-117`).
- Redis es **opcional y no semántico**: su caída nunca cambia una respuesta
  (`infrastructure/cache.ts:1-7`).

---

## 9. Frontend

Angular 22 con tests unitarios (`angular.json:67-69`) y E2E Playwright contra build de producción
(especificaciones: catalogue, epg, player, youtube, cast, `real-backend`, a11y/responsive,
engine-selection). `@playwright/test` **1.65.0** está instalado en `apps/frontend/node_modules`
(no en la raíz del monorepo: buscarlo en la raíz da un falso negativo). Los E2E requieren
navegadores Playwright y un build previo (`ng build && playwright test`), y **no forman parte del
gate** de 02A; se ejecutan como verificación adicional, no como sustituto de las etapas declaradas.

---

## 10. Despliegue y CI/CD

- `infra/docker-compose.yml`: MongoDB 7 con réplica `rs0` en `127.0.0.1:27117` y Redis 7 en
  `127.0.0.1:27118`, ambos **sin autenticación** (mitigado solo por loopback, **SEC-13**).
- El backend no se despliega desde el compose: solo dependencias.
- **No existe CI/CD**: no hay `.github/` ni pipeline. Ninguna puerta automática impide fusionar
  código que no compila o que rompe tests (**R3**). Esta es la razón por la que 02A aporta
  `qa/qa-manifest.json` + `scripts/preflight.mjs` como gate local reproducible.
- **Consecuencia para el merge**: un merge a `main` no dispara despliegue alguno hoy. Si se añade
  CI/CD en un milestone futuro, el contrato exige revisarlo antes de fusionar.

---

## 11. Dependencias residuales de TDTChannels

La plataforma **ya no depende en runtime** del proveedor; conserva trazas intencionadas:

- Procedencia `tdtchannels-snapshot` con `licence:'Apache-2.0'` y atribución obligatoria, emitida en
  `/channels` y `/channels/:slug` (`channels.service.ts:16-36`).
- Alias `legacy-tdt` como clave idempotente de importación.
- Parser `json-tdtchannels` para importar instantáneas **suministradas por el operador** (el import
  nunca descarga nada, `jobs/catalogue-import.ts:1-16`).
- `tools/probe-guides.mjs` todavía consulta `tdtchannels.com` e `iptv-org`: superficie de egress
  residual fuera de runtime (**SEC-14**).

---

## 12. Contratos que 02B no debe romper

1. URL pública = slug; UUID interno.
2. Descriptor de reproducción tipado (`engine`, `status` fijos) y **sin credenciales**.
3. Autorización antes que disponibilidad; emisor no listado = no expuesto.
4. Envelope de error único y 500 genérico.
5. Paginación `{page,pageSize,total,pageCount,hasNext,hasPrevious}`.
6. Atribución obligatoria en todo payload derivado de terceros.
7. `/api/v1` fija; sin rutas sin versión.
8. Redis opcional y no semántico.
9. EPG con `availability` explícito; nunca fabrica emisiones.
10. Procedencia + licencia por fuente en cada registro de terceros.
11. Cinco tipos de proveedor y taxonomía canónica.
12. Contrato GuíaTV (`slugPolicy`, `identity-map` con `match` nunca adivinado).
13. No re-depender de TDTChannels en runtime.
