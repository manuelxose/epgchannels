<!-- markdownlint-disable -->
# TDT-API-02FG — Contrato de interfaces compartidas (aplicable a t5, t6, t7A, t7B, t8)

Autoridad: el capitán. Si este documento y el repositorio discrepan, **gana el repositorio** (y hay
que decirlo). Este fichero **no se modifica** por los especialistas: los cambios se piden al capitán.

Compartido por los cinco especialistas; base común `0e8571d`.

---

## 0. Contexto real medido por el capitán (no volver a medirlo)

- Monorepo npm workspaces: `packages/contracts`, `packages/api-client`, `apps/backend` (Express 5 +
  MongoDB 7), `apps/frontend` (Angular 20 standalone, zoneless, signals).
- Infra viva: MongoDB `rs0` en `127.0.0.1:27117`, Redis en `127.0.0.1:27118`. `node scripts/preflight.mjs`
  → `READY`.
- Base de datos `tdt_platform` (medido): `channels` 768 (**412 publicados**, 356 en revisión; por país
  publicado **ES 294 / INT 118**; 219 canales con alias `epg`, 144 publicados con alias `epg`),
  `playback_sources` 1364, `source_authorizations_02c` 81, `programmes` 11112 (176 canales, **una sola**
  fuente `json-tdtchannels`), `epg_sources` 2 (ambas `ingestionEnabled: false`), `youtube_channels` 203,
  `audit_log` 0, `job_runs` 0.
- Contratos ya existentes que **no se rompen**: `channels.ts`, `epg.ts`, `playback.ts`, `admin.ts`,
  `common.ts`, `health.ts`, `integration.ts`. `scheduleAvailability = available|empty|not-mapped|withdrawn`.
- Rutas públicas existentes hoy (se conservan): `GET /api/v1/channels`, `/channels/:slug`,
  `/channels/:slug/playback`, `/channels/:slug/schedule`, `/epg/now`, `/epg/next`, `/categories`,
  `/regions`, `/integration/manifest`, `/integration/guiatv/channels`, `/integration/guiatv/identity-map`,
  `/health`.
- UI existente (no duplicar): rutas `television` (catálogo + `watch`) y `schedule`; sin panel de
  administración todavía.

## 1. Reglas que aplican a TODOS

1. **Aislamiento**: cada especialista escribe **solo** en su worktree. Nunca en `tdt-api01` ni en el
   worktree de otro. Un escritor por worktree.
2. **Propiedad de ficheros** (§4): si necesitas editar un fichero `[compartido]` que no es tuyo,
   **implementa en un fichero de extensión propio** y pídelo por mensaje al capitán. No edites el fichero
   ajeno.
3. **Sin cambiar `package.json`** de ningún paquete (ni raíz, ni apps, ni packages) sin que el capitán
   lo haya hecho antes. Dependencias nuevas: pídmelas.
4. **Build obligatorio antes de typecheck** (medido): un typecheck en frío falla porque
   `@tdt/api-client`/`@tdt/backend` resuelven `dist/` de `@tdt/contracts`.
   Secuencia en un worktree recién creado:
   ```
   npm install
   npm run build -w @tdt/contracts -w @tdt/api-client
   ```
   `node_modules` **no** se hereda del checkout principal: instálalo en tu worktree.
5. **Ejecución de tests**: `npx vitest run` con **cwd = `apps/backend`**; frontend
   `npm --prefix apps/frontend run test` (Karma/ChromeHeadless).
6. **Añadir/actualizar tests reales** para todo el comportamiento nuevo; los tests deben ejecutarse y
   pasar. Un test que no corrió no está en verde.
7. **Seguridad (no negociable)**: autorización antes que disponibilidad; nunca exponer URLs de fuentes
   sin autorización, credenciales, metadatos privados de proveedor ni `clauseUrl`; errores genéricos;
   nada de `console.log` con secretos; SSRF: solo `fetchWithPolicy` de `infrastructure/egress.ts`.
8. **EPG independiente de TDTChannels**: no añadir dependencia de runtime con TDTChannels, iptv-org ni
   Free-TV. XMLTV propio + fuentes compatibles. **Nunca fabricar programación** si no hay datos.
9. **Migraciones**: son ficheros numerados en `apps/backend/src/migrations/` ejecutados por
   `runner.ts`; idempotentes, con `down` real, añadidas al ledger. Nunca borres datos existentes.
10. **Reporta al capitán** (por mensaje) con un brief compacto: ficheros cambiados, comandos ejecutados
    con exit code real, resultados, decisiones, riesgos. Nada de razonamiento largo.
