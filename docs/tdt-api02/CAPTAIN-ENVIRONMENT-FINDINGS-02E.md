# 02E — Captain's environment findings (established before delegation)

Recorded 2026-11-17 by the captain. These are measured facts, not assumptions, so the
E2E verifier does not have to re-derive them and cannot accidentally contradict them.

## 1. Playwright browser availability — MEASURED

Resolved via `@playwright/test` 1.65.0 in `apps/frontend`:

| Engine | Executable path | Binary present |
|---|---|---|
| Chromium 1254 | `%LOCALAPPDATA%\ms-playwright\chromium-1254\chrome-win64\chrome.exe` | **yes** |
| Firefox 1572 | `%LOCALAPPDATA%\ms-playwright\firefox-1572\firefox\firefox.exe` | **no** |
| WebKit 2388 | `%LOCALAPPDATA%\ms-playwright\webkit-2388\Playwright.exe` | **no** |

**Consequence, stated plainly:** real cross-browser *engine* coverage is **Chromium only** in
this environment. Firefox and WebKit are **not measured**, and installing them is not
authorized by this milestone. Any 02E claim of "supported browsers" must therefore say
"Chromium measured; Firefox/WebKit not measured in this environment" — never imply coverage
that did not run. Cross-engine claims may only be made from static capability detection
(`canPlayType`, `MediaSource.isTypeSupported`), which is a different and weaker thing.

## 2. Infrastructure — READY

`node scripts/preflight.mjs` exit 0. Mongo replica set `127.0.0.1:27117`, Redis
`127.0.0.1:27118`, containers healthy. Operational database: `tdt_platform`.

## 3. Baseline gate on `a2a2ed3` — green before any change

| Stage | Exit | Evidence |
|---|---|---|
| `build` | 0 | tsc contracts + api-client + backend |
| `typecheck` | 0 | all three |
| `unit` | 0 | 549 tests |
| `integration` | 0 | 181 tests |
| `ingestion` | 0 | 9/9 |
| `independence` | 0 | 15 tests |
| `client` | 0 | 14 tests |
| frontend unit | 0 | 318 tests |

## 4. Authorized catalogue sources — the real ground truth

From the live `tdt_platform` database plus the committed measurement
`evidence/verification-02d/catalogue-verification.json` (generated 2026-11-17T13:52:09Z):

- **81** published HLS catalogue sources, **all 81** with a resolved authorization
  (`verdict: permitted-direct-playback`).
- **63 healthy** at depth `segments`; **18 failing**.
- Failures are host-concentrated and diagnosable:
  - `ztnr.rtve.es` → 9 × `http-404` + 1 × `missing-segments`
  - `laxarxames.cat` / `www.laxarxames.cat` → 8 × `unsupported-format`

Healthy hosts and counts:

| Host | Healthy |
|---|---|
| `ztnr.rtve.es` | 22 |
| `rtvelivestream.rtve.es` | 24 |
| `www.bloomberg.com` | 4 |
| `rtvelivestream-rtveplayplus.rtve.es` | 3 |
| `english-livebkali.cgtn.com` | 2 |
| `cdn1.etbon.eus` | 7 |
| `streaming-1.eltorotv.com` | 1 |

### 4-bis. What those authorizations ARE and ARE NOT

Every record carries `basis: written-licence`, `clauseUrl` = the project `DECISIONS.md`,
`reviewStatus: pending-review`, and this quoted clause:

> Product owner authorises the platform to VERIFY these sources (technical probing of
> manifest, variant and sampled segments). This is not evidence that the emitter granted
> redistribution rights.

So: **verification-eligible, authorization-eligible, NOT a broadcaster licence.** 02E must
never describe these as redistribution rights, and must never present the owner's
authorization as the emitter's permission.

### 4-bis. `healthy` ≠ `playable`

`healthy` at `segments` depth means the manifest, the variant and the sampled segments
were retrieved and had the expected content type. It does **not** mean a browser renders
them. That gap is precisely what the E2E axis must close in this milestone.

## 5. Reusable tooling already in the repo

- `apps/backend/scripts/browser-playback-check.mjs` — two independent axes (HTTP vs real
  Chromium playback), closed verdict vocabulary, `not-observable` instead of a fake pass.
  **Reuse this rather than writing a second harness.**
- `apps/backend/scripts/verify-catalogue.mjs` — engine verification over the catalogue.
- `data/02e-authoritative-sources.json` (workspace root, outside git) — the 81 results,
  extracted from the committed evidence.

## 6. Known host limitation (carried from 02D)

The engine-04 ACL runner cannot spawn `npm` here (`CreateProcessAsUserW failed (Win32 2)`).
Gate stages are therefore executed **directly** with recorded exit codes. This is honest
measurement, **not** an engine-04-certified gate, and must be labelled that way.
