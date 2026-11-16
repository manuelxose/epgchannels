# MODULE-CONTRACT-02B — Global Channel Catalogue & Independent Ingestion

Frozen interface contract for milestone **TDT-API-02B**. Every specialist codes against this file.
Changing a type here is a contract change: it requires the captain's agreement and an entry in
`DECISIONS.md`, because four parallel writers depend on it.

Version: `TDT-02B-CONTRACT-v1` · 2026-11-16 · base `671a42f`.

---

## 0. Hard rules that shape every module

1. **No runtime network.** Nothing in `apps/backend/src` may fetch iptv-org, Free-TV or TDTChannels.
   Ingestion reads **bounded local snapshots** only (`maintainers/fetch-snapshots.mjs` is the single
   place allowed to touch the network, and it is a maintainer tool, never imported by the app).
2. **Original code.** No third-party parser is vendored. Format knowledge comes from observation
   (see §4), the implementation is ours.
3. **One source candidate ≠ one channel.** A channel is created by *identity*, never by *arrival
   order*. Two sources pointing at the same station produce one `ChannelDoc` and two
   `SourceCandidateDoc`s.
4. **Staging is private.** Every imported record is created `staging`. Only an approved
   authorisation can make a source candidate `public`. The publication policy
   (`modules/playback/publication-policy.ts`) stays the final gate.
5. **Stable IDs.** `_id` is a UUID v5 derived deterministically where possible; `slug` is
   human-readable, unique, lowercase ASCII. A re-run must not invent a new id for a record it
   already knows.
6. **Nothing silent.** Every input line either produces a record or a documented rejection reason
   with its line number.
7. **No secrets, no credentials in payloads.** A URL carrying a userinfo component or a
   token-like query parameter is recorded with `authRequired: true` and **never** published; the
   stored URL keeps the raw value only because it is the operator's own staging record — it is
   excluded from every API response.

---

## 1. File ownership (disjoint write scopes)

| Area | Owner | Paths |
|---|---|---|
| Formats, snapshots, provenance | format-specialist | `apps/backend/src/ingestion/**`, `maintainers/**`, `scripts/snapshot-*.mjs` |
| Identity, normalisation, reconciliation | identity-specialist | `apps/backend/src/catalogue-identity/**`, `apps/backend/src/shared/normalize/**` |
| Models, indexes, migrations, rollback | models-specialist | `apps/backend/src/catalogue/**` (models + store), `apps/backend/src/migrations/**`, `apps/backend/src/infrastructure/mongo.ts` (COLLECTIONS only) |
| Performance, metrics, automation | perf-specialist | `apps/backend/scripts/**`, `apps/backend/src/ingestion/*.integration.spec.ts`, `scripts/` (root, non-snapshot), `qa/qa-manifest.json` |
| Integration, scripts, docs, review fixes | captain | `apps/backend/src/scripts/**`, `apps/backend/src/server/**`, `packages/contracts/**`, `docs/**` |

A writer never edits a file outside its scope; if it needs a change there, it reports it to the
captain instead of writing it.

---

## 2. Data model (MongoDB)

New collections, added to `COLLECTIONS` in `apps/backend/src/infrastructure/mongo.ts`:

```
channels                     (existing, EXTENDED — never replaced)
playback_sources             (existing, unchanged shape)
source_snapshots             snapshots
source_candidates            candidates
channel_aliases              aliases
channel_variants             variants
channel_epg_map              (existing) + epg_mappings
reconciliation_review        review queue
ingestion_runs               run ledger (rollback anchor)
```

### 2.1 `ChannelDoc` — extension (backward compatible)

Existing fields are kept verbatim. New optional fields:

```ts
export interface ChannelIdentityDoc {
  /** Stable key for deterministic reconciliation: `cc:normalizedname`. */
  key: string;
  /** ISO 3166-1 alpha-2, or `null` when the country is genuinely unknown. */
  country: string | null;
  language: string;                       // BCP-47 primary, lowercase
  /** Regional / local qualifier, never folded into the name. */
  variantKey: string | null;
  network: string | null;
}

// on ChannelDoc
identity: ChannelIdentityDoc;             // NEW
publicSlugSource: string | null;          // NEW — what the slug was derived from
catalogueState: 'staging' | 'approved';   // NEW — staging by default
```

`country` on the top-level document keeps its current contract (`'ES' | 'INT'`-style, matching the
existing importer) so nothing breaks; `identity.country` carries the real ISO code. `INT` handling
follows D-010 in `DECISIONS.md`; do not change `countryCodeSchema` in this milestone.

