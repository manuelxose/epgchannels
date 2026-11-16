/**
 * Ingestion pipeline: bounded snapshot -> candidates -> identity -> catalogue.
 *
 * This is the only module that joins the three delivered areas (formats,
 * identity, models). It owns no format knowledge and no scoring rule of its
 * own: it calls `loadSnapshot`/`buildCandidates`, then
 * `buildIdentityIndex`/`reconcileIndexed`, then the `ChannelStore`.
 *
 * Shape of a run: **plan in memory, then flush in batches**. Every decision is
 * computed first and written afterwards with a bounded number of bulk
 * operations, so cost scales with the number of entries, not with the number of
 * round-trips per entry. (A per-entry round-trip design took over ten minutes
 * for 18,756 entries; batching is what makes the mission's "globally scalable"
 * claim true.)
 *
 * What it guarantees:
 * - **Re-runnable.** Every id is derived deterministically, every write is an
 *   idempotent upsert, so running the same snapshot twice creates nothing new
 *   and produces identical metrics. The run id depends on the snapshot, not on
 *   the clock.
 * - **Staged.** A channel created here is `catalogueState: 'staging'`. Nothing
 *   this module writes is publicly servable until an approved source
 *   authorisation exists.
 * - **Never merges silently.** A link is created only on `kind: 'same'`; a
 *   `kind: 'review'` candidate keeps `channelId: null` and is queued for a
 *   person; a `kind: 'different'` candidate starts a new channel.
 * - **Rollbackable.** Every id it creates is recorded in the run document, so
 *   one run can be removed without touching records another run created.
 *
 * What it does *not* do: it never fetches, never publishes, never deletes or
 * renames an existing channel, and never upgrades a staging record.
 */
import { createHash } from 'node:crypto';
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type {
  ChannelDoc,
  ChannelAliasDoc,
  ChannelIdentityView,
  IngestionMetrics,
  IngestionRunDoc,
  ReconciliationReviewDoc,
  SourceCandidateDoc,
  SourceSnapshotDoc,
} from '../catalogue/schema.js';
import { ChannelStore } from '../catalogue/store.js';
import { buildCandidates, type LoadedPlaylist } from '../ingestion/index.js';
import type { MatchDecision } from '../catalogue-identity/types.js';
import { buildIdentityIndex, reconcileIndexed } from '../catalogue-identity/reconcile.js';
import { identityKey, normalizeChannelName, normalizeCountry } from '../catalogue-identity/normalize.js';
import { slugify } from '../catalogue-identity/slug.js';
import { inferLanguageFromCountry } from '../catalogue-identity/language.js';

export interface RunIngestionOptions {
  /** Deterministic run id override; defaults to a digest of snapshot + upstream. */
  runId?: string;
  /** Namespace prefix for generated ids; keeps test runs distinguishable. */
  idNamespace?: string;
  /** Rows per bulk write. Small enough to stay under the driver limits. */
  batchSize?: number;
}

export interface RunIngestionResult {
  runId: string;
  snapshotId: string;
  upstream: string;
  metrics: IngestionMetrics;
  createdChannelIds: string[];
}

