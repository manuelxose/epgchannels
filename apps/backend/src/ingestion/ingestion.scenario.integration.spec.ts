/**
 * End-to-end ingestion scenarios against a real MongoDB (MODULE-CONTRACT-02B,
 * TDT-API-02B) — the test-automation half of the perf/automation task.
 *
 * Every scenario drives the real modules (nothing is mocked below the database):
 * the M3U parser, the bounded snapshot loader, the provenance builder,
 * deterministic reconciliation, the catalogue store and the migration runner
 * with its rollback.
 *
 * | scenario                       | what it proves                                                       |
 * | ------------------------------ | -------------------------------------------------------------------- |
 * | malformed M3U                  | nothing silent: every bad line is a typed rejection; the parser never throws |
 * | duplicates / provider variants | one canonical channel per station, one candidate per source           |
 * | slug + identity collisions     | unique identity keys and slugs agree with the unique partial index    |
 * | country normalisation          | country codes resolve deterministically and are never guessed         |
 * | incremental import (A then B)  | a second snapshot adds sources to a channel it did not create         |
 * | repeated idempotent runs       | a re-run creates zero channels and zero candidate ids                 |
 * | rollback of a run              | a run's own records are removed and no other record is                |
 * | migration rollback             | a migration rolls back loudly and re-applies                          |
 *
 * The suite owns a disposable database (`tdt_scenario_*`), drops it in
 * `afterAll`, and never touches `tdt_platform`. `apps/backend/scripts/
 * ingestion-scenario.mjs` runs the same scenarios as a standalone script with
 * compact pass/fail lines; this spec is what the `integration` QA stage runs.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChannelIdentityView, MatchDecision } from '../catalogue-identity/types.js';
import {
  identityKey,
  normalizeChannelName,
  normalizeCountry,
  normalizeLanguage,
} from '../catalogue-identity/normalize.js';
import { reconcile } from '../catalogue-identity/reconcile.js';
import { slugify, uniqueSlug } from '../catalogue-identity/slug.js';
import type {
  ChannelDoc,
  IngestionRunDoc,
  ReconciliationReviewDoc,
  SourceCandidateDoc,
  SourceSnapshotDoc,
} from '../catalogue/schema.js';
import { ChannelStore } from '../catalogue/store.js';
import { COLLECTIONS, connectDatabase, type DatabaseHandle } from '../infrastructure/mongo.js';
import { migrate, rollbackMigration } from '../migrations/runner.js';
import { accumulateMetrics } from './metrics.js';
import { decodePlaylistBytes, parsePlaylistText } from './m3u.js';
import { buildCandidates } from './provenance.js';
import { loadSnapshot, type LoadedPlaylist, snapshotDocument } from './snapshot.js';

const MONGO_URI =
  process.env['TEST_MONGODB_URI'] ?? process.env['MONGODB_URI'] ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0';

/** Fixed instant so every generated document is byte-identical across runs. */
const BASE_TIME = new Date('2026-11-16T14:00:00.000Z');