### 2.2 New documents

```ts
export interface SourceSnapshotDoc {
  _id: string;                       // sha256 of the archive content
  upstream: 'iptv-org' | 'free-tv';
  upstreamUrl: string;
  commitSha: string | null;
  retrievedAt: Date;
  checksumSha256: string;
  licence: { spdx: string | null; url: string | null; reuse: 'public-domain' | 'permitted-with-attribution' | 'unlicensed'; notes: string };
  format: 'm3u' | 'json';
  fileCount: number;
  entryCount: number;
  bytes: number;
  status: 'ingested' | 'rejected';
  rejectionReason: string | null;
  createdAt: Date;
}

export interface SourceProvenanceDoc {
  snapshotId: string;
  upstream: string;
  upstreamPath: string;        // e.g. `streams/es.m3u`
  line: number;
  rawName: string;
  rawAttributes: Record<string, string>;
  retrievedAt: Date;
  checksumSha256: string;
}

export interface SourceCandidateDoc {
  _id: string;                 // uuid v5(snapshotId:path:line:url)
  channelId: string | null;    // null until reconciled
  snapshotId: string;
  upstream: string;
  url: string;
  normalizedUrl: string;       // host lower, default port dropped, tracking params removed
  urlSha256: string;
  type: string;                // hls | dash | youtube | official-embed | external
  name: string;
  attributes: Record<string, string>;
  country: string | null;      // ISO alpha-2 or null
  provider: string | null;     // tvg-id network/group hint, or emitter host
  groupTitle: string | null;
  language: string | null;
  quality: 'SD' | 'HD' | 'FHD' | 'UHD' | null;
  flags: string[];             // geo-blocked, authRequired, userAgentRequired, refererRequired …
  provenance: SourceProvenanceDoc;
  state: 'staging' | 'duplicate' | 'unmatched' | 'reconciled' | 'rejected';
  rejectionReason: string | null;
  duplicateOf: string | null;  // candidate _id
  createdAt: Date;
  updatedAt: Date;
}

export interface ChannelAliasDoc {
  _id: string;
  channelId: string;
  namespace: 'tvg-id' | 'epgshare' | 'name' | 'slug' | 'external';
  value: string;
  source: string;              // upstream id
  confidence: number;
  createdAt: Date;
}

export interface ChannelVariantDoc {
  _id: string;
  channelId: string;
  region: string | null;
  locality: string | null;
  variantKey: string;          // e.g. `es-cat` or `us-chicago`
  label: string;
  reason: 'regional' | 'local' | 'timezone' | 'feed';
}

export interface SourceAuthorizationDoc {
  _id: string;                 // channelId + ':' + candidateId
  candidateId: string;
  channelId: string;
  decision: 'approved' | 'rejected' | 'pending';
  licenceReuse: string;
  conditions: { embedAllowed: boolean; proxyAllowed: boolean; requiresForgedHeader: boolean; emitterAppOnly: boolean; worldwide: boolean; restrictedRegions: string[] };
  decidedBy: string;
  decidedAt: Date;
  notes: string | null;
}

export interface SourceHealthDoc {
  _id: string;                 // candidateId
  candidateId: string;
  channelId: string | null;
  state: 'unknown' | 'healthy' | 'degraded' | 'dead';
  consecutiveFailures: number;
  lastCheckedAt: Date | null;
  nextCheckAt: Date | null;
  lastHttpStatus: number | null;
  lastError: string | null;
}

export interface EpgMappingDoc {
  _id: string;
  channelId: string;
  epgSourceId: string | null;
  externalId: string;
  namespace: string;
  confidence: number;
  status: 'proposed' | 'confirmed' | 'rejected';
}

export interface ReconciliationReviewDoc {
  _id: string;
  candidateId: string;
  channelId: string | null;
  proposedChannelId: string | null;
  score: number;
  signals: { name: number; country: number; tvgId: number; urlHost: number };
  reason: string;
  status: 'open' | 'approved' | 'rejected';
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
}

export interface IngestionRunDoc {
  _id: string;                 // runId (uuid)
  snapshotId: string;
  upstream: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: 'running' | 'completed' | 'rolled-back' | 'failed';
  createdChannelIds: string[];
  createdCandidateIds: string[];
  metrics: IngestionMetrics;
}
```

### 2.3 Required indexes

