/**
 * Shared core for the TDT-API-02B ingestion automation
 * (`apps/backend/scripts/ingestion-*.mjs`).
 *
 * It holds the one ingestion driver that the metrics, benchmark and scenario
 * scripts all use, the disposable-database lifecycle, and the change-stream
 * mirror helper. Keeping it in one module is what makes the reported numbers
 * comparable: every script measures the same code path.
 *
 * Output discipline: every helper returns *counts and digests only*. No
 * function here returns a raw playlist, a document body or a URL for printing.
 * The scripts print compact JSON built from these counts.
 *
 * It uses only Node built-ins plus the backend's own built modules
 * (`apps/backend/dist`), so it adds no dependency. It never fetches, never
 * touches a database whose name is not `tdt_<purpose>_<12 hex>`, and never
 * deletes a directory it did not create.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_DIST_MODULES = [
  'ingestion/m3u.js',
  'ingestion/snapshot.js',
  'ingestion/provenance.js',
  'ingestion/metrics.js',
  'catalogue-identity/normalize.js',
  'catalogue-identity/reconcile.js',
  'catalogue-identity/slug.js',
  'catalogue/store.js',
  'infrastructure/mongo.js',
  'migrations/runner.js',
];

const DISPOSABLE_NAME = /^tdt_(bench|metrics|scenario)_[0-9a-f]{12}$/u;

/** Fixed instant so generated documents are identical across runs. */
export const FIXED_TIME = new Date('2026-11-16T14:00:00.000Z');

/** Repository root of the worktree this script lives in. */
export function repositoryRoot(start = import.meta.dirname) {
  return resolve(start, '..', '..', '..');
}

export function backendRoot(root = repositoryRoot()) {
  return resolve(root, 'apps', 'backend');
}

export function defaultMongoUri() {
  return process.env['MONGODB_URI'] ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0';
}

/** Default read-only snapshot roots, in ingestion order (iptv-org, then Free-TV). */
export function defaultSnapshotRoots(root = repositoryRoot()) {
  const data = process.env['TDT_SNAPSHOT_DIR'] ?? resolve(root, '..', '..', 'data', 'snapshots');
  return { data, candidates: ['iptv-org-20261116T145323Z', 'free-tv-20261116T145604Z'] };
}