11. **Commit** en tu rama con mensaje `feat(tdt02fg-<tuyo>): …` cuando el trabajo esté verde. No hagas
    merge ni push.

## 2. Cadena de dependencias (para que nadie bloquee a nadie)

```
t5 EPG  ────────────────► t6 API ────────────────► t8 integración/perf
                                    ▲
t7A admin backend ──────────────────┘
t7B admin UI ── (depende de t7A por contrato, no por ficheros)
```

La **primera entrega del contrato de contratos** la hace el capitán en tu worktree antes de que empieces
si está marcada `[contrato capitán]`.

## 3. Contrato API v1 — rutas nuevas (t6 implementa; t5 y t7A consumen)

Prefijo constante `/api/v1`. Envelope: como el resto (`{data, pagination?}`, `attribution` donde ya existe).

| Método | Ruta | Propósito | Quién |
|---|---|---|---|
| GET | `/api/v1/countries` | países con `code`, `name`, `channelCount`, `playableCount`, `regionCount` | t6 |
| GET | `/api/v1/countries/:code/regions` | regiones de un país con recuentos | t6 |
| GET | `/api/v1/languages` | idiomas canónicos con recuentos | t6 |
| GET | `/api/v1/channels` | **extendida**: filtros `country`, `region`, `language`, `category`, `q`, `playable`, `sort`, `page`, `pageSize` (compatibles al 100%) | t6 |
| GET | `/api/v1/channels/:slug` | **sin cambio de forma**, puede añadir campos opcionales | t6 |
| GET | `/api/v1/channels/:slug/epg` | EPG diaria completa (`?date=YYYY-MM-DD` en la zona del canal, o `?from=`/`hours=`) | t6 (consume t5) |
| GET | `/api/v1/channels/:slug/availability` | disponibilidad pública agregada (sin URLs) | t6 |
| GET | `/api/v1/epg/now` , `/api/v1/epg/next` | **sin cambio de forma** | existente |
| GET | `/api/v1/epg/channels` | cobertura EPG por canal publicada (`mapped`, `status`) | t5 expone servicio, t6 ruta |

Reglas de rutas: URLs semánticas legibles; **ninguna ruta pública con identificadores técnicos** salvo
`/channels/:slug` (slug semántico, ya existente). Paginación con el `pagination` existente
(`page,pageSize,total,pageCount,hasNext,hasPrevious`). Orden por defecto estable y documentado.

## 4. Contrato EPG (t5) — lo que t6 puede dar por cierto

### 4.1 Modelo de datos (colecciones existentes, campos **nuevos opcionales**)

`epg_sources` (existente) gana: `country: string|null`, `language: string|null`,
`timezone: string|null`, `fetchIntervalMinutes: number`, `lastSuccessAt: Date|null`,
`consecutiveFailures: number`, `nextRunAt: Date|null`, `httpEtag: string|null`,
`httpLastModified: string|null`.

`programmes` (existente) gana: `originalStart: Date` (instante antes de normalizar, para auditoría),
`timezone: string` (zona de origen del dato), `duplicateOf: string|null` (id del programa que gana
cuando se detecta duplicado), `stale: boolean` (fuera de la ventana esperada de la fuente).

`epg_mappings` (existente, ya en `catalogue/schema.ts` como `EpgMappingDoc`) es la **tabla canónica**
canal↔fuente; `status: proposed|confirmed|rejected`. El alias `aliases.namespace='epg'` **sigue siendo
válido** para compatibilidad, pero la lectura canónica pasa por `epg_mappings`.

Nueva colección `epg_sync_runs` (nueva): `_id`, `sourceId`, `startedAt`, `finishedAt`, `status`
(`ok|failed`), `programmes`, `channelsMatched`, `rejected`, `duplicates`, `error`, `trigger`
(`scheduled|manual|incremental`).

### 4.2 Servicio (backend, t5) — métodos que t6 y t7A consumen

```ts
// apps/backend/src/modules/epg/epg.service.ts  (o ficheros nuevos del módulo epg)
interface EpgChannelCoverage { channelId: string; slug: string; name: string; country: string;
  mapped: boolean; sourceId: string|null; availability: ScheduleAvailability;
  programmes: number; lastProgrammeEnd: Date|null; staleAfter: Date|null; }
```

- `scheduleFor(channel, from, hours)` — **sin cambio de firma** (t6 lo reutiliza para `/epg`).
- `coverage(): Promise<EpgChannelCoverage[]>` — por canal publicado.
- `mappingsFor(channelId)` / `confirmMapping(mappingId, actor)` / `rejectMapping(mappingId, actor)` /
  `proposeMapping(input, actor)` — escrituras **auditadas** en `audit_log`.