```
source_snapshots:   { upstream: 1, retrievedAt: -1 } unique { upstream:1, commitSha:1, checksumSha256:1 }
source_candidates:  unique { snapshotId: 1, urlSha256: 1, 'provenance.line': 1 }
                    { urlSha256: 1 }  { channelId: 1, state: 1 }  { state: 1, upstream: 1 }  { 'provenance.upstreamPath': 1 }
channel_aliases:    unique { namespace: 1, value: 1 }  { channelId: 1 }
channel_variants:   unique { channelId: 1, variantKey: 1 }
source_authorization: unique { candidateId: 1 }  { channelId: 1, decision: 1 }
source_health:      unique { candidateId: 1 }  { state: 1, nextCheckAt: 1 }
epg_mappings:       unique { channelId: 1, namespace: 1, externalId: 1 }
reconciliation_review: { status: 1, createdAt: 1 }  unique { candidateId: 1 }
ingestion_runs:     { snapshotId: 1 }  { status: 1, startedAt: -1 }
channels:           + unique { 'identity.key': 1 } (partial: identity exists, mergedInto null)
                    + { 'identity.country': 1, 'identity.language': 1 }
```

Owner of this section: **models-specialist**.

---

## 3. Module contract

### 3.1 `apps/backend/src/ingestion/` (format-specialist)

```ts
// m3u.ts — pure, no I/O
export interface M3uEntry {
  index: number;                       // 0-based entry ordinal
  line: number;                        // 1-based line of the #EXTINF
  duration: number | null;
  attributes: Record<string, string>;  // every key="value", case-preserved
  name: string;                        // text after the first top-level comma
  url: string | null;                  // href line, trimmed
  urlLine: number | null;
  directives: Record<string, string>;  // #EXTVLCOPT / #EXTVLCOPT:user-agent → last wins
  rejected: M3uRejection | null;
}
export type M3uRejection = 'no-url' | 'not-http' | 'missing-name' | 'no-extinf';

export interface M3uPlaylist {
  header: Record<string, string>;      // attributes of the #EXTM3U line (x-tvg-url …)
  entries: M3uEntry[];
  rejected: { line: number; reason: M3uRejection; raw: string }[];
  stats: { lines: number; entries: number; rejectedEntries: number; byeForced: boolean };
}

/** Parses bytes; detects UTF-8 (with/without BOM), UTF-16LE/BE BOM, and falls back to
 *  windows-1252 for high-byte sequences that are not valid UTF-8. Never throws. */
export function parseM3u(bytes: Uint8Array): M3uPlaylist;
export function decodePlaylistBytes(bytes: Uint8Array): { text: string; encoding: string };
```

```ts
// snapshot.ts — pure
export interface SnapshotManifest {
  upstream: 'iptv-org' | 'free-tv';
  commitSha: string | null;
  retrievedAt: string;   // ISO
  files: { path: string; sha256: string; bytes: number; entries: number }[];
  licence: SourceSnapshotDoc['licence'];
}
/** Verifies every file digest against the manifest and returns the parsed playlists.
 *  A digest mismatch rejects the whole snapshot (bounded, versioned, tamper-evident). */
export function loadSnapshot(root: string): { manifest: SnapshotManifest; playlists: LoadedPlaylist[]; integrity: 'ok' | 'failed' };
```

```ts
// provenance.ts — pure
export function buildCandidates(snapshot: SourceSnapshotDoc, playlists: LoadedPlaylist[]): SourceCandidateDoc[];
```

### 3.2 `apps/backend/src/catalogue-identity/` (identity-specialist)

```ts
// normalize.ts
export function foldText(value: string): string;              // NFKD, strip marks, lowercase, collapse spaces
export function normalizeChannelName(name: string): string;   // removes quality/geo suffixes, HD/SD tags, numbering
export function normalizeCountry(input: string | null | undefined): string | null;  // 'ES', 'Spain', 'espana', 'es' → 'ES'
export function normalizeLanguage(input: string | null | undefined): string | null; // 'es', 'Spanish', 'es-ES' → 'es'
export function identityKey(country: string | null, normalizedName: string): string; // `es:la-1`

export interface MatchSignals { name: number; country: number; tvgId: number; urlHost: number }
export interface MatchDecision {
  kind: 'same' | 'review' | 'different';
  score: number;            // 0..1
  signals: MatchSignals;
  channelId: string | null; // proposed
  reason: string;
}
/** Deterministic. Same inputs → same output, forever. No randomness, no timestamps. */
export function reconcile(candidate: SourceCandidateDoc, existing: ChannelIdentityView[]): MatchDecision;
export const REVIEW_THRESHOLD = 0.55;   // below: different; between: review; above: same
export const SAME_THRESHOLD = 0.85;
```

