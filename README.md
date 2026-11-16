# TDT Platform

An owned data platform for television metadata, playback sources and programme
guides, with a versioned REST API (`/api/v1`), a shared contract package, a
TypeScript SDK and an Angular client that consumes it.

The platform is the source of truth for its catalogue: it does not read a
third-party catalogue, guide or player at runtime.

## Quick start

```bash
docker compose -f infra/docker-compose.yml up -d     # MongoDB (replica set) + Redis
npm install
npm run build
npm run migrate                                      # idempotent schema + editorial guide source

npm run import:catalogue -- --file /path/to/tv.json  # operator-supplied snapshot
npm run import:guide -- --file /path/to/TV.epg.json --licence Apache-2.0

node apps/backend/dist/server/main.js                # http://127.0.0.1:4010/api/v1/health
```

Full instructions, including the first administrator and the frontend build:
[`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Documentation

| Document | Content |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Components, request path, publication policy, providers |
| [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) | Every collection, field and index |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Reproducible deployment, configuration, verification commands |
| [`docs/PROVENANCE-AND-LICENCES.md`](docs/PROVENANCE-AND-LICENCES.md) | Where every class of data comes from and what may be done with it |
| [`docs/GUIATV-INTEGRATION.md`](docs/GUIATV-INTEGRATION.md) | How GuíaTV consumes the API without creating duplicate identities |
| [`docs/DELIVERY-REPORT-TDT-API-01.md`](docs/DELIVERY-REPORT-TDT-API-01.md) | Milestone report, test results and the GO/NO-GO verdict |
| [`openapi/openapi.json`](openapi/openapi.json) | OpenAPI 3.1 document |

## Commands

| Command | What it does |
| --- | --- |
| `npm run build` | Builds contracts, SDK and backend |
| `npm run typecheck` | TypeScript strict across every package |
| `npm test` | Backend (unit, integration, independence) and SDK tests |
| `npm run test:frontend` | 318 client unit tests |
| `npm run test:e2e` | 75 Playwright tests, including the real-backend suite |
| `npm run test:load` | Latency and error budgets |
| `npm run openapi:export` | Regenerates the OpenAPI document |
| `npm run client:generate` | Regenerates the SDK's wire types |
| `npm run audit:bootstrap` | Boots the platform from an empty database and checks it |
| `npm run audit:acceptance` | Independent acceptance audit for TDT-API-01 |

## What the platform guarantees

- A public channel always has provenance, and third-party data always carries
  its attribution.
- A source is exposed only when a recorded permission and its conditions allow
  it; availability never overrides authorisation.
- A channel without a guide says so; no emission is ever invented.
- The API is versioned, documented, validated against shared schemas, and
  consumable server-to-server without exposing a secret to a browser.
- No runtime request is made to the third-party data provider; with every one of
  its hosts blocked, the platform keeps working.

## Licence

Not yet declared. The code is the property of its author; deciding the licence is
a precondition for publication.
