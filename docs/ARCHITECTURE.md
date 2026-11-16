# TDT Platform — architecture

TDT Platform is an owned data platform for television metadata, playback sources
and programme guides. Its public surface is a versioned REST API; the Angular
client in this repository is its first consumer, and GuíaTV is the intended
second one.

## 1. Why this shape

The previous client fetched a third-party catalogue (`tv.json`), a third-party
guide and a third-party player, in the browser, at runtime. Three consequences
followed from that, and the architecture address them one by one:

| Consequence | Answer in this repository |
| --- | --- |
| Availability of the product depended on someone else's servers | The catalogue, the sources and the guide live in **our** MongoDB; no runtime request to a third-party data provider exists in the client |
| Nothing could be audited or corrected | Every record carries provenance; every mutation is audited; sources carry an explicit permission and conditions |
| A consumer (GuíaTV) would have had to parse a foreign format | A versioned API with shared Zod contracts, an OpenAPI 3.1 document and a TypeScript SDK |

## 2. Components

```
apps/
  backend/          Express 5 + TypeScript strict, MongoDB, optional Redis
    src/modules/    channels · playback · providers · epg · admin · health
    src/jobs/       catalogue import · migration · EPG scheduler
    src/migrations/ schema migrations and their ledger
    src/server/     app factory, routes, OpenAPI, middleware
  frontend/         the Angular 22 client (migrated, not rewritten)
packages/
  contracts/        the single source of truth for every payload (Zod)
  api-client/       the SDK: typed client + GuiaTV adapter + generated types
infra/              docker-compose for MongoDB (replica set) and Redis
openapi/            the exported OpenAPI 3.1 document
docs/               this documentation
audits/             reports produced by the audit commands
```

## 3. Request path

```
client (browser or SSR/server-to-server)
   │  @tdt/api-client (ETag, timeouts, structured errors)
   ▼
Express app (server/app.ts)
   │  request id → helmet → CORS allowlist → body limit → metrics
   │  → Cache-Control/ETag → response cache → router
   ▼
route handler (server/routes.ts)
   │  Zod validation against @tdt/contracts
   ▼
service (modules/*)
   │  publication policy · editorial rules · EPG normalisation
   ▼
MongoDB (source of truth)     Redis (optional cache, never authoritative)
```

The database is the only authority for a payload: the in-process response cache
serves an identical byte string and is cleared by every successful write.

## 4. Data model

Five collections carry the platform (full field reference: `DATA-MODEL.md`):

| Collection | Purpose |
| --- | --- |
| `channels` | The canonical catalogue: identity, editorial metadata, provenance, aliases |
| `playback_sources` | Every integration we know about, with permission, conditions and health |
| `programmes` | The independent guide, keyed by channel + upstream event |
| `epg_sources` | Where a guide comes from, with its licence and attribution |
| `audit_log` | Every editorial and authentication action |

Two model decisions carry most of the milestone's guarantees:

1. **Identity is ours.** A channel has a UUID (`_id`) that never appears in a
   URL and a public `slug` that does. Aliases in namespaces (`legacy-tdt`, `epg`,
   `guiatv`, `merged-from`) keep every external identity findable without it
   becoming the primary key.
2. **Permission is a property of the source, not of the channel.** A channel is
   playable because one of its sources may be exposed *and* is healthy; those are
   two separate facts and the API never merges them.

## 5. The publication policy

`modules/playback/publication-policy.ts` is the only place that decides whether a
source may appear publicly. The decision order is fixed:

1. the owning channel must be `published` (else `channel-withdrawn`);
2. the source must be `published` (draft/review/withdrawn are never public);
3. the permission must allow exposure (an `unlicensed` source never is);
4. a source that needs a forged header or the emitter's own application is
   refused;
5. a source marked `blocked` by verification is refused.

Only then does **health** decide between `available` and `degraded`. A healthy
but unlicensed source is still hidden; an unhealthy but licensed source is
reported, not hidden — the difference is what makes the API honest.

## 6. Providers

Each integration kind has its own adapter (`modules/providers/providers.registry.ts`):

| Adapter | Type | What it verifies |
| --- | --- | --- |
| `emitter-hls` | `hls` | fetches the playlist, requires `#EXTM3U` |
| `emitter-dash` | `dash` | fetches the manifest, requires `<MPD>` |
| `youtube-iframe` | `youtube` | requires a public identifier; liveness is delegated to the official player / Data API |
| `official-embed` | `official-embed` | requires the emitter's public player page |
| `external-reference` | `external` | requires the emitter's page; never probed |

There is deliberately no single "catalogue" provider. Emitter decisions live in
`modules/providers/emitters.ts`, which records the basis for each one (public
broadcaster, operator-published, platform embed, reference-only, or unreviewed).

## 7. Frontend

The Angular client keeps its UI, its player controller and its three engines
(HLS via hls.js, DASH via dash.js, YouTube via the official IFrame API). Only the
data source changed:

```
components → CatalogStore / CatalogueQuery → ChannelsApiService
                                          → PlaybackApiService
                                          → EpgApiService
                                          → ApiGateway (one SDK client)
```

`core/data/api-mappers.ts` converts API descriptors into the `Channel` /
`MediaSource` model the engines already consume, so the playback stack is
untouched. The remote third-party adapters and the third-party catalogue parsers
were deleted rather than kept as fallbacks: a fallback to foreign data would
reintroduce the dependency this milestone removes.

## 8. Deployment topology

```
browser ──► static host ──(same origin /api/v1)──► backend ──► MongoDB
                                                             └► Redis (optional)
GuíaTV server ──(server-to-server /api/v1)────────────────────┘
```

The client calls a same-origin `/api/v1` by default; the E2E server proxies that
path to the backend, which is the topology the API is designed for. A consumer
that cannot use a same-origin path passes an absolute base URL to the SDK.