- Todo lo demás de t5 (ingesta XMLTV, dedup, normalización de zona, DST, incremental, clasificación
  faltante/caducado) vive en el módulo `epg`.

## 5. Contrato de administración (t7A backend ←→ t7B UI)

Prefijo `/api/v1/admin/…`, guard `requireEditor`/`requireAdmin` existente, auditoría en `audit_log`.
**Ninguna ruta devuelve `clauseUrl`, credenciales ni URLs de fuentes no autorizadas.**

| Método | Ruta | Respuesta (campos mínimos) | t7B consume |
|---|---|---|---|
| GET | `/admin/overview` | `channels{total,published,review,withdrawn}`, `countries[]`, `languages[]`, `sources{total,healthy,failing,unverified}`, `epg{sources,mappedChannels,missingChannels,staleChannels}`, `jobs{pending,running,failed}` | Sí |
| GET | `/admin/catalogue` | canales con `id,slug,name,country,regionCode,language,category,editorialStatus,sourceCandidates,playable` + `pagination` + filtros `q,country,language,category,status` | Sí |
| GET | `/admin/catalogue/:id` | detalle: identidad editable, alias, fuentes candidatas con `eligibility` resumida, duplicados propuestos | Sí |
| POST | `/admin/catalogue/:id/identity` | edición de identidad (name/shortName/country/region/language/category) con `reason` | Sí |
| GET | `/admin/duplicates` | grupos de duplicados detectados (por alias/nombre/url) | Sí |
| POST | `/admin/duplicates/:id/merge` | fusión (reutiliza `editorial.mergeChannels`) | Sí |
| GET | `/admin/sources/health` | salud por fuente: `channelId,provider,type,permission,technicalStatus,lastVerifiedAt,consecutiveFailures,eligibility,failureClass` + filtros | Sí |
| GET | `/admin/sources/:id/history` | historial de verificaciones (anillo de `source_health`) | Sí |
| POST | `/admin/sources/:id/verify` | reintento manual (ya existe) | Sí |
| POST | `/admin/sources/:id/assign` | asignar fuente a canal | Sí |
| POST | `/admin/sources/:id/remove` | retirar fuente (con `reason`) | Sí |
| GET | `/admin/epg/coverage` | cobertura por país/canal, fuentes, `missing`, `stale`, conflictos de mapeo | Sí |
| GET | `/admin/epg/mappings` | mappings con estado y conflictos | Sí |
| POST | `/admin/epg/mappings/:id/confirm` / `/reject` | corrección manual | Sí |
| POST | `/admin/epg/mappings` | mapping manual `{channelId, sourceId, externalId, namespace}` | Sí |
| GET | `/admin/epg/ingestion-runs` | `epg_sync_runs` con fallos | Sí |
| POST | `/admin/epg/ingest` | ingesta manual (ya existe, `requireAdmin`) | Sí |
| GET | `/admin/operations/jobs` | trabajos con estado y último error | Sí |
| POST | `/admin/operations/jobs/:name/pause` / `/resume` | pausa/reanudación real | Sí |
| GET | `/admin/operations/errors` | errores operativos agregados | Sí |
| GET | `/admin/operations/metrics` | métricas de peticiones y reproducción | Sí |

Cada endpoint de escritura **ejecuta la operación real** (no simula) y registra auditoría.
t7B **no** inventa datos: si un endpoint no está disponible, muestra el error real.

## 6. Contrato de contratos (packages/contracts) — firmas que t7B y t6 asumen

`[contrato capitán]`: el capitán publica en la base común los nuevos esquemas zod con los **nombres**
siguientes; cada especialista **puede ampliarlos con campos opcionales** en ficheros nuevos, no renombrarlos.

```ts
// packages/contracts/src/admin.ts (extensión)
adminOverviewSchema, adminCatalogueResponseSchema, adminSourceHealthSchema,
adminSourceHistorySchema, adminEpgCoverageSchema, adminMappingSchema,
adminOperationsSchema, identityEditInputSchema, assignSourceInputSchema
// packages/contracts/src/epg.ts (extensión)
epgCoverageSchema, epgCoverageEntrySchema, epgSyncRunSchema, mappingInputSchema
// packages/contracts/src/channels.ts (extensión)
countriesResponseSchema, languagesResponseSchema, channelAvailabilitySchema
```

