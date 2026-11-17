<!-- markdownlint-disable -->
# Complemento del contrato 02FG — contratos publicados en la base del milestone

El capitán ha publicado en `packages/contracts` (base del milestone, `feat/tdt-api02-fg-final-integration`)
los esquemas compartidos del §6 de `INTERFACE-CONTRACT-02FG.md`, y ha añadido
`EpgService.coverage()` como **única** medida de cobertura compartida.

**Regla**: si el esquema que necesitas ya existe aquí, **úsalo**; no lo redefinas. Si falta algo,
añádelo de forma aditiva en tu propio fichero y avisa al capitán.

## 1. Ficheros publicados

| Fichero | Contenido |
|---|---|
| `packages/contracts/src/discovery.ts` | `countryEntrySchema`, `countryListResponseSchema`, `languageEntrySchema`, `languageListResponseSchema`, `channelAvailabilitySchema`, `channelAvailabilityResponseSchema`, `discoveryAxesSchema` |
| `packages/contracts/src/epg-operations.ts` | `epgCoverageStatusSchema` (`fresh\|stale\|empty\|not-mapped`), `epgCoverageEntrySchema`, `epgCoverageSchema`, `epgMappingSchema`, `epgMappingStatusSchema`, `epgMappingInputSchema`, `epgMappingListResponseSchema`, `epgSyncRunSchema`, `epgSyncRunListResponseSchema` |
| `packages/contracts/src/admin-operations.ts` | `adminOverviewSchema`, `adminCatalogueRowSchema`, `adminCatalogueQuerySchema`, `adminCatalogueResponseSchema`, `adminIdentityInputSchema`, `adminChannelDetailSchema`, `adminDuplicateGroupSchema`, `adminDuplicateListResponseSchema`, `adminMergeInputSchema`, `adminSourceHealthRowSchema`, `adminSourceHealthQuerySchema`, `adminSourceFailureClassSchema`, `adminSourceHistoryEntrySchema`, `adminSourceHistoryResponseSchema`, `adminSourceAssignInputSchema`, `adminSourceRemoveInputSchema`, `adminEpgCoverageResponseSchema`, `adminMappingRowSchema`, `adminMappingListResponseSchema`, `adminMappingDecisionInputSchema`, `adminIngestionRunListResponseSchema`, `adminJobRowSchema`, `adminJobListResponseSchema`, `adminOperationErrorSchema`, `adminOperationErrorListResponseSchema`, `adminMetricsSchema`, `adminMetricsResponseSchema`, `adminJobControlInputSchema` |

Todos se exportan desde `@tdt/contracts` (`src/index.ts`).

## 2. `EpgService.coverage()` — ya existe en la base

```ts
async coverage(options?: { staleAfterMs?: number; now?: Date; lookbackMs?: number }): Promise<{
  entries: EpgCoverageEntry[];
  totals: { channels: number; mapped: number; fresh: number; stale: number; empty: number; notMapped: number };
  asOf: string;
}>
```

Regla de clasificación implementada (dos consultas, no un bucle por canal):
`not-mapped` sin `epg.sourceId`; `empty` mapeado sin programas en la ventana;
`fresh` si hay programas que terminan después de `now` **y** el último `updatedAt` cae dentro de
`staleAfterMs` (por defecto 24 h); `stale` en otro caso. **No inventa programación.**

- **t5**: puedes ampliarla/perfeccionarla dentro de `apps/backend/src/modules/epg/**` (dedup,
  clasificación por fuente, DST), pero **conserva esta firma y estos estados**.
- **t6**: `/epg/channels` y `availability.epg` se alimentan de `context.epg.coverage()`.
- **t7A**: `/admin/epg/coverage` usa `context.epg.coverage()`; no implementes una segunda medida.

## 3. Vocabulario de datos medido en la base viva (`tdt_platform`)

- `languageTag` en el mundo real es `es` (294 publicados) y **`multi`** (118 internacionales).
  `multi` **no** es un BCP-47 válido para `localeCodeSchema`: no lo metas en un campo tipado
  `localeCodeSchema` ni lo rompas con un regex; para contar/agrupar usa `z.string()` en los
  contratos operativos (ya hecho) y documenta la normalización.
- El país de los internacionales es literalmente `INT` (no ISO-3166): los contratos operativos
  ya aceptan `z.string().min(2).max(3)`.
- 117 canales publicados tienen `epg.sourceId` (no 144: el alias no es la tabla canónica).
- `programmes` está **caducado** en la base viva: máximo `start` 2026-11-16, hoy 2026-11-17.

## 4. Estado de partida (medido por el capitán en la base del milestone)

`build` 0, `typecheck` 0, unit 572, integration 181, ingestion 9/9, independence 15, client 14,
frontend build 0, frontend unit 353. No lo rompas: es la línea base contra la que se mide tu entrega.