/** Deterministic UUID-shaped id: the idempotence test compares documents byte for byte. */
function deterministicId(seed: string): string {
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/* ------------------------------------------------------------------------- *
 * Synthetic snapshots — written exactly like the maintainer fetch tool does.
 * ------------------------------------------------------------------------- */

interface SyntheticSnapshot {
  readonly root: string;
  readonly upstream: 'iptv-org' | 'free-tv';
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Writes `<base>/<upstream>-<sha7>/` with a `tdt-snapshot-manifest/1` manifest
 * and its playlist files, so `loadSnapshot` verifies real digests. Paths keep
 * the upstream shape (`streams/es.m3u`, `playlists/playlist_spain.m3u8`)
 * because provenance reads the country from them.
 */
function writeSnapshot(
  base: string,
  upstream: 'iptv-org' | 'free-tv',
  commitSha: string,
  retrievedAt: string,
  files: ReadonlyArray<{ path: string; text: string }>,
): SyntheticSnapshot {
  const root = join(base, `${upstream}-${commitSha.slice(0, 7)}`);
  const declared: { path: string; sha256: string; bytes: number; entries: number }[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(Buffer.from(file.text, 'utf8'));
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    writeFileSync(join(root, file.path), bytes);
    declared.push({
      path: file.path,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      entries: (file.text.match(/^#EXTINF/gmu) ?? []).length,
    });
  }
  const manifest = {
    schemaVersion: 'tdt-snapshot-manifest/1',
    upstream,
    repo: upstream === 'iptv-org' ? 'iptv-org/iptv' : 'Free-TV/IPTV',
    commitSha,
    retrievedAt,
    licence:
      upstream === 'iptv-org'
        ? {
            spdx: 'Unlicense',
            url: 'https://github.com/iptv-org/iptv/blob/master/LICENSE',
            reuse: 'public-domain',
            notes: 'synthetic',
          }
        : { spdx: null, url: 'https://github.com/Free-TV/IPTV', reuse: 'unlicensed', notes: 'synthetic' },
    files: declared,
    fileCount: declared.length,
    entryCount: declared.reduce((sum, file) => sum + file.entries, 0),
    bytes: declared.reduce((sum, file) => sum + file.bytes, 0),
    truncated: false,
  };
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { root, upstream };
}

function loadSynthetic(snapshot: SyntheticSnapshot): { doc: SourceSnapshotDoc; playlists: LoadedPlaylist[] } {
  const load = loadSnapshot(snapshot.root);
  expect(load.integrity, 'a well-formed synthetic snapshot must verify').toBe('ok');
  const doc = snapshotDocument(load, { now: BASE_TIME });
  expect(doc.status).toBe('ingested');
  return { doc, playlists: load.playlists };
}

/* ------------------------------------------------------------------------- *
 * Ingestion driver — the composition the deployment CLI owns; here it is the
 * suite's own use of the frozen module contracts.
 * ------------------------------------------------------------------------- */

interface IngestResult {
  readonly runId: string;
  readonly snapshotId: string;
  readonly createdChannelIds: string[];
  readonly createdCandidateIds: string[];
  readonly reconciled: number;
  readonly review: number;
  readonly duplicates: number;
  readonly rejected: number;
}

function channelFromCandidate(snapshot: SourceSnapshotDoc, candidate: SourceCandidateDoc): ChannelDoc {
  const country = candidate.country;
  const slug = slugify(candidate.name);
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
      key: identityKey(country, normalizeChannelName(candidate.name)),
      country,
      language: normalizeLanguage(candidate.language) ?? 'und',
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
 * the aliases and candidate rows this ingestion wrote.
 *
 * `ChannelStore.listIdentities()` returns the same identity fields but without
 * `tvgIds`/`urlHosts` (reported to the captain: the store's projection cannot
 * satisfy the contract type, which a typecheck of the merged tree shows). This
 * helper keeps the scenario suite measuring reconciliation without editing the
 * store, and it is the only place that difference is visible.
 */
async function knownIdentities(database: DatabaseHandle, store: ChannelStore): Promise<ChannelIdentityView[]> {
  const views = await store.listIdentities(5000);
  const aliases = await database
    .collection<{ _id: string; channelId: string; namespace: string; value: string }>(COLLECTIONS.channelAliases)
    .find({ namespace: 'tvg-id' }, { projection: { channelId: 1, value: 1 } })
    .toArray();
  const candidates = (await database
    .collection<SourceCandidateDoc>(COLLECTIONS.sourceCandidates)
    .find({ channelId: { $ne: null } }, { projection: { channelId: 1, normalizedUrl: 1 } })
    .toArray()) as Pick<SourceCandidateDoc, 'channelId' | 'normalizedUrl'>[];

  const tvgByChannel = new Map<string, string[]>();
  for (const alias of aliases) {
    const list = tvgByChannel.get(alias.channelId) ?? [];
    list.push(alias.value);
    tvgByChannel.set(alias.channelId, list);
  }
  const hostsByChannel = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (candidate.channelId === null) continue;
    let host = '';
    try {
      host = new URL(candidate.normalizedUrl).hostname.toLowerCase();
    } catch {
      host = '';
    }
    if (host === '') continue;
    const list = hostsByChannel.get(candidate.channelId) ?? [];
    if (!list.includes(host)) list.push(host);
    hostsByChannel.set(candidate.channelId, list);
  }

  return views.map((view) => ({
    channelId: view.channelId,
    key: view.key,
    name: view.name,
    country: view.country,
    variantKey: view.variantKey,
    tvgIds: tvgByChannel.get(view.channelId) ?? [],
    urlHosts: hostsByChannel.get(view.channelId) ?? [],
  }));
}

/**
 * Ingests one verified snapshot into the disposable database: the snapshot row,
 * its candidates, the canonical channels they resolve to, the review queue and
 * the run ledger (with the ids it created — the rollback anchor).
 *
 * Idempotent by construction: snapshots and candidates are upserted by their
 * deterministic `_id`, a channel is created only when no stored identity
 * matches, and the run id is a function of its inputs, so a repeated run creates
 * nothing and leaves the documents byte-identical.
 */
async function ingestSnapshot(
  database: DatabaseHandle,
  snapshot: SourceSnapshotDoc,
  playlists: LoadedPlaylist[],
  attempt = 0,
): Promise<IngestResult> {
  const store = new ChannelStore(database);
  const runId = deterministicId(`run:${snapshot._id}:${attempt}`);
  const candidates = buildCandidates(snapshot, playlists);
  const snapshots = database.collection<SourceSnapshotDoc>(COLLECTIONS.sourceSnapshots);
  const runs = database.collection<IngestionRunDoc>(COLLECTIONS.ingestionRuns);
  const channels = database.collection<ChannelDoc>(COLLECTIONS.channels);

  await snapshots.updateOne({ _id: snapshot._id }, { $set: snapshot }, { upsert: true });
  await runs.updateOne(
    { _id: runId },
    {
      $setOnInsert: {
        _id: runId,
        snapshotId: snapshot._id,
        upstream: snapshot.upstream,
        startedAt: BASE_TIME,
        finishedAt: null,
        status: 'running',
        createdChannelIds: [],
        createdCandidateIds: [],
        metrics: accumulateMetrics({ upstream: snapshot.upstream, candidates }),
      } satisfies IngestionRunDoc,
    },
    { upsert: true },
  );

  const createdChannelIds: string[] = [];
  const createdCandidateIds: string[] = [];
  let reconciled = 0;
  let review = 0;
  let duplicates = 0;
  let rejected = 0;

  // Which candidate ids already existed before this pass: a repeated run must
  // report (and claim) nothing new.
  const storedIds = new Set(
    (
      await database
        .collection<SourceCandidateDoc>(COLLECTIONS.sourceCandidates)
        .find({ _id: { $in: candidates.map((candidate) => candidate._id) } }, { projection: { _id: 1 } })
        .toArray()
    ).map((row) => row._id),
  );

  for (const candidate of candidates) {
    if (candidate.state === 'rejected') {
      rejected += 1;
      continue;
    }

    const existedBefore = storedIds.has(candidate._id);
    // Duplicate detection first: the same urlSha256 inside one snapshot on
    // another line is a second source record, never a second channel.
    const reference = await store.findCandidateByUrlSha(candidate.urlSha256, candidate.snapshotId);
    if (reference !== null && reference._id !== candidate._id) {
      if (!existedBefore) {
        await store.insertCandidate({ ...candidate, state: 'duplicate', duplicateOf: reference._id });
        createdCandidateIds.push(candidate._id);
      }
      duplicates += 1;
      continue;
    }

    const decision: MatchDecision = reconcile(candidate, await knownIdentities(database, store));
    let channelId: string;

    if (decision.kind === 'same' && decision.channelId !== null) {
      channelId = decision.channelId;
      reconciled += 1;
    } else if (decision.kind === 'review' && decision.channelId !== null) {
      // A review record keeps the proposal and never the identity: the source
      // cannot join a channel until a human resolves the queue.
      channelId = decision.channelId;
      review += 1;
      await store.queueReview({
        _id: deterministicId(`review:${candidate._id}`),
        candidateId: candidate._id,
        channelId: null,
        proposedChannelId: decision.channelId,
        score: decision.score,
        signals: decision.signals,
        reason: decision.reason,
        status: 'open',
        createdAt: snapshot.retrievedAt,
        resolvedAt: null,
        resolvedBy: null,
      } satisfies ReconciliationReviewDoc);
    } else {
      const channel = channelFromCandidate(snapshot, candidate);
      const taken = new Set((await channels.distinct('slug')) as string[]);
      const resolved: ChannelDoc = { ...channel, slug: uniqueSlug(channel.slug, taken) };
      if ((await channels.findOne({ _id: resolved._id })) === null) {
        await store.upsertChannel(resolved);
        createdChannelIds.push(resolved._id);
      }
      channelId = resolved._id;
    }

    // The tvg-id of every source linked to a channel becomes an alias; that is
    // what lets the next upstream's identical tvg-id corroborate a `same`.
    // The alias index is unique on `{namespace, value}` (one tvg-id, one
    // channel), so a contended value is skipped rather than aborting the run.
    const tvgId = (candidate.attributes['tvg-id'] ?? candidate.attributes['tvg_id'] ?? '').trim();
    if (tvgId !== '') {
      const aliases = database.collection<{ _id: string; channelId: string; namespace: string; value: string }>(
        COLLECTIONS.channelAliases,
      );
      const holder = await aliases.findOne({ namespace: 'tvg-id', value: tvgId }, { projection: { channelId: 1 } });
      if (holder === null) {
        await store.addAlias({
          _id: deterministicId(`alias:tvg:${channelId}:${tvgId}`),
          channelId,
          namespace: 'tvg-id',
          value: tvgId,
          source: candidate.snapshotId,
          confidence: 1,
          createdAt: snapshot.retrievedAt,
        });
      }
    }

    await store.insertCandidate({
      ...candidate,
      channelId,
      state: decision.kind === 'same' ? 'reconciled' : 'staging',
    });
    if (!existedBefore) createdCandidateIds.push(candidate._id);
  }

  const linked = (await database
    .collection<SourceCandidateDoc>(COLLECTIONS.sourceCandidates)
    .find({ snapshotId: snapshot._id })
    .toArray()) as SourceCandidateDoc[];
  const metrics = accumulateMetrics({
    upstream: snapshot.upstream,
    candidates: linked,
    rejectedEntries: rejected,
    manualReview: review,
  });
  await store.finishRun(runId, 'completed', metrics);
  // The ledger records what this run created; a repeat run must not re-claim
  // records it did not create now.
  const ledger = await runs.findOneAndUpdate(
    { _id: runId, createdChannelIds: { $size: 0 } },
    { $set: { createdChannelIds, createdCandidateIds } },
    { returnDocument: 'after' },
  );
  if (ledger === null) {
    await runs.updateOne({ _id: runId }, { $set: { createdChannelIds, createdCandidateIds } });
  }

  return { runId, snapshotId: snapshot._id, createdChannelIds, createdCandidateIds, reconciled, review, duplicates, rejected };
}

/* ------------------------------------------------------------------------- *
 * Counts only: no helper below returns a document body to the caller except
 * the identity assertions that need keys and slugs.
 * ------------------------------------------------------------------------- */

async function countOf(database: DatabaseHandle, collection: string, filter: Record<string, unknown> = {}): Promise<number> {
  return database.db.collection(collection).countDocuments(filter);
}

async function channelIds(database: DatabaseHandle): Promise<string[]> {
  const rows = await database.db.collection(COLLECTIONS.channels).find({}, { projection: { _id: 1 } }).toArray();
  return rows.map((row) => String(row['_id'])).sort();
}

async function candidateIds(database: DatabaseHandle): Promise<string[]> {
  const rows = await database.db.collection(COLLECTIONS.sourceCandidates).find({}, { projection: { _id: 1 } }).toArray();
  return rows.map((row) => String(row['_id'])).sort();
}

/** Digest of the catalogue data (channels + candidates): the whole stored shape. */
async function dataDigest(database: DatabaseHandle): Promise<string> {
  const hash = createHash('sha256');
  for (const name of [COLLECTIONS.channels, COLLECTIONS.sourceCandidates]) {
    const rows = await database.db.collection(name).find({}).sort({ _id: 1 }).toArray();
    hash.update(`${name}:${rows.length}:${JSON.stringify(rows)}\n`, 'utf8');
  }
  return hash.digest('hex');
}

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

const MALFORMED_M3U = [
  '#EXTM3U x-tvg-url="https://example.invalid/epg.xml, https://example.invalid/epg2.xml"',
  '#EXTINF:-1 tvg-id="Canal Uno.es" tvg-country="Spain",Canal Uno',
  '#EXTVLCOPT:http-user-agent=Mozilla/5.0',
  '#EXTVLCOPT:http-referrer=https://example.invalid/',
  'https://a.example.invalid/uno.m3u8',
  '#EXTINF:-1 tvg-id="Canal Dos.es" tvg-country="Spain",Canal Dos',
  'https://b.example.invalid/dos.m3u8',
  '#EXTINF:-1 tvg-id="",',
  'https://c.example.invalid/nameless.m3u8',
  '#EXTINF:0 tvg-id="Sin Url.es",Sin Url',
  'ftp://not-http.example.invalid/x.m3u8',
  'https://orphan.example.invalid/orphan.m3u8',
  '#EXTINF:-1 tvg-id="Canal Tres.es",Canal Tres',
  'rtsp://not-http.example.invalid/tres',
  '#EXTINF:-1 tvg-id="Canal Cinco.es",Canal Cinco',
  '#EXTINF:-1 tvg-id="Canal Cuatro.es" tvg-country="Spain",Canal Cuatro',
  'https://d.example.invalid/cuatro.m3u8',
].join('\r\n');

/** Snapshot A: iptv-org grammar, one station reported by two providers. */
const SNAPSHOT_A_FILES = [
  {
    path: 'streams/es.m3u',
    text: [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="La 1.es@SD",La 1 (720p)',
      'https://la1.example.invalid/sd.m3u8',
      '#EXTINF:-1 tvg-id="La 1.es@SD",La 1 (1080p)',
      'https://la1.pluto.example.invalid/hd.m3u8',
      '#EXTINF:-1 tvg-id="Antena 3.es@SD",Antena 3',
      'https://antena3.example.invalid/live.m3u8',
    ].join('\n'),
  },
  {
    path: 'streams/fr.m3u',
    text: [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="TF1.fr@SD",TF1',
      'https://tf1.example.invalid/live.m3u8',
      '#EXTINF:-1 tvg-id="France 2.fr@SD",France 2',
      'https://france2.example.invalid/live.m3u8',
    ].join('\n'),
  },
];

/** Same snapshot, provider variant: the identical URL reported on another line. */
const SNAPSHOT_A_DUPLICATE_FILE = {
  path: 'streams/es_provider2.m3u',
  text: [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="Antena 3.es@SD",Antena 3 (backup)',
    'https://antena3.example.invalid/live.m3u8',
  ].join('\n'),
};

/** Snapshot B (Free-TV grammar): a second source for La 1 plus two new stations. */
const SNAPSHOT_B_FILES = [
  {
    path: 'playlists/playlist_spain.m3u8',
    text: [
      '#EXTM3U x-tvg-url="https://example.invalid/free-epg.xml"',
      '#EXTINF:-1 tvg-name="La 1 HD" tvg-id="La 1.es" tvg-country="ES" group-title="Spain",La 1',
      'https://la1.freetv.example.invalid/live.m3u8',
      '#EXTINF:-1 tvg-name="Telecinco" tvg-id="Telecinco.es" tvg-country="ES" group-title="Spain",Telecinco',
      'https://telecinco.example.invalid/live.m3u8',
    ].join('\n'),
  },
  {
    path: 'playlists/playlist_mexico.m3u8',
    text: [
      '#EXTM3U',
      '#EXTINF:-1 tvg-name="Canal 5" tvg-id="Canal 5.mx" tvg-country="Mexico" group-title="Mexico",Canal 5',
      'https://canal5.example.invalid/live.m3u8',
    ].join('\n'),
  },
];

const COMMIT_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const COMMIT_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/* ------------------------------------------------------------------------- *
 * Suite
 * ------------------------------------------------------------------------- */

describe('ingestion scenarios (MODULE-CONTRACT-02B, real MongoDB)', () => {
  let base: string;
  let databaseName: string;
  let database: DatabaseHandle;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'tdt-ingestion-scenario-'));
    databaseName = `tdt_scenario_${randomUUID().replace(/-/gu, '').slice(0, 12)}`;
    database = await connectDatabase(MONGO_URI, databaseName);
    await migrate(database);
  });

  afterAll(async () => {
    const admin = await connectDatabase(MONGO_URI, databaseName);
    try {
      await admin.db.dropDatabase();
      await admin.db.command({ ping: 1 });
    } finally {
      await admin.close();
      await database.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('reports every malformed line with a typed reason and keeps the valid entries', () => {
    // Bytes in, as the loader does: the byte decoder normalises CRLF, while
    // `parsePlaylistText` alone splits on `\n` and keeps the `\r` (a deviation
    // reported to the captain, not relied on here).
    const decoded = decodePlaylistBytes(new Uint8Array(Buffer.from(MALFORMED_M3U, 'utf8')));
    const playlist = parsePlaylistText(decoded.text);
    expect(decoded.text.includes('\r')).toBe(false);

    const names = playlist.entries.filter((entry) => entry.rejected === null).map((entry) => entry.name);
    expect(names).toEqual(['Canal Uno', 'Canal Dos', 'Canal Cuatro']);

    const reasons = playlist.rejected.map((line) => line.reason);
    expect(reasons).toContain('missing-name');
    expect(reasons).toContain('no-url');
    expect(reasons).toContain('not-http');
    expect(reasons).toContain('no-extinf');
    expect(playlist.rejected.every((line) => line.line > 0)).toBe(true);
    expect(playlist.stats.rejectedEntries).toBe(playlist.rejected.length);

    // Header attributes are counted, never silently dropped.
    expect(playlist.header.hasXTvgUrl).toBe(true);
    expect(playlist.header.xTvgUrlCount).toBe(2);

    // A directive written before the next `#EXTINF` applies to that entry only.
    expect(playlist.entries.find((entry) => entry.name === 'Canal Uno')?.directives['http-user-agent']).toBe('Mozilla/5.0');
    expect(playlist.entries.find((entry) => entry.name === 'Canal Dos')?.directives['http-user-agent']).toBeUndefined();

    // Bounded: hostile input is rejected, never thrown on.
    expect(() => parsePlaylistText(`#EXTINF:-1 tvg-id="${'x'.repeat(100_000)}`)).not.toThrow();
    expect(parsePlaylistText('').stats.entries).toBe(0);
  });

  it('collapses duplicates and provider variants into one canonical channel per station', async () => {
    const { doc, playlists } = loadSynthetic(
      writeSnapshot(base, 'iptv-org', COMMIT_A, '2026-11-16T14:53:23.000Z', [...SNAPSHOT_A_FILES, SNAPSHOT_A_DUPLICATE_FILE]),
    );
    const result = await ingestSnapshot(database, doc, playlists);
    expect(result.rejected).toBe(0);
    expect(result.duplicates).toBe(1);

    const candidates = (await database
      .collection<SourceCandidateDoc>(COLLECTIONS.sourceCandidates)
      .find({ snapshotId: doc._id }, { projection: { urlSha256: 1, state: 1, duplicateOf: 1 } })
      .toArray()) as Pick<SourceCandidateDoc, 'urlSha256' | 'state' | 'duplicateOf'>[];
    // A repeated URL never becomes a second source: one canonical row plus one
    // row marked duplicate that points at the source it repeats.
    const duplicates = candidates.filter((row) => row.state === 'duplicate');
    expect(duplicates).toHaveLength(1);
    expect(typeof duplicates[0]?.duplicateOf).toBe('string');
    const sources = candidates.filter((row) => row.state !== 'duplicate');
    expect(new Set(sources.map((row) => row.urlSha256)).size).toBe(sources.length);

    // Four stations -> four channels, even though one station reports two sources.
    expect(await countOf(database, COLLECTIONS.channels)).toBe(4);
    expect(await countOf(database, COLLECTIONS.channels, { name: /^Antena 3/u })).toBe(1);

    const channels = (await database.collection<ChannelDoc>(COLLECTIONS.channels).find({}).toArray()) as ChannelDoc[];
    const keys = channels.map((channel) => channel.identity.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never accepts two channels with the same identity key or the same slug', async () => {
    const channels = (await database.collection<ChannelDoc>(COLLECTIONS.channels).find({}).toArray()) as ChannelDoc[];
    const keys = channels.map((channel) => channel.identity.key);
    const slugs = channels.map((channel) => channel.slug);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(slugs).size).toBe(slugs.length);

    // The database-level proof, not only the mapper's.
    const indexes = await database.db.collection(COLLECTIONS.channels).indexes();
    expect(indexes.find((index) => index.name === 'identity_key_unique')?.unique).toBe(true);

    // A colliding slug is resolved deterministically, never silently reused.
    const taken = new Set<string>([slugify('La 1')]);
    const first = uniqueSlug('La 1', taken);
    expect(first).not.toBe(slugify('La 1'));
    expect(uniqueSlug('La 1', taken)).toBe(first);

    // Copying an existing identity key into a second channel violates the index.
    const existing = channels[0];
    expect(existing).toBeDefined();
    if (existing !== undefined) {
      const clash: ChannelDoc = { ...existing, _id: deterministicId('clash'), slug: `${existing.slug}-clash` };
      await expect(new ChannelStore(database).upsertChannel(clash)).rejects.toThrow(/duplicate key/iu);
    }
  });

  it('normalises country names, codes, accents and languages deterministically', () => {
    expect(normalizeCountry('Spain')).toBe('ES');
    expect(normalizeCountry('es')).toBe('ES');
    expect(normalizeCountry('ESPANA')).toBe('ES');
    expect(normalizeCountry('España')).toBe('ES');
    expect(normalizeCountry('Mexico')).toBe('MX');
    expect(normalizeCountry('México')).toBe('MX');

    // Unknown input is never guessed.
    expect(normalizeCountry('Atlantis')).toBeNull();
    expect(normalizeCountry('')).toBeNull();
    expect(normalizeCountry(null)).toBeNull();

    expect(normalizeLanguage('Spanish')).toBe('es');
    expect(normalizeLanguage('es-ES')).toBe('es');
    expect(normalizeLanguage('')).toBeNull();

    // Identity keys follow `cc:normalizedname`, lowercase and accent-folded,
    // and HD tags do not change them.
    expect(identityKey(normalizeCountry('Spain'), normalizeChannelName('La 1 (1080p)'))).toBe(identityKey('ES', 'la 1'));

    // The provenance layer resolves the same ISO code from each upstream's signals.
    const freeTv = loadSynthetic(
      writeSnapshot(base, 'free-tv', COMMIT_B, '2026-11-16T14:56:04.000Z', SNAPSHOT_B_FILES),
    );
    const byCountry = new Map(buildCandidates(freeTv.doc, freeTv.playlists).map((candidate) => [candidate.name, candidate.country]));
    expect(byCountry.get('Telecinco')).toBe('ES');
    expect(byCountry.get('Canal 5')).toBe('MX');
  });

  it('imports incrementally: snapshot B adds sources to a channel it did not create', async () => {
    const before = {
      channels: await countOf(database, COLLECTIONS.channels),
      candidates: await countOf(database, COLLECTIONS.sourceCandidates),
      snapshots: await countOf(database, COLLECTIONS.sourceSnapshots),
    };

    const freeTv = loadSynthetic(writeSnapshot(base, 'free-tv', COMMIT_B, '2026-11-16T14:56:04.000Z', SNAPSHOT_B_FILES));
    const result = await ingestSnapshot(database, freeTv.doc, freeTv.playlists);

    expect(await countOf(database, COLLECTIONS.sourceSnapshots)).toBe(before.snapshots + 1);
    expect(await countOf(database, COLLECTIONS.sourceCandidates)).toBe(before.candidates + 3);

    // La 1 already existed: reconciliation attaches it instead of creating a
    // second La 1 channel, so only Telecinco and Canal 5 are new.
    expect(result.reconciled).toBeGreaterThanOrEqual(1);
    expect(result.createdChannelIds.length).toBeLessThanOrEqual(2);
    expect(await countOf(database, COLLECTIONS.channels)).toBe(before.channels + result.createdChannelIds.length);

    const la1 = (await database.collection<ChannelDoc>(COLLECTIONS.channels).find({ name: /^La 1/u }).toArray()) as ChannelDoc[];
    expect(la1.length).toBe(1);
    const la1Id = la1[0]?._id ?? '';

    // Both upstreams point at the one La 1 channel, with its provenance intact.
    const upstreams = (await database
      .collection<SourceCandidateDoc>(COLLECTIONS.sourceCandidates)
      .distinct('upstream', { channelId: la1Id })) as string[];
    expect(upstreams.sort()).toEqual(['free-tv', 'iptv-org']);
  });

  it('is idempotent: re-running the same snapshot creates zero ids and changes zero documents', async () => {
    const freeTv = loadSynthetic(writeSnapshot(base, 'free-tv', COMMIT_B, '2026-11-16T14:56:04.000Z', SNAPSHOT_B_FILES));

    const channelsBefore = await channelIds(database);
    const candidatesBefore = await candidateIds(database);
    const digestBefore = await dataDigest(database);

    const first = await ingestSnapshot(database, freeTv.doc, freeTv.playlists, 1);
    const second = await ingestSnapshot(database, freeTv.doc, freeTv.playlists, 1);

    // The acceptance criterion itself: zero new channel ids, zero new candidate ids.
    expect(second.createdChannelIds).toHaveLength(0);
    expect(second.createdCandidateIds).toHaveLength(0);
    expect(first.createdChannelIds).toHaveLength(0);
    expect(first.createdCandidateIds).toHaveLength(0);

    expect(await channelIds(database)).toEqual(channelsBefore);
    expect(await candidateIds(database)).toEqual(candidatesBefore);
    // Not just counts: the stored documents are byte-identical.
    expect(await dataDigest(database)).toBe(digestBefore);
  });

  it('rolls a run back to exactly the data it created, leaving other runs intact', async () => {
    const { doc, playlists } = loadSynthetic(
      writeSnapshot(base, 'iptv-org', 'cccccccccccccccccccccccccccccccccccccccc', '2026-11-16T15:10:00.000Z', [
        {
          path: 'streams/it.m3u',
          text: ['#EXTM3U', '#EXTINF:-1 tvg-id="Rai 1.it@SD",Rai 1', 'https://rai1.example.invalid/live.m3u8'].join('\n'),
        },
      ]),
    );

    const channelsBefore = await channelIds(database);
    const candidatesBefore = await candidateIds(database);
    const digestBefore = await dataDigest(database);

    const run = await ingestSnapshot(database, doc, playlists);
    expect(run.createdChannelIds).toHaveLength(1);
    expect(run.createdCandidateIds).toHaveLength(1);
    expect(await dataDigest(database)).not.toBe(digestBefore);

    const store = new ChannelStore(database);
    expect((await store.rollbackRun(run.runId)).removed).toBe(2);

    expect(await channelIds(database)).toEqual(channelsBefore);
    expect(await candidateIds(database)).toEqual(candidatesBefore);
    expect(await dataDigest(database)).toBe(digestBefore);

    // The run survives as an audit record, marked rolled back.
    const runs = (await database.collection<IngestionRunDoc>(COLLECTIONS.ingestionRuns).find({}).toArray()) as IngestionRunDoc[];
    expect(runs.find((entry) => entry._id === run.runId)?.status).toBe('rolled-back');

    // An unknown run removes nothing: a rollback is never a blanket delete.
    expect((await store.rollbackRun(deterministicId('missing'))).removed).toBe(0);
    expect(await dataDigest(database)).toBe(digestBefore);
  });

  it('rolls a migration back loudly through the real runner and re-applies it', async () => {
    await rollbackMigration(database, '006-incremental-dedup');
    // Rolling the same step back twice refuses instead of pretending.
    await expect(rollbackMigration(database, '006-incremental-dedup')).rejects.toThrow(/not applied/iu);
    // Unknown migrations and steps without a rollback are refused too.
    await expect(rollbackMigration(database, 'no-such-migration')).rejects.toThrow(/Unknown migration/iu);
    await expect(rollbackMigration(database, '002-epg-editorial-source')).rejects.toThrow(/no rollback/iu);

    const again = await migrate(database);
    expect(again.applied).toEqual(['006-incremental-dedup']);
    const indexes = await database.db.collection(COLLECTIONS.channels).indexes();
    expect(indexes.some((index) => index.name === 'identity_key_unique')).toBe(true);
  });
});
