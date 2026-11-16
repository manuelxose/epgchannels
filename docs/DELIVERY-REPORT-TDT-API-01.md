# TDT-API-01 — Final delivery report

**Milestone:** transform TDT Player into an independent platform with its own
data, its own playback-source registry, its own guide and its own versioned API.
**Repository:** `tdt-api01` (new checkout; `tdt-player-rebuild` was copied, never
modified).
**Status:** implemented, tested and audited. **Global verdict: GO** (see §11).
**Not deployed to production** — deployment requires explicit approval.

---

## 1. Architecture implemented

```
tdt-api01/
├── apps/
│   ├── backend/     Express 5 · TypeScript strict · MongoDB · optional Redis
│   │   └── src/
│   │       ├── modules/   channels · playback · providers · epg · admin · health
│   │       ├── jobs/      catalogue import · migration · EPG/verification scheduler
│   │       ├── migrations/ schema migrations + ledger
│   │       └── server/    app factory · routes · OpenAPI · middleware
│   └── frontend/    Angular 22 client (migrated, not rewritten)
├── packages/
│   ├── contracts/   every payload as a Zod schema (the single source of truth)
│   └── api-client/  the SDK + GuiaTvPlaybackAdapter + generated types
├── infra/           docker-compose: MongoDB replica set + Redis
├── openapi/         exported OpenAPI 3.1 document
├── docs/            architecture, data model, runbook, provenance, integration
└── audits/          machine-readable evidence produced by the audit commands
```

Key decisions:

- **One publication policy.** `modules/playback/publication-policy.ts` decides
  whether a source may be exposed. Authorisation is evaluated before health, so a
  healthy but unlicensed source is hidden and an unhealthy but licensed source is
  reported.
- **Provenance is mandatory.** A channel cannot be created without provenance; a
  non-editorial provenance entry must carry its attribution.
- **No provider monolith.** Five adapters (emitter HLS, emitter DASH, YouTube
  IFrame, official embed, external) plus an emitter decision table; unreviewed
  emitters are stored but never published.
- **The client knows one origin.** `@tdt/api-client` is the only HTTP path; the
  third-party adapters and parsers were deleted rather than kept as fallbacks.

## 2. Code and commits

| Commit | Milestone | Content |
| --- | --- | --- |
| `bc2f1fe` | API-01A/B/C | Monorepo, contracts, MongoDB layer, canonical catalogue, source registry, publication policy, provider adapters, admin auth, editorial service, public API |
| `17dc875` | API-01D/E/G | Independent EPG (XMLTV + JSON), OpenAPI 3.1, SDK and GuiaTV adapter, generated types |
| `5e8d9d1` | API-01F | Angular client migrated to our API; engines untouched |
| `e46c7f5` | API-01H | Test harness: 49 unit, 73 integration |
| `5418c1c` | API-01H | Independence suite, SDK tests, response cache, load evidence |
| `56e5412` | API-01F/H | E2E on our contract: 75 Playwright tests, real-backend suite, bootstrap audit |

Plus two hygiene commits removing build artefacts from tracking.

## 3. Functional endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/health` | Database, cache, real record counts; 503 when the database is down |
| GET | `/api/v1/channels` | Paged (≤100), `q`, `country`, `region`, `category`, `language`, `playable`, `sort` |
| GET | `/api/v1/channels/:slug` | Canonical record with provenance and aliases |
| GET | `/api/v1/channels/:slug/playback` | Typed descriptor: `available`/`degraded`/`external`/`eventual`/`unavailable` |
| GET | `/api/v1/channels/:slug/schedule` | Window, now, next, provenance, honest availability |
| GET | `/api/v1/epg/now`, `/api/v1/epg/next` | Bounded feeds |
| GET | `/api/v1/categories`, `/api/v1/regions` | Taxonomy with live counts |
| GET | `/api/v1/integration/manifest` | Capabilities and slug policy for consumers |
| GET | `/api/v1/integration/guiatv/channels` | GuíaTV catalogue |
| GET | `/api/v1/integration/guiatv/identity-map` | Identifier cross-reference table |
| POST | `/api/v1/auth/bootstrap`, `/auth/login`, `/auth/logout` | First admin, session, revocation |
| GET/POST/PATCH | `/api/v1/admin/channels…` | List, read, create, update, merge, revert |
| GET/POST/PATCH | `/api/v1/admin/sources…` | List, create, update, withdraw, verify |
| GET | `/api/v1/admin/audits`, `/admin/providers`, `/admin/epg-sources`, `/admin/jobs` | Operations |
| POST | `/api/v1/admin/epg/ingest`, `/admin/epg/programmes` | Guide ingestion and editorial programmes |
| GET | `/metrics` | Prometheus text, route-pattern labels only |