Si un nombre hace falta y no existe, se **añade** (no se reemplaza) y se avisa al capitán.

## 7. Propiedad de ficheros

`[compartido]` = no editar sin el capitán. Todo lo no listado en tu bloque: si hace falta, pídemelo.

### t5 — EPG internacional (`epg-international-engineer`, worktree `wt/02fg-epg`)
- `apps/backend/src/modules/epg/**` (nuevos y existentes del módulo)
- `apps/backend/src/migrations/00[7-9]-*.ts`, `apps/backend/src/migrations/010-*.ts`
- `packages/contracts/src/epg.ts` (extensión aditiva)
- `apps/backend/src/infrastructure/schema.ts` `[compartido]` — solo añadir campos opcionales; avisa.
- `apps/backend/src/catalogue/schema.ts` `[compartido]` — solo añadir índices nuevos; avisa.
- `apps/backend/src/server/context.ts` `[compartido]` — solo cableado del módulo EPG; avisa.
- `apps/backend/src/server/schemas.ts` `[compartido]` — solo esquemas EPG.
- tests en `apps/backend/src/modules/epg/*.spec.ts` y `apps/backend/scripts/*epg*`
- **No** toca: `apps/backend/src/server/routes.ts`, frontend, `packages/api-client`.

### t6 — API pública internacional (`public-api-engineer`, worktree `wt/02fg-api`)
- `apps/backend/src/modules/channels/**`
- `apps/backend/src/server/routes.ts` `[compartido]` — **solo** rutas públicas (sin `/admin`).
- `apps/backend/src/server/schemas.ts` `[compartido]` — solo esquemas de canales/países/idiomas.
- `packages/contracts/src/channels.ts`, `packages/contracts/src/common.ts` (aditivo)
- `apps/backend/src/server/openapi.ts`, `openapi/openapi.json`
- `packages/api-client/**` (generado + tests)
- tests: `apps/backend/src/modules/channels/*.spec.ts`, `apps/backend/src/server/*.spec.ts`

### t7A — Administración backend (`admin-ux-engineer`, worktree `wt/02fg-admin`)
- `apps/backend/src/modules/admin/**` (nuevos + existentes)
- `apps/backend/src/server/routes.ts` `[compartido]` — **solo** bloque `/admin` (orden con t6: t6
  añade las suyas arriba, t7A añade las suyas después; integración final resuelve).
- `packages/contracts/src/admin.ts`
- `apps/backend/src/jobs/**` (estado de trabajos, pausa/reanudación)
- tests en `apps/backend/src/modules/admin/*.spec.ts`

### t7B — UI de administración (`admin-ui-engineer`, worktree `wt/02fg-ui`)
- `apps/frontend/src/app/features/admin/**` (nuevo)
- `apps/frontend/src/app/core/admin/**` (nuevo: servicios HTTP + estado)
- `apps/frontend/src/app/app.routes.ts` `[compartido]` — solo añadir la ruta `admin` (lazy).
- `apps/frontend/src/app/app.html` / `app.css` `[compartido]` — solo el enlace de entrada.
- `apps/frontend/src/styles/tokens.css` (aditivo)
- tests Karma en `apps/frontend/src/app/features/admin/*.spec.ts`

### t8 — Integración y rendimiento (`integration-performance-engineer`, worktree `wt/02fg-integration`)
- `apps/frontend/src/app/features/watch/**`, `apps/frontend/src/app/features/catalogue/**`
  (solo lo necesario para conectar con la API final), `apps/frontend/src/app/core/api/**`
- `apps/backend/src/infrastructure/**` (índices, caché), `apps/backend/src/server/context.ts` `[compartido]`
- `apps/backend/scripts/load-test.mjs`, `apps/backend/scripts/browser-playback-check.mjs`
- `plan-doc`: `docs/tdt-api02/02fg/PERF.md` (nuevo, tuyo)
- **No** toca: módulos epg/admin de otros.

## 8. Skills y herramientas recomendadas

- `ponytail` (cambios mínimos completos) en todo el trabajo.
- `ui-ux-pro-max` + `accessibility` + `web-design-guidelines` para t7B.
- `performance` para t8.
- REA MCP (`mcp__rea__*`): solo lectura/observación del reproductor y del frontend ya construidos; no
  redisculpar lo hecho en 02A–02E; nunca evadir autenticación, DRM ni geobloqueo. Ejecuta
  `skill('reverse-engineer-anything')` antes de usarlo.
- Si el especialista no tiene esas herramientas en su catálogo, lo declara y usa la alternativa nativa.