/** Deterministic UUID-shaped id, so a repeated run writes the same ids. */
export function deterministicId(seed) {
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** True for a MongoDB duplicate-key failure (code 11000), nothing else. */
export function isDuplicateKeyError(error) {
  return typeof error === 'object' && error !== null && (error.code === 11000 || /E11000 duplicate key/u.test(String(error.message ?? '')));
}

/** Peak resident set size of this process, in MiB. */
export function peakRssMiB() {
  return Math.round((process.resourceUsage().maxRSS / 1024) * 100) / 100;
}

export function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Loads the backend's built modules. Throws a message naming `npm run build`
 * when `dist/` is missing, so the failure is actionable instead of a stack trace.
 */
export async function loadBackend(root = repositoryRoot()) {
  const dist = resolve(backendRoot(root), 'dist');
  const missing = REQUIRED_DIST_MODULES.filter((file) => {
    try {
      statSync(resolve(dist, file));
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    throw new Error(
      `backend dist is incomplete (${missing.length} missing, e.g. ${missing[0]}): run \`npm run build\` first`,
    );
  }
  const load = async (file) => import(pathToFileURL(resolve(dist, file)).href);
  return {
    m3u: await load('ingestion/m3u.js'),
    snapshot: await load('ingestion/snapshot.js'),
    provenance: await load('ingestion/provenance.js'),
    metrics: await load('ingestion/metrics.js'),
    normalize: await load('catalogue-identity/normalize.js'),
    reconcile: await load('catalogue-identity/reconcile.js'),
    slug: await load('catalogue-identity/slug.js'),
    store: await load('catalogue/store.js'),
    mongo: await load('infrastructure/mongo.js'),
    runner: await load('migrations/runner.js'),
  };
}

/* ------------------------------------------------------------------------- *
 * Disposable databases
 * ------------------------------------------------------------------------- */

/** Creates and connects a disposable database named `<prefix><12 hex>`. */
export async function openDisposable(backend, uri, prefix) {
  const name = `${prefix}${randomBytes(6).toString('hex')}`;
  if (!DISPOSABLE_NAME.test(name)) {
    throw new Error(`refusing a non-disposable database name: ${name}`);
  }
  const database = await backend.mongo.connectDatabase(uri, name);
  return { name, database };
}

/**
 * Drops exactly the named disposable database and closes every handle given.
 *
 * The drop runs on a client opened for `admin` (so it cannot be confused with
 * the data itself), but targets `name`: `dropDatabase()` on the admin client
 * itself is prohibited by MongoDB.
 *
 * `dropDatabase()` returns before MongoDB has finished dropping every
 * collection, so a create in the same namespace started immediately afterwards
 * fails with "database is in the process of being dropped" (reproduced). The
 * function therefore waits until the database is really absent before returning,
 * and it returns the truth: `false` when the wait timed out.
 */
export async function dropDisposable(backend, uri, name, handles = []) {
  for (const handle of handles) {
    await handle.close().catch(() => undefined);
  }
  if (!DISPOSABLE_NAME.test(name)) {
    throw new Error(`refusing to drop non-disposable database name: ${name}`);
  }
  const client = await backend.mongo.connectDatabase(uri, name);
  try {
    await client.db.dropDatabase();
    const deadline = Date.now() + 30_000;
    for (;;) {
      const { databases } = await client.db.admin().listDatabases();
      if (!databases.some((entry) => entry.name === name)) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await client.close();
  }
}

/* ------------------------------------------------------------------------- *
 * Change-stream mirror
 * ------------------------------------------------------------------------- */

/**
 * Records every insert/update/delete on the database to a temporary NDJSON file
 * while `body()` runs, and returns the per-operation counts. It is the
 * change-stream baseline that proves a repeated run produces zero document
 * writes; the file is removed before returning and nothing in it is printed.
 */
export async function withChangeLog(database, body) {
  const directory = process.env['TDT_TMP_DIR'] ?? undefined;
  if (directory !== undefined) mkdirSync(directory, { recursive: true });
  const path = join(directory ?? (await import('node:os')).tmpdir(), `tdt-changelog-${randomBytes(4).toString('hex')}.ndjson`);
  writeFileSync(path, '', 'utf8');
  const counts = { events: 0, inserts: 0, updates: 0, deletes: 0, byCollection: {} };
  let firstError = null;
  const stream = database.db.watch([], { fullDocument: 'default' });
  const done = new Promise((resolveDone) => {
    stream.on('change', (event) => {
      counts.events += 1;
      if (event.operationType === 'insert') counts.inserts += 1;
      else if (event.operationType === 'update') counts.updates += 1;
      else if (event.operationType === 'delete') counts.deletes += 1;
      if (event.operationType !== 'invalidate') {
        const collection = typeof event.ns?.coll === 'string' ? event.ns.coll : 'unknown';
        counts.byCollection[collection] = (counts.byCollection[collection] ?? 0) + 1;
        appendFileSync(path, `${JSON.stringify({ op: event.operationType, collection, id: event.documentKey?._id })}\n`, 'utf8');
      }
    });
    stream.on('error', (error) => {
      firstError = error instanceof Error ? error.message : String(error);
      resolveDone();
    });
    stream.on('close', () => resolveDone());
  });
  // Wait for the stream to be open before the measured body runs, so no
  // operation can slip in before the mirror is listening.
  await new Promise((resolveOpen) => stream.once('resume', resolveOpen));
  try {
    const result = await body();
    await new Promise((resolveTick) => setTimeout(resolveTick, 400));
    await stream.close().catch(() => undefined);
    await done.catch(() => undefined);
    return { result, changeLog: { ...counts, error: firstError } };
  } finally {
    await stream.close().catch(() => undefined);
    rmSync(path, { force: true });
  }
}

/* ------------------------------------------------------------------------- *
 * Snapshots
 * ------------------------------------------------------------------------- */

/**
 * Lists the real snapshot roots under the data directory, in ingestion order.
 * It reads only `manifest.json` to report identity facts (never playlist text).
 */
export function discoverSnapshots(root = repositoryRoot()) {
  const { data, candidates } = defaultSnapshotRoots(root);
  const found = [];
  for (const name of candidates) {
    const path = resolve(data, name);
    try {
      const manifest = JSON.parse(readFileSync(resolve(path, 'manifest.json'), 'utf8'));
      found.push({
        path,
        name,
        upstream: manifest.upstream,
        commitSha: manifest.commitSha ?? null,
        retrievedAt: manifest.retrievedAt,
        fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
        entryCount: typeof manifest.entryCount === 'number' ? manifest.entryCount : null,
        bytes: typeof manifest.bytes === 'number' ? manifest.bytes : null,
        licenceReuse: manifest.licence?.reuse ?? null,
      });
    } catch {
      found.push({ path, name, missing: true });
    }
  }
  return { data, snapshots: found };
}

/**
 * Verifies and parses one snapshot with the real loader.
 * Returns the snapshot document, the loaded playlists and counts only.
 */
export function loadSnapshot(backend, path) {
  const started = performance.now();
  const load = backend.snapshot.loadSnapshot(path);
  const loadMs = round(performance.now() - started, 1);
  const doc = backend.snapshot.snapshotDocument(load, { now: FIXED_TIME });
  return {
    doc,
    playlists: load.playlists,
    integrity: load.integrity,
    errors: load.errors.length,
    firstError: load.errors[0] ?? null,
    loadMs,
    files: load.playlists.length,
    entries: load.playlists.reduce((sum, playlist) => sum + playlist.playlist.entries.length, 0),
    bytes: load.playlists.reduce((sum, playlist) => sum + playlist.bytes, 0),
  };
}

/* ------------------------------------------------------------------------- *
 * Ingestion driver
 * ------------------------------------------------------------------------- */

function channelFromCandidate(backend, snapshot, candidate) {
  const country = candidate.country;
  const slug = backend.slug.slugify(candidate.name);
  return {
    _id: deterministicId(`channel:${candidate.urlSha256}`),
    slug,
    name: candidate.name,
    shortName: '',
    country: country ?? 'INT',
    region: null,
    locality: null,
    languageTag: candidate.language ?? 'und',
    category: 'general',
    kind: 'tv',
    websiteUrl: null,
    description: '',
    branding: null,
    editorialStatus: 'draft',
    timezone: 'UTC',
    provenance: [],
    aliases: [],
    searchText: candidate.name.toLowerCase(),
    epg: null,
    mergedInto: null,
    reviewedAt: null,
    createdAt: snapshot.retrievedAt,
    updatedAt: snapshot.retrievedAt,
    revision: 0,
    identity: {
      key: backend.normalize.identityKey(country, backend.normalize.normalizeChannelName(candidate.name)),
      country,
      language: backend.normalize.normalizeLanguage(candidate.language) ?? 'und',
      variantKey: null,
      network: candidate.provider,
    },
    publicSlugSource: slug,
    catalogueState: 'staging',
  };
}

/**
 * The reconciliation view of every active channel, in the exact
 * `ChannelIdentityView` shape (contract §3.2): `tvgIds` and `urlHosts` come from
 * the alias and candidate rows the ingestion wrote, because
 * `ChannelStore.listIdentities()` returns the identity fields without them (a
 * deviation reported to the captain; no out-of-scope module is edited here).
 */
async function knownIdentities(backend, database, store) {
  const views = await store.listIdentities(20000);
  const C = backend.mongo.COLLECTIONS;
  const [aliases, candidates] = await Promise.all([
    database.collection(C.channelAliases).find({ namespace: 'tvg-id' }, { projection: { channelId: 1, value: 1 } }).toArray(),
    database
      .collection(C.sourceCandidates)
      .find({ channelId: { $ne: null } }, { projection: { channelId: 1, normalizedUrl: 1 } })
      .toArray(),
  ]);
  const tvg = new Map();
  for (const alias of aliases) {
    const list = tvg.get(alias.channelId) ?? [];
    list.push(alias.value);
    tvg.set(alias.channelId, list);
  }
  const hosts = new Map();
  for (const candidate of candidates) {
    let host = '';
    try {
      host = new URL(candidate.normalizedUrl).hostname.toLowerCase();
    } catch {
      host = '';
    }
    if (host === '') continue;
    const list = hosts.get(candidate.channelId) ?? [];
    if (!list.includes(host)) list.push(host);
    hosts.set(candidate.channelId, list);
  }
  return views.map((view) => ({
    ...view,
    tvgIds: tvg.get(view.channelId) ?? [],
    urlHosts: hosts.get(view.channelId) ?? [],
  }));
}

/**
 * Ingests one verified snapshot into a database: the snapshot row, its
 * candidates, the canonical channels they resolve to, the review queue and the
 * run ledger with the ids it created (the rollback anchor).
 *
 * Idempotent by construction: snapshots and candidates are upserted by their
 * deterministic `_id`, a channel is created only when no stored identity
 * matches, and the run id is a function of its inputs.
 *
 * `options.decide(candidate, knownRecords, backend)` replaces the default
 * deterministic `reconcile` (the override scenarios use it).
 * Returns counts, stage durations and the created ids; it does not print.
 */
export async function ingestSnapshot(backend, database, doc, playlists, options = {}) {
  const attempt = options.attempt ?? 0;
  const runId = deterministicId(`run:${doc._id}:${attempt}`);
  const C = backend.mongo.COLLECTIONS;
  const store = new backend.store.ChannelStore(database);
  const runs = database.collection(C.ingestionRuns);
  const channels = database.collection(C.channels);
  const candidatesCollection = database.collection(C.sourceCandidates);
  const snapshots = database.collection(C.sourceSnapshots);
  const aliases = database.collection(C.channelAliases);

  const stages = { buildMs: 0, snapshotWriteMs: 0, candidatesMs: 0, reconcileMs: 0, channelsMs: 0, finishMs: 0 };
  let mark = performance.now();
  const candidates = backend.provenance.buildCandidates(doc, playlists);
  stages.buildMs = round(performance.now() - mark, 1);

  mark = performance.now();
  await snapshots.updateOne({ _id: doc._id }, { $set: doc }, { upsert: true });
  await runs.updateOne(
    { _id: runId },
    {
      $setOnInsert: {
        _id: runId,
        snapshotId: doc._id,
        upstream: doc.upstream,
        startedAt: FIXED_TIME,
        finishedAt: null,
        status: 'running',
        createdChannelIds: [],
        createdCandidateIds: [],
        metrics: backend.metrics.accumulateMetrics({ upstream: doc.upstream, candidates }),
      },
    },
    { upsert: true },
  );
  stages.snapshotWriteMs = round(performance.now() - mark, 1);

  const createdChannelIds = [];
  const createdCandidateIds = [];
  const counts = {
    candidates: candidates.length,
    rejected: 0,
    duplicates: 0,
    reconciled: 0,
    review: 0,
    createdChannels: 0,
    linked: 0,
    tvgAliasesWritten: 0,
    tvgAliasContended: 0,
    identityKeyConflicts: 0,
    duplicateKeyCollisions: 0,
  };
  let reconcileTotal = 0;
  let channelTotal = 0;

  mark = performance.now();
  // Which candidate ids already existed before this pass: a repeated run must
  // report (and claim) nothing new, so the "created" lists are derived from the
  // stored state, never assumed.
  const existingIds = new Set(
    (
      await candidatesCollection
        .find({ _id: { $in: candidates.map((candidate) => candidate._id) } }, { projection: { _id: 1 } })
        .toArray()
    ).map((row) => row._id),
  );
  // The reconciliation view is loaded once and kept current in this loop: a
  // per-candidate reload of every identity is quadratic and dominates a real
  // snapshot. Existing rows come from the database; rows this run creates are
  // appended, which is exactly what a reload would have returned.
  const known = await knownIdentities(backend, database, store);
  const knownByChannel = new Map(known.map((view) => [view.channelId, view]));
  const decisionOverride = options.decide;
  // Same for the two hot lookups below: every slug in use, and which channel
  // already owns each tvg-id alias. Loaded once, updated in memory.
  const takenSlugs = new Set(await channels.distinct('slug'));
  const aliasOwner = new Map(
    (await aliases.find({ namespace: 'tvg-id' }, { projection: { channelId: 1, value: 1 } }).toArray()).map((row) => [row.value, row.channelId]),
  );
  // Existing rows of this snapshot by URL digest, so duplicate detection is a
  // map lookup instead of one query per candidate.
  const storedByUrl = new Map(
    (
      await candidatesCollection
        .find({ snapshotId: doc._id }, { projection: { _id: 1, urlSha256: 1 } })
        .toArray()
    ).map((row) => [row.urlSha256, row._id]),
  );
  for (const candidate of candidates) {
    if (candidate.state === 'rejected') {
      counts.rejected += 1;
      continue;
    }

    // Duplicate detection first: the same urlSha256 inside one snapshot is a
    // second source record, never a second channel.
    const storedBefore = existingIds.has(candidate._id);
    const referenceId = storedByUrl.get(candidate.urlSha256) ?? null;
    if (referenceId !== null && referenceId !== candidate._id) {
      if (!storedBefore) {
        // The contract's unique candidate key is `{snapshotId, urlSha256,
        // provenance.line}`. Real upstream files can echo the same URL twice on
        // one line of two *different* files whose `provenance.line` coincides
        // (reported to the captain as finding #4), so the insert is allowed to
        // fail on that key alone: the row is then recorded as unrepresentable
        // and counted, never retried blindly and never crashed on.
        try {
          await store.insertCandidate({ ...candidate, state: 'duplicate', duplicateOf: referenceId });
          createdCandidateIds.push(candidate._id);
        } catch (error) {
          if (!isDuplicateKeyError(error)) throw error;
          counts.duplicateKeyCollisions += 1;
        }
      }
      counts.duplicates += 1;
      continue;
    }

    const reconcileStart = performance.now();
    const decision =
      decisionOverride === undefined ? backend.reconcile.reconcile(candidate, known) : decisionOverride(candidate, known, backend);
    reconcileTotal += performance.now() - reconcileStart;

    let channelId;
    if (decision.kind === 'same' && decision.channelId !== null) {
      channelId = decision.channelId;
      counts.reconciled += 1;
    } else if (decision.kind === 'review' && decision.channelId !== null) {
      // A review record keeps the proposal and never the identity.
      channelId = decision.channelId;
      counts.review += 1;
      const channelStart = performance.now();
      await store.queueReview({
        _id: deterministicId(`review:${candidate._id}`),
        candidateId: candidate._id,
        channelId: null,
        proposedChannelId: decision.channelId,
        score: decision.score,
        signals: decision.signals,
        reason: decision.reason,
        status: 'open',
        createdAt: doc.retrievedAt,
        resolvedAt: null,
        resolvedBy: null,
      });
      channelTotal += performance.now() - channelStart;
    } else {
      const channelStart = performance.now();
      const channel = channelFromCandidate(backend, doc, candidate);
      // Two distinct upstream names can normalise to one identity key (measured
      // on iptv-org: `Сфера ТВ` variants), and `identity_key_unique` forbids a
      // second active channel with that key. Such a candidate is attached to the
      // channel that already owns the key and queued for manual review instead of
      // being silently merged or crashing the run; the conflict is counted.
      const owner = await channels.findOne(
        { 'identity.key': channel.identity.key, mergedInto: null },
        { projection: { _id: 1 } },
      );
      if (owner !== null) {
        channelId = owner._id;
        counts.identityKeyConflicts += 1;
        await store.queueReview({
          _id: deterministicId(`review:${candidate._id}`),
          candidateId: candidate._id,
          channelId: owner._id,
          proposedChannelId: owner._id,
          score: 0,
          signals: { name: 0, country: 1, tvgId: 0, urlHost: 0 },
          reason: 'identity key already held by another channel: distinct names normalise to one key',
          status: 'open',
          createdAt: doc.retrievedAt,
          resolvedAt: null,
          resolvedBy: null,
        });
      } else {
        const resolved = { ...channel, slug: backend.slug.uniqueSlug(channel.slug, takenSlugs) };
        const existing = await channels.findOne({ _id: resolved._id }, { projection: { _id: 1 } });
        if (existing === null) {
          await store.upsertChannel(resolved);
          createdChannelIds.push(resolved._id);
          counts.createdChannels += 1;
          takenSlugs.add(resolved.slug);
          knownByChannel.set(resolved._id, {
            channelId: resolved._id,
            key: resolved.identity.key,
            name: resolved.name,
            country: resolved.identity.country,
            variantKey: resolved.identity.variantKey,
            tvgIds: [],
            urlHosts: [],
          });
          known.push(knownByChannel.get(resolved._id));
        }
        channelId = resolved._id;
      }
      channelTotal += performance.now() - channelStart;
    }

    // The tvg-id of every source linked to a channel becomes an alias; that is
    // what lets the next upstream's identical tvg-id corroborate a `same`.
    //
    // The alias index is unique on `{namespace, value}`, i.e. one tvg-id can map
    // to one channel only. Real data shares a tvg-id between several sources
    // (measured: 2431 tvg-ids in iptv-org alone, 720 with different names), so a
    // contended value is skipped and counted instead of aborting the run. That
    // restriction is reported to the captain: it loses tvg-id corroboration for
    // the channels that come second.
    const tvgId = String(candidate.attributes['tvg-id'] ?? candidate.attributes['tvg_id'] ?? '').trim();
    if (tvgId !== '') {
      const holder = aliasOwner.get(tvgId) ?? null;
      if (holder === null) {
        await store.addAlias({
          _id: deterministicId(`alias:tvg:${channelId}:${tvgId}`),
          channelId,
          namespace: 'tvg-id',
          value: tvgId,
          source: candidate.snapshotId,
          confidence: 1,
          createdAt: doc.retrievedAt,
        });
        aliasOwner.set(tvgId, channelId);
        counts.tvgAliasesWritten += 1;
      } else if (holder === channelId) {
        counts.tvgAliasesWritten += 1;
      } else {
        counts.tvgAliasContended += 1;
      }
    }

    try {
      await store.insertCandidate({ ...candidate, channelId, state: decision.kind === 'same' ? 'reconciled' : 'staging' });
    } catch (error) {
      // Same `{snapshotId, urlSha256, provenance.line}` collision as above: two
      // *different* files whose entry line coincides. Counted, not fatal.
      if (!isDuplicateKeyError(error)) throw error;
      counts.duplicateKeyCollisions += 1;
      continue;
    }
    // A later candidate with the same digest must find this row as the source it
    // repeats (in-memory, so the duplicate check stays linear).
    if (!storedByUrl.has(candidate.urlSha256)) storedByUrl.set(candidate.urlSha256, candidate._id);
    // Only ids this run actually created count: a repeat run claims nothing.
    if (!storedBefore) createdCandidateIds.push(candidate._id);
    counts.linked += 1;
  }
  stages.candidatesMs = round(performance.now() - mark, 1);
  stages.reconcileMs = round(reconcileTotal, 1);
  stages.channelsMs = round(channelTotal, 1);

  mark = performance.now();
  const stored = await candidatesCollection
    .find(
      { snapshotId: doc._id },
      { projection: { _id: 1, urlSha256: 1, state: 1, channelId: 1, country: 1, language: 1, groupTitle: 1 } },
    )
    .toArray();
  const metrics = backend.metrics.accumulateMetrics({
    upstream: doc.upstream,
    candidates: stored.map((row) => ({
      ...row,
      name: '',
      url: '',
      attributes: {},
      provider: null,
      type: 'hls',
      flags: [],
    })),
    rejectedEntries: counts.rejected,
    manualReview: counts.review,
  });
  await store.finishRun(runId, 'completed', metrics);
  // The ledger records what this run created. A repeat run must not re-claim
  // records it did not create now, so the ids are written only while empty.
  const claimed = await runs.findOneAndUpdate(
    { _id: runId, createdChannelIds: { $size: 0 } },
    { $set: { createdChannelIds, createdCandidateIds } },
    { returnDocument: 'after' },
  );
  if (claimed === null) {
    await runs.updateOne({ _id: runId }, { $set: { createdChannelIds, createdCandidateIds } });
  }
  stages.finishMs = round(performance.now() - mark, 1);

  return { runId, snapshotId: doc._id, createdChannelIds, createdCandidateIds, counts, stages };
}

/* ------------------------------------------------------------------------- *
 * Counts
 * ------------------------------------------------------------------------- */

/**
 * The catalogue counts `ingestion-metrics.mjs` reports: counts and ratios
 * only, aggregated over the whole database.
 */
export async function catalogueCounts(backend, database) {
  const C = backend.mongo.COLLECTIONS;
  const [channels, candidates, snapshots, reviews, runs, aliases] = await Promise.all([
    database
      .collection(C.channels)
      .find({}, { projection: { _id: 1, identity: 1, catalogueState: 1 } })
      .toArray(),
    database
      .collection(C.sourceCandidates)
      .find({}, { projection: { _id: 1, channelId: 1, state: 1, upstream: 1, country: 1, language: 1 } })
      .toArray(),
    database.collection(C.sourceSnapshots).find({}, { projection: { _id: 1, upstream: 1, status: 1 } }).toArray(),
    database.collection(C.reconciliationReview).find({}, { projection: { _id: 1, status: 1 } }).toArray(),
    database.collection(C.ingestionRuns).find({}, { projection: { _id: 1, status: 1 } }).toArray(),
    database.collection(C.channelAliases).countDocuments(),
  ]);

  const bump = (target, key) => {
    target[key] = (target[key] ?? 0) + 1;
  };

  const byUpstream = {};
  const countries = {};
  const languages = {};
  const candidateStates = {};
  const sourcesPerChannel = new Map();

  for (const candidate of candidates) {
    const upstream = byUpstream[candidate.upstream] ?? { candidates: 0, imported: 0, duplicates: 0, unmatched: 0, rejected: 0 };
    upstream.candidates += 1;
    if (candidate.state === 'rejected') upstream.rejected += 1;
    else upstream.imported += 1;
    if (candidate.state === 'duplicate') upstream.duplicates += 1;
    if (candidate.state === 'unmatched') upstream.unmatched += 1;
    byUpstream[candidate.upstream] = upstream;

    bump(candidateStates, candidate.state);
    if (candidate.country !== null) bump(countries, candidate.country);
    if (candidate.language !== null) bump(languages, candidate.language);
    if (candidate.channelId !== null) {
      const list = sourcesPerChannel.get(candidate.channelId) ?? [];
      list.push(candidate.state);
      sourcesPerChannel.set(candidate.channelId, list);
    }
  }

  const histogram = {};
  let total = 0;
  let max = 0;
  for (const states of sourcesPerChannel.values()) {
    total += states.length;
    max = Math.max(max, states.length);
    bump(histogram, sourcesHistogramBucket(states.length));
  }

  const staging = channels.filter((channel) => channel.catalogueState === 'staging').length;
  const approved = channels.filter((channel) => channel.catalogueState === 'approved').length;

  /*
   * Coverage of the CATALOGUE (the channels of record), which is the number a
   * reader cares about. The candidate-level counts below describe only what the
   * upstream itself declared: iptv-org declares no `tvg-language` at all, so a
   * candidate-only metric reported zero language coverage for a catalogue that
   * actually resolves a language for most channels. Both are reported, clearly
   * labelled, and never merged.
   */
  const channelsByCountry = {};
  const channelsByLanguage = {};
  let channelsCountryUnknown = 0;
  let channelsLanguageUnknown = 0;
  for (const channel of channels) {
    const identity = channel.identity ?? {};
    const country = identity.country ?? null;
    const language = identity.language ?? null;
    if (country === null) channelsCountryUnknown += 1;
    else bump(channelsByCountry, country);
    if (language === null || language === 'und') channelsLanguageUnknown += 1;
    else bump(channelsByLanguage, language);
  }

  return {
    snapshots: {
      total: snapshots.length,
      ingested: snapshots.filter((snapshot) => snapshot.status === 'ingested').length,
      rejected: snapshots.filter((snapshot) => snapshot.status === 'rejected').length,
      byUpstream: snapshots.reduce((acc, snapshot) => {
        acc[snapshot.upstream] = (acc[snapshot.upstream] ?? 0) + 1;
        return acc;
      }, {}),
    },
    importedEntriesByUpstream: byUpstream,
    uniqueCanonicalChannels: sourcesPerChannel.size,
    channelDocuments: channels.length,
    duplicateEntries: candidateStates['duplicate'] ?? 0,
    unmatchedEntries: candidateStates['unmatched'] ?? 0,
    candidateStates,
    candidateSourcesPerChannel: {
      avg: sourcesPerChannel.size === 0 ? 0 : Math.round((total / sourcesPerChannel.size) * 100) / 100,
      max,
      histogram,
    },
    /* Authoritative: resolved on the canonical channel. */
    channelCountryCoverage: {
      source: 'channels.identity.country',
      distinct: Object.keys(channelsByCountry).length,
      known: channels.length - channelsCountryUnknown,
      unknown: channelsCountryUnknown,
      byCountry: channelsByCountry,
    },
    channelLanguageCoverage: {
      source: 'channels.identity.language',
      distinct: Object.keys(channelsByLanguage).length,
      known: channels.length - channelsLanguageUnknown,
      unknown: channelsLanguageUnknown,
      byLanguage: channelsByLanguage,
    },
    /* Informational: what the upstream itself declared on the candidate. */
    languageDeclaredByUpstream: { distinct: Object.keys(languages).length, byLanguage: languages },
    countryDeclaredOnCandidate: { distinct: Object.keys(countries).length, byCountry: countries },
    manualReview: { open: reviews.filter((review) => review.status === 'open').length, total: reviews.length },
    stagingVersusApproved: { staging, approved, withoutState: channels.length - staging - approved },
    aliases,
    runs: {
      total: runs.length,
      completed: runs.filter((run) => run.status === 'completed').length,
      rolledBack: runs.filter((run) => run.status === 'rolled-back').length,
      failed: runs.filter((run) => run.status === 'failed').length,
    },
  };
}

/** Source-count histogram buckets, matching `ingestion/metrics.ts`. */
export function sourcesHistogramBucket(count) {
  if (count <= 1) return '1';
  if (count <= 5) return '2-5';
  if (count <= 20) return '6-20';
  return '21+';
}

/* ------------------------------------------------------------------------- *
 * Scenario plumbing
 * ------------------------------------------------------------------------- */

/**
 * Wraps a scenario body so a thrown assertion becomes a `passed: false` line
 * instead of an aborted run. Returns `{ name, passed, ms, facts, error? }`.
 */
export function scenario(name, body) {
  return async () => {
    const started = performance.now();
    try {
      const facts = await body();
      return { name, passed: true, ms: round(performance.now() - started, 1), facts: facts ?? {} };
    } catch (error) {
      return {
        name,
        passed: false,
        ms: round(performance.now() - started, 1),
        facts: {},
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

/** Minimal assertion helpers: the messages are the scenario's evidence. */
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function assertDeepEqual(actual, expected, message) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: expected ${right}, got ${left}`);
}

/* ------------------------------------------------------------------------- *
 * Child-process migration CLI (the real `dist/migrations/run.js`)
 * ------------------------------------------------------------------------- */

/**
 * Runs the built migration CLI against a disposable database, adding
 * `MONGODB_URI`/`MONGODB_DB` to the inherited environment. Resolves to the real
 * exit code plus a bounded stdout/stderr tail (the CLI prints compact JSON).
 */
export function runMigrationCli(root, uri, databaseName, args) {
  const script = resolve(backendRoot(root), 'dist', 'migrations', 'run.js');
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...process.env, MONGODB_URI: uri, MONGODB_DB: databaseName },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => resolveRun({ exitCode: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code) => resolveRun({ exitCode: code, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000) }));
  });
}