Every public response carries `Cache-Control` and a weak `ETag`; `If-None-Match`
yields `304`. Errors use one envelope (`{ error: { code, message, details? },
requestId }`) with field-level details for validation failures.

## 4. Data schema

Five collections (`docs/DATA-MODEL.md`): `channels`, `playback_sources`,
`programmes`, `epg_sources`, `audit_log`, plus `admin_users`,
`admin_sessions`, `job_runs` and `migration_ledger`.

Identity: internal UUID (`_id`) + public slug. Aliases in namespaces
(`legacy-tdt`, `epg`, `guiatv`, `merged-from`) keep external identities
findable without becoming the primary key.

Operational note found during implementation: MongoDB reserves `language` as a
text-index option, so the stored field is `languageTag` (the API still exposes
`language`).

## 5. Migration status

Source snapshot: `f1ceaef3f9ffd313…` (515 062 bytes, Apache-2.0, supplied by the
operator). Run twice: the second run created nothing and updated 768 records —
the import is idempotent.

| | Count |
| --- | ---: |
| Channel records in the snapshot | 768 |
| Channels stored in our database | 768 |
| Published (have at least one publishable source) | 412 |
| In review (stored, not published: no reviewed emitter) | 356 |
| Sources extracted | 1 364 |
| Sources publicly exposed | 473 |
| Sources withheld, with a recorded reason | 891 |
| Published-slug collisions | 0 |

Withheld sources, by reason: `unlicensed` 891 (all for emitters with no recorded
decision), plus per-URL reasons recorded in the ledger: `emitter-app-only` 31,
`credentials-required` 12, `requires-forged-header` 7.

Nothing was dropped silently: every excluded record is in
`audits/catalogue-import-report.json` and in the `migration_ledger` document.

**Guide:** 11 123 programmes ingested from the operator-supplied snapshot
(11 112 stored after normalisation), for 176 channels; 1 upstream id
(`ETBSAT.TV`) had no matching channel and is recorded as unmapped.

## 6. Playback coverage

| | Channels |
| --- | ---: |
| Published channels with an authorised in-app source | 259 |
| Published channels available only in the emitter's player | 153 |
| Published channels with nothing registered | 0 |