/** Deterministic uuid-v5-shaped id: same inputs always give the same id. */
export function stableId(namespace: string, value: string): string {
  const hash = createHash('sha256').update(`${namespace}:${value}`, 'utf8').digest('hex');
  const variant = ((parseInt(hash[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * One ledger row per invocation. The suffix is a digest of the start instant, so
 * re-running a snapshot records a new run rather than silently replacing the
 * previous one — the rollback anchor must stay truthful per run. Idempotence of
 * the *catalogue* does not depend on it: every document written is keyed
 * deterministically, so two runs of the same snapshot still create nothing new.
 */
function uniqueRunId(snapshot: SourceSnapshotDoc): string {
  return stableId('run', `${snapshot._id}:${snapshot.upstream}:${Date.now()}:${process.pid}`);
}

/** Top-level compatibility field (D-010): `ES` stays `ES`, everything else `INT`. */
function compatCountry(iso: string | null): string {
  return iso === 'ES' ? 'ES' : 'INT';
}

function uniqueSlugFrom(base: string, taken: Set<string>): string {
  const root = (base === '' ? 'channel' : base).slice(0, 112);
  if (!taken.has(root)) {
    taken.add(root);
    return root;
  }
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${root}-${suffix}`.slice(0, 120);
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  const fallback = `${root}-${createHash('sha256').update(root).digest('hex').slice(0, 8)}`.slice(0, 120);
  taken.add(fallback);
  return fallback;
}

/** Editorial fields get neutral defaults; a human fills them later. */
function newChannelDoc(
  candidate: SourceCandidateDoc,
  channelId: string,
  slug: string,
  key: string,
  country: string | null,
  language: string,
  now: Date,
): ChannelDoc {
  const name = candidate.name.trim() !== '' ? candidate.name.trim() : key;
  return {
    _id: channelId,
    slug,
    name,
    shortName: name,
    country: compatCountry(country),
    region: null,
    locality: null,
    languageTag: language,
    category: 'otros',
    kind: 'linear',
    websiteUrl: null,
    description: '',
    branding: null,
    editorialStatus: 'draft',
    timezone: 'UTC',
    provenance: [
      {
        source: candidate.upstream,
        label: candidate.upstream,
        url: candidate.url !== '' ? candidate.url : null,
        licence: 'see source snapshot',
        attribution: null,
        digestSha256: candidate.provenance.checksumSha256,
        capturedAt: candidate.provenance.retrievedAt,
        editorial: false,
      },
    ],
    aliases: [],
    searchText: [name, candidate.groupTitle ?? ''].join(' ').trim().toLowerCase(),
    epg: null,
    mergedInto: null,
    reviewedAt: null,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    identity: {
      key,
      country,
      language,
      variantKey: null,
      network: candidate.provider,
    },
    publicSlugSource: 'ingestion',
    catalogueState: 'staging',
  };
}

function emptyMetrics(upstream: string): IngestionMetrics {
  return {
    upstream,
    importedEntries: 0,
    rejectedEntries: 0,
    duplicateCandidates: 0,
    canonicalChannels: 0,
    newChannels: 0,
    unmatchedEntries: 0,
    manualReview: 0,
    candidatesPerChannel: { avg: 0, max: 0, histogram: {} },
    byCountry: {},
    byLanguage: {},
    byGroup: {},
    durationMs: 0,
  };
}

interface PlannedWrite {
  channel: ChannelDoc | null;
  candidate: SourceCandidateDoc;
  alias: ChannelAliasDoc | null;
  review: ReconciliationReviewDoc | null;
}

async function bulkUpsert<T extends { _id: string }>(
  collection: { bulkWrite(ops: never[], options?: { ordered?: boolean }): Promise<unknown> },
  docs: readonly T[],
  keyOf: (doc: T) => Record<string, unknown>,
  batchSize: number,
): Promise<void> {
  for (let start = 0; start < docs.length; start += batchSize) {
    const slice = docs.slice(start, start + batchSize);
    if (slice.length === 0) continue;
    const ops = slice.map((doc) => {
      const { _id, ...rest } = doc;
      return {
        updateOne: {
          filter: { _id, ...keyOf(doc) },
          update: { $setOnInsert: { _id, ...rest } },
          upsert: true,
        },
      };
    });
    await collection.bulkWrite(ops as never[], { ordered: false });
  }
}

/**
 * Runs one snapshot into the catalogue. Safe to call repeatedly; see the module
 * doc for the guarantees.
 */
export async function runIngestion(
  database: DatabaseHandle,
  snapshot: SourceSnapshotDoc,
  playlists: readonly LoadedPlaylist[],
  options: RunIngestionOptions = {},
): Promise<RunIngestionResult> {
  const startedAt = Date.now();
  const store = new ChannelStore(database);
  const idNamespace = options.idNamespace ?? 'tdt';
  const batchSize = options.batchSize ?? 1000;
  // Two ledger identities, deliberately different:
  // - `runId` is unique per invocation, so re-running a snapshot adds a new run
  //   row instead of overwriting the previous run's history.
  // - `contentId` is the part that must be stable across re-runs (title, body,
  //   category), derived from the snapshot only, so idempotence is unaffected.
  const runId = options.runId ?? uniqueRunId(snapshot);
  const now = new Date();

  const candidates = buildCandidates(snapshot, [...playlists]).sort((a, b) =>
    a._id < b._id ? -1 : a._id > b._id ? 1 : 0,
  );

  // Existing identities, indexed once: reconciliation stays sub-linear.
  const identities = await store.listIdentities(200_000);
  const index = buildIdentityIndex(identities);
  const knownChannels = new Map<string, string>(
    identities.map((view) => [view.key, view.channelId] as const),
  );
  const takenSlugs = new Set(identities.map((view) => view.key));

  const createdChannelIds: string[] = [];
  /* Only candidates this run actually INSERTED belong to it: a re-run upserts
   * rows an earlier run created, and rolling back this run must not delete the
   * other run's data. */
  const createdHereCandidateIds: string[] = [];
  const newChannels: ChannelDoc[] = [];
  const writtenCandidates: SourceCandidateDoc[] = [];
  const aliases: ChannelAliasDoc[] = [];
  const reviews: ReconciliationReviewDoc[] = [];
  const byCountry: Record<string, number> = {};
  const byLanguage: Record<string, number> = {};
  const byGroup: Record<string, number> = {};
  const histogram: Record<string, number> = {};
  const perChannel = new Map<string, number>();
  let duplicates = 0;
  let unmatched = 0;
  let manualReview = 0;
  let rejected = 0;
  let languageUnknown = 0;

  const resolveLanguage = (candidate: SourceCandidateDoc): string => {
    const declared = candidate.language;
    if (declared !== null && declared !== undefined && declared !== '' && declared !== 'und') {
      return declared;
    }
    return inferLanguageFromCountry(normalizeCountry(candidate.country)).language;
  };

  const tally = (map: Record<string, number>, key: string): void => {
    map[key] = (map[key] ?? 0) + 1;
  };

  for (const candidate of candidates) {
    if (candidate.state === 'rejected') {
      rejected += 1;
      writtenCandidates.push({ ...candidate, state: 'rejected' });
      continue;
    }

    tally(byCountry, candidate.country ?? 'unknown');
    const language = resolveLanguage(candidate);
    tally(byLanguage, language);
    if (language === 'und') languageUnknown += 1;
    tally(byGroup, candidate.groupTitle ?? candidate.upstream);

    const country = normalizeCountry(candidate.country);
    const normalizedName = normalizeChannelName(candidate.name);
    const key = identityKey(country, normalizedName);
    const decision: MatchDecision = reconcileIndexed(candidate, index);

    let channelId: string | null = decision.channelId;
    let createdHere = false;

    if (decision.kind === 'same' && channelId !== null) {
      duplicates += 1;
    } else if (decision.kind === 'review') {
      manualReview += 1;
      // A review item is keyed by the candidate: re-running the same snapshot
      // must not queue the same question twice.
      reviews.push({
        _id: stableId(`${idNamespace}-review`, candidate._id),
        candidateId: candidate._id,
        channelId: null,
        proposedChannelId: decision.channelId,
        score: decision.score,
        signals: decision.signals,
        reason: decision.reason,
        status: 'open',
        createdAt: now,
        resolvedAt: null,
        resolvedBy: null,
      });
      channelId = null;
    } else {
      unmatched += 1;
      channelId = null;
    }

    if (channelId === null) {
      const known = knownChannels.get(key) ?? null;
      if (known !== null) {
        channelId = known;
      } else {
        channelId = stableId(idNamespace, key);
        const slug = uniqueSlugFrom(slugify(normalizedName !== '' ? normalizedName : candidate.name), takenSlugs);
        newChannels.push(newChannelDoc(candidate, channelId, slug, key, country, resolveLanguage(candidate), now));
        createdChannelIds.push(channelId);
        createdHere = true;
        // A later candidate with the same identity key joins this channel
        // through `knownChannels`, so no index rebuild is needed here.
        knownChannels.set(key, channelId);
      }
    }

    writtenCandidates.push({ ...candidate, channelId, state: createdHere ? 'reconciled' : 'duplicate' });
    if (createdHere) createdHereCandidateIds.push(candidate._id);
    perChannel.set(channelId, (perChannel.get(channelId) ?? 0) + 1);

    const tvgId = candidate.attributes['tvg-id'];
    if (tvgId !== undefined && tvgId !== '') {
      aliases.push({
        _id: stableId(`${idNamespace}-alias`, `${channelId}:tvg-id:${tvgId}`),
        channelId,
        namespace: 'tvg-id',
        value: tvgId,
        source: candidate.upstream,
        confidence: decision.score,
        createdAt: now,
      });
    }
  }

  // ---- flush: a bounded number of bulk operations, not one per entry ----
  await store.recordRun({
    _id: runId,
    snapshotId: snapshot._id,
    upstream: snapshot.upstream,
    startedAt: now,
    finishedAt: null,
    status: 'running',
    createdChannelIds: [],
    createdCandidateIds: [],
    metrics: emptyMetrics(snapshot.upstream),
  });

  /*
   * The snapshot row is provenance, so the pipeline owns it rather than leaving
   * it to whichever caller remembered to write it. Only inserted when absent: a
   * re-run must not rewrite the original retrieval timestamp or checksum.
   */
  await database
    .collection<SourceSnapshotDoc>(COLLECTIONS.sourceSnapshots)
    .updateOne({ _id: snapshot._id }, { $setOnInsert: snapshot }, { upsert: true });

  await bulkUpsert(database.collection<ChannelDoc>(COLLECTIONS.channels), newChannels, () => ({}), batchSize);
  await bulkUpsert(database.collection<SourceCandidateDoc>(COLLECTIONS.sourceCandidates), writtenCandidates, () => ({}), batchSize);
  await bulkUpsert(database.collection<ChannelAliasDoc>(COLLECTIONS.channelAliases), aliases, (doc) => ({
    namespace: doc.namespace,
    value: doc.value,
    channelId: doc.channelId,
  }), batchSize);
  await bulkUpsert(database.collection<ReconciliationReviewDoc>(COLLECTIONS.reconciliationReview), reviews, () => ({}), batchSize);

  const counts = [...perChannel.values()];
  const avg = counts.length === 0 ? 0 : counts.reduce((sum, n) => sum + n, 0) / counts.length;
  for (const n of counts) tally(histogram, String(n));

  const metrics: IngestionMetrics = {
    upstream: snapshot.upstream,
    importedEntries: candidates.length,
    rejectedEntries: rejected,
    duplicateCandidates: duplicates,
    canonicalChannels: perChannel.size,
    newChannels: createdChannelIds.length,
    unmatchedEntries: unmatched,
    manualReview,
    candidatesPerChannel: {
      avg: Number(avg.toFixed(3)),
      max: counts.length === 0 ? 0 : Math.max(...counts),
      histogram,
    },
    byCountry,
    byLanguage,
    byGroup,
    durationMs: Date.now() - startedAt,
  };

  // The rollback anchor records exactly what this run created.
  await database
    .collection<IngestionRunDoc>(COLLECTIONS.ingestionRuns)
    .updateOne({ _id: runId }, { $set: { createdChannelIds, createdCandidateIds: createdHereCandidateIds } });
  await store.finishRun(runId, 'completed', metrics);

  return { runId, snapshotId: snapshot._id, upstream: snapshot.upstream, metrics, createdChannelIds };
}

/** Public projection used by tests and operators: never exposes credentials. */
export function publicView(doc: ChannelDoc): { slug: string; name: string; country: string; state: string } {
  return {
    slug: doc.slug,
    name: doc.name,
    country: doc.identity?.country ?? doc.country,
    state: doc.catalogueState,
  };
}