Rules that must hold (tested):
- Different regional/local stations are **never** silently merged: a differing region/locality
  qualifier forces `review`, never `same`.
- Two distinct upstreams reporting the same station collapse to `same` when name, country and
  `tvg-id` agree; name-only agreement never reaches `same` (needs country or tvg-id corroboration).
- `tvg-id` without a country component (iptv-org style `Name.cc@SD`) is parsed, not trusted whole.

### 3.3 `apps/backend/src/catalogue/` (models-specialist)

```ts
export interface ChannelStore {
  upsertChannel(doc: ChannelDoc): Promise<void>;
  findByKey(key: string): Promise<ChannelDoc | null>;
  listIdentities(limit?: number): Promise<ChannelIdentityView[]>;
  insertCandidate(doc: SourceCandidateDoc): Promise<void>;
  findCandidateByUrlSha(urlSha256: string, snapshotId: string): Promise<SourceCandidateDoc | null>;
  findByAlias(namespace: string, value: string): Promise<ChannelDoc | null>;
  addAlias(doc: ChannelAliasDoc): Promise<void>;
  addVariant(doc: ChannelVariantDoc): Promise<void>;
  queueReview(doc: ReconciliationReviewDoc): Promise<void>;
  recordRun(doc: IngestionRunDoc): Promise<void>;
  finishRun(runId: string, status: 'completed' | 'failed', metrics: IngestionMetrics): Promise<void>;
  rollbackRun(runId: string): Promise<{ removed: number }>;
}
```

Migrations (models-specialist): `004-catalogue-identity`, `005-source-snapshot-provenance`,
`006-incremental-dedup`, each idempotent and **reversible**, with an explicit rollback function.
Existing channel documents keep their `_id`, `slug` and relationships; the migration backfills
`identity` and `catalogueState: 'approved'` for pre-existing records and is verified by
`migration.integration.spec.ts`.

### 3.4 Metrics type (shared, every module imports it from `ingestion/metrics.ts`)

```ts
export interface IngestionMetrics {
  upstream: string;
  importedEntries: number;
  rejectedEntries: number;
  duplicateCandidates: number;
  canonicalChannels: number;
  newChannels: number;
  unmatchedEntries: number;
  manualReview: number;
  candidatesPerChannel: { avg: number; max: number; histogram: Record<string, number> };
  byCountry: Record<string, number>;
  byLanguage: Record<string, number>;
  byGroup: Record<string, number>;
  durationMs: number;
}
```

---

## 4. Observed upstream facts (measured 2026-11-16, do not re-derive)

| Fact | iptv-org | Free-TV |
|---|---|---|
| Licence | `Unlicense` (LICENSE file = public-domain text; README badge says CC0 — both permit reuse, recorded as `public-domain`) | **none declared**, no LICENSE file |
| Reuse decision | ingest into **staging**, publishable after authorisation | ingest into **staging only**, never publishable (`unlicensed`) |
| Default branch | `master` | `master` |
| Structure | `streams/<cc>.m3u` (326 files), `streams/<cc>_<provider>.m3u` | `playlist.m3u8` (~588 KB), `playlists/playlist_<country>.m3u8` (98 files) |
| `#EXTINF` keys | `tvg-id` only (`Name.cc@SD`) | `tvg-name`, `tvg-logo`, `tvg-id` (`Name.cc`), `tvg-chno`, `tvg-country`, `group-title` |
| `#EXTM3U` header | none | `x-tvg-url="…, …"` (comma-separated, very long) |
| Directives | `#EXTVLCOPT:http-referrer=…`, `#EXTVLCOPT:http-user-agent=…` (malformed nesting exists) | none observed |
| Name decorations | `(1080p)`, `[Geo-blocked]`, `(576p)` | `?` suffix on some names |
| Encoding | UTF-8 with occasional mojibake in names (`C�meres`) | UTF-8 (valid); `?` where the source mangled accents |
| Duplicate behaviour | same `tvg-id` repeated with different URLs (multi-source) | one URL per channel |
| Countries | ISO alpha-2 filenames (326, incl. provider variants) | `group-title`/`tvg-country` country names and codes |

---

## 5. Acceptance for every specialist

- `npm run build` → exit 0; `npm run typecheck` → exit 0 (build first — D-007).
- New unit tests pass; no existing test is modified to make a change pass.
- No new runtime dependency. Node ≥ 24 built-ins only (`node:crypto`, `node:fs`).
- No network call at import time, in a constructor, or in a request path.
- Every public function has a doc comment stating what it does **not** do.
- Report a compact brief: files changed, tests added, exit codes, and anything you refused to do.
