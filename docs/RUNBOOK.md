# TDT Platform — running the platform

This document lets a third party reproduce the deployment from an empty machine.

## 1. Requirements

| Tool | Version | Why |
| --- | --- | --- |
| Node.js | 24 or newer | Backend and build tooling (the repo pins `engines.node >= 24`) |
| npm | 11 or newer | Workspaces |
| Docker | any recent | Local MongoDB replica set and Redis |

No third-party data feed is required to run the platform. The catalogue import
reads a file you supply; the guide import reads a file you supply.

## 2. Development mode

```bash
npm run dev:backend     # http://127.0.0.1:4010, restarts on source changes
npm run dev:frontend    # Angular dev server on :4200
```

`dev:backend` runs `src/server/dev.ts` directly with Node's type stripping: no
build step is required, and the process restarts on every change under
`apps/backend/src`. It is development only — `npm start` and every production
path run the compiled `dist/`.

If you see `ExperimentalWarning: Transform Types`, it is expected: TypeScript
parameter properties need it, and it is the reason the script passes
`--experimental-transform-types`.

## 3. First start

```bash
git clone <repository> tdt-api01 && cd tdt-api01

# 1. Infrastructure: MongoDB (replica set) on 127.0.0.1:27117, Redis on 27118
docker compose -f infra/docker-compose.yml up -d

# 2. Dependencies and build
npm install
npm run build --workspace @tdt/contracts
npm run build --workspace @tdt/api-client
npm run build --workspace @tdt/backend

# 3. Configuration
cp apps/backend/.env.example apps/backend/.env
# edit apps/backend/.env if your ports differ

# 4. Schema (idempotent) and the editorial guide source
node apps/backend/dist/migrations/run.js

# 5. Optionally: a catalogue and a guide
node apps/backend/dist/scripts/import-catalogue.js --file /path/to/tv.json \
     --report audits/catalogue-import-report.json
node apps/backend/dist/scripts/import-guide.js --file /path/to/TV.epg.json \
     --source-name "Guía de referencia" --kind json-tdtchannels \
     --licence Apache-2.0

# 6. Serve
node apps/backend/dist/server/main.js        # http://127.0.0.1:4010/api/v1/health
```

The replica set advertises `127.0.0.1:27117`, so a host client connects through
the published port. Do not change that address to the container name: outside the
compose network the name does not resolve.

## 4. First administrator

The administrative API is never reachable with a key shipped to a browser. The
first account is created once, from a token that exists only in the environment:

```bash
export ADMIN_BOOTSTRAP_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
export ADMIN_BOOTSTRAP_EMAIL=editor@example.invalid
node apps/backend/dist/server/main.js &

curl -s -X POST http://127.0.0.1:4010/api/v1/auth/bootstrap \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$ADMIN_BOOTSTRAP_EMAIL\",\"password\":\"<12+ chars>\",\"bootstrapToken\":\"$ADMIN_BOOTSTRAP_TOKEN\",\"roles\":[\"admin\"]}"

# then unset both variables: the endpoint refuses a second bootstrap
```

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:4010/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"editor@example.invalid","password":"<same password>"}' | jq -r .data.token)
```

## 5. Frontend

```bash
cd apps/frontend
npm install
npx ng build --configuration production
node scripts/serve-dist.mjs         # serves dist/ and proxies /api to :4010
```

The build requests `/api/v1` on its own origin. Set `TDT_API_BASE_URL` at build
time to point a build at an absolute API instead.

## 6. Verification commands

| Command | What it proves |
| --- | --- |
| `npm run typecheck` | Every package compiles under TypeScript strict |
| `npm test --workspace @tdt/backend` | 49 unit + 73 integration + 15 independence tests |
| `npm test --workspace @tdt/api-client` | 14 SDK tests |
| `cd apps/frontend && npx ng test --watch=false` | 318 client unit tests |
| `cd apps/frontend && npx playwright test` | 75 end-to-end tests, including the real-backend suite |
| `node apps/backend/dist/scripts/bootstrap-audit.js --snapshot … --guide …` | The platform boots from an empty database |
| `node apps/backend/scripts/load-test.mjs` | Latency and error budgets |
| `node apps/backend/dist/scripts/export-openapi.js` | The OpenAPI 3.1 document |
| `node scripts/audit-tdt-api-01.mjs` | The independent acceptance audit |

`npm run audit:bootstrap`, `npm run openapi:export` and `npm run test:load` are
the short forms once the backend is built.

## 7. Configuration reference

All values are read from `apps/backend/.env` or the process environment; the
process environment wins.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4010` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `MONGODB_URI` | `mongodb://127.0.0.1:27117/?replicaSet=rs0` | Database |
| `MONGODB_DB` | `tdt_platform` | Database name |
| `REDIS_URL` | unset | Optional cache; unset means the cache is disabled, never broken |
| `CORS_ORIGINS` | local dev origins | Browser origins allowed to call the API |
| `RATE_LIMIT_WINDOW_SECONDS` / `RATE_LIMIT_MAX_REQUESTS` | `60` / `300` | Per-client budget |
| `CACHE_TTL_SECONDS` | `60` | `Cache-Control` max-age and the response cache window |
| `ADMIN_BOOTSTRAP_TOKEN` | unset | One-shot first-administrator token |
| `JOBS_ENABLED` | `false` | Scheduled guide refresh and source verification |
| `EGRESS_GUARD_ENABLED` / `BLOCKED_EGRESS_HOSTS` | `false` / empty | Blocks outbound hosts (used by the independence test) |
| `YOUTUBE_API_KEY` | unset | Optional: resolves a `/channel/<id>/live` page to its current video |

## 8. Operations

- **Health**: `GET /api/v1/health` reports the database, the cache and the real
  record counts; it answers `503` when the database is unreachable.
- **Metrics**: `GET /metrics` (Prometheus text). Labels are route patterns, never
  raw paths.
- **Logs**: one JSON object per line; `x-request-id` correlates a log line with
  the error body a client received.
- **Migrations**: `node dist/migrations/run.js` applies pending steps and reports
  the ledger; it is safe to run on every deploy.
- **Backups**: any MongoDB snapshot covers the whole platform. There is no
  derived state that a restore would have to rebuild.