In-app sources: 107 HLS + 213 YouTube (official IFrame). 153 external sources
are exposed as `external` (a link to the emitter's own player), never as in-app
availability.

The previous milestone measured **318 channels playing in-app**. That number is
preserved as traceability (`audits/data-state.json`, `PLAYBACK_COVERAGE →
traceability`) and is **not** treated as an authorisation: a source is exposed
only under a recorded permission, and the platform reports what it may legally
expose rather than what happens to play.

## 7. Tests executed

| Suite | Result |
| --- | --- |
| Backend unit | **49 passed** (publication policy, guide parsers, security primitives, slug/search/region rules) |
| Backend integration (real MongoDB, real Express) | **90 passed** (public API, admin workflow, EPG, migration, contracts) |
| Backend independence (TDTChannels blocked at process level) | **15 passed** |
| SDK | **14 passed** |
| Frontend unit | **318 passed** (baseline before migration: 337; see §9) |
| Playwright E2E | **75 passed**, including a suite that runs the shipped bundle against the live backend and database, with no stubs |
| Bootstrap from an empty database | **PASS** (empty DB → migrations → 768-channel import → guide import → API answers) |
| Load | 2 000 requests / 25 concurrency: **770 req/s, p95 72 ms, 0 errors**. 5 000 / 50: **720 req/s, p95 117 ms, 0 errors**. Rate limiting rejects with 429 beyond the configured budget |
| Acceptance audit | **17 checks + 2 re-executed suites, GO** |

Real playback was verified end to end: the E2E `real-backend` suite plays
RTVE's La 1 through our own HLS engine from the recorded, authorised source.

## 8. Remaining external dependencies

- **Emitters.** Playback requires the emitter's own address to be reachable, as
  it always did. This is dependency on emitters, not on TDTChannels.
- **YouTube** for channels whose descriptor is a YouTube page (official IFrame
  API, or the Data API when a key is configured).
- **Brand assets** served by the emitter (logos are linked, not copied).
- **TDTChannels** is no longer a runtime dependency. It appears only as (a)
  provenance for metadata reused under Apache-2.0 with attribution, and (b) an
  optional guide source registered with its licence and with ingestion disabled.
  Blocking every TDTChannels host at process level leaves the platform fully
  functional (independence suite).

## 9. Independent audit

`scripts/audit-tdt-api-01.mjs` re-verifies every acceptance item against the
running system and writes `audits/TDT-API-01-AUDIT.json`. Findings that must be
stated openly:

1. **The audit and the implementation share an author.** The script is
   independent in *method* (it queries the API, the database, the exported
   contract and the source tree, and re-runs the suites itself) but not in
   *authorship*. A second-party review is still recommended before production.
2. **Frontend unit tests dropped from 337 to 318.** The removed 19 are the
   former third-party catalogue/EPG parser tests (`validators.spec.ts`), which
   tested a decoder that no longer exists. Two ported tests were adjusted to the
   API contract; three new E2E tests cover the behaviour they asserted.
3. **The response cache is process-local.** It is invalidated by every
   successful write, so a single instance is always coherent; a multi-instance
   deployment must add Redis-backed invalidation before scaling out.
4. **`subagent_claude_code` / `subagent_codex` were not available in this
   session**, so the independent review was executed as an executable audit
   rather than by a different model family (ENGINE-04 §8.7 recommends the
   latter).
5. **No production deployment was attempted**, by instruction.

## 10. Four acceptance dimensions (reported separately)

| Dimension | Status | Basis |
| --- | --- | --- |
| **API_IMPLEMENTATION** | **PASS** | 12 public endpoints + admin surface answer from persisted data; OpenAPI 3.1 exported; validation, ETag, caching, rate limiting, metrics and structured logs verified |
| **DATA_INDEPENDENCE** | **PASS** | Catalogue, sources and guide in our MongoDB; every published channel has provenance; 891 withheld sources each with a reason; platform works with every TDTChannels host blocked; no provider URL in runtime code |
| **PLAYBACK_COVERAGE** | **PASS (scoped)** | 259 channels with authorised in-app sources (107 HLS + 213 YouTube) and 153 external-only, all backed by a recorded permission; live playback verified for a public broadcaster; 356 channels held in review because their emitter has no recorded decision — legitimate but a coverage limit, not a defect |
| **GUIATV_INTEGRATION_READINESS** | **PASS** | Versioned API, integration manifest, identity map, built SDK, generated types, integration guide, server-to-server usable, no inverse dependency |

## 11. GO / NO-GO

**GO** for the GuíaTV integration milestone, with the conditions in §9. No
critical blocker remains: the backend exists and runs, the database is ours, the
catalogue has its own identities, the API serves persisted data, the migration
is documented and reversible, the client no longer consumes TDTChannels, both
playback engines and the YouTube engine still work, the API is documented and
has an SDK, the contracts are validated, the suites are green, independence is
proven with the provider blocked, and an audit produced a GO.

**NO-GO for production deployment** until: an independent second-party review
is completed, the licence of this repository is decided, and the operator
confirms the emitter decisions in `docs/PROVENANCE-AND-LICENCES.md`.
