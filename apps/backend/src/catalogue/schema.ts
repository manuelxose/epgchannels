/**
 * Catalogue document models and index definitions (MODULE-CONTRACT-02B §2).
 *
 * This module owns the *new* catalogue concepts: canonical channel identity,
 * source snapshots/candidates, aliases, variants, authorisation, health, EPG
 * mappings, the reconciliation review queue and the ingestion-run ledger.
 *
 * The existing `ChannelDoc` (in `../infrastructure/schema.js`) is kept verbatim;
 * the extension below is backward compatible because the new fields are only
 * backfilled by migration `004-catalogue-identity` and never rewrites the rest.
 *
 * Integration note: the contract names `ingestion/metrics.ts` as the canonical
 * home of `IngestionMetrics` (§3.4) and `catalogue-identity/normalize.ts` as the
 * home of `ChannelIdentityView` (§3.2). Both owners work in separate worktrees,
 * so this file declares structurally identical local definitions to keep this
 * worktree self-contained; the integration branch switches these to the shared
 * imports once those files land.
 */
import type { Db } from 'mongodb';
import type { ChannelDoc as BaseChannelDoc } from '../infrastructure/schema.js';

/* ------------------------------------------------------------------------- *
 * Channel extension (§2.1)
 * ------------------------------------------------------------------------- */

export interface ChannelIdentityDoc {
  /** Stable key for deterministic reconciliation: `cc:normalizedname`. */
  key: string;
  /** ISO 3166-1 alpha-2, or `null` when the country is genuinely unknown. */
  country: string | null;
  /** BCP-47 primary, lowercase. */
  language: string;
  /** Regional / local qualifier, never folded into the name. */
  variantKey: string | null;
  network: string | null;
}

/** The extended channel document. New fields are backfilled by migration 004. */
export interface ChannelDoc extends BaseChannelDoc {
  identity: ChannelIdentityDoc;
  /** What the slug was derived from; null when it was not re-derived. */
  publicSlugSource: string | null;
  /** Staging by default; pre-existing records are backfilled to `approved`. */
  catalogueState: 'staging' | 'approved';
}

/* ------------------------------------------------------------------------- *
 * Source snapshots and candidates (§2.2)
 * ------------------------------------------------------------------------- */

export interface SourceSnapshotDoc {
  /** sha256 of the archive content. */
  _id: string;
  upstream: 'iptv-org' | 'free-tv';
  upstreamUrl: string;
  commitSha: string | null;
  retrievedAt: Date;
  checksumSha256: string;
  licence: {
    spdx: string | null;
    url: string | null;
    reuse: 'public-domain' | 'permitted-with-attribution' | 'unlicensed';
    notes: string;
  };
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
  /** e.g. `streams/es.m3u`. */
  upstreamPath: string;
  line: number;
  rawName: string;
  rawAttributes: Record<string, string>;
  retrievedAt: Date;
  checksumSha256: string;
}

export interface SourceCandidateDoc {
  /** uuid v5(snapshotId:path:line:url). */
  _id: string;
  /** null until reconciled. */
  channelId: string | null;
  snapshotId: string;
  upstream: string;
  url: string;
  /** host lower, default port dropped, tracking params removed. */
  normalizedUrl: string;
  urlSha256: string;
  type: string;
  name: string;
  attributes: Record<string, string>;
  /** ISO alpha-2 or null. */
  country: string | null;
  /** tvg-id network/group hint, or emitter host. */
  provider: string | null;
  groupTitle: string | null;
  language: string | null;
  quality: 'SD' | 'HD' | 'FHD' | 'UHD' | null;
  flags: string[];
  provenance: SourceProvenanceDoc;
  state: 'staging' | 'duplicate' | 'unmatched' | 'reconciled' | 'rejected';
  rejectionReason: string | null;
  /** candidate _id. */
  duplicateOf: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/* ------------------------------------------------------------------------- *
 * Aliases, variants, authorisation, health, EPG, review, runs (§2.2)
 * ------------------------------------------------------------------------- */

export interface ChannelAliasDoc {
  _id: string;
  channelId: string;
  namespace: 'tvg-id' | 'epgshare' | 'name' | 'slug' | 'external';
  value: string;
  /** upstream id. */
  source: string;
  confidence: number;
  createdAt: Date;
}

export interface ChannelVariantDoc {
  _id: string;
  channelId: string;
  region: string | null;
  locality: string | null;
  /** e.g. `es-cat` or `us-chicago`. */
  variantKey: string;
  label: string;
  reason: 'regional' | 'local' | 'timezone' | 'feed';
}

export interface SourceAuthorizationDoc {
  /** channelId + ':' + candidateId. */
  _id: string;
  candidateId: string;
  channelId: string;
  decision: 'approved' | 'rejected' | 'pending';
  licenceReuse: string;
  conditions: {
    embedAllowed: boolean;
    proxyAllowed: boolean;
    requiresForgedHeader: boolean;
    emitterAppOnly: boolean;
    worldwide: boolean;
    restrictedRegions: string[];
  };
  decidedBy: string;
  decidedAt: Date;
  notes: string | null;
}

export interface SourceHealthDoc {
  /** candidateId. */
  _id: string;
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

/**
 * Shared ingestion metrics (contract §3.4). Canonical owner is
 * `ingestion/metrics.ts`; declared locally until integration.
 */
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

export interface IngestionRunDoc {
  /** runId (uuid). */
  _id: string;
  snapshotId: string;
  upstream: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: 'running' | 'completed' | 'rolled-back' | 'failed';
  createdChannelIds: string[];
  createdCandidateIds: string[];
  metrics: IngestionMetrics;
}

/**
 * Projection consumed by identity reconciliation. Canonical owner is
 * `catalogue-identity/normalize.ts`; declared locally until integration.
 */
export interface ChannelIdentityView {
  channelId: string;
  key: string;
  name: string;
  country: string | null;
  /** BCP-47 primary, projected by the store but not consumed for identity. */
  language?: string | null;
  variantKey: string | null;
  /** Raw `tvg-id` aliases known for this channel. */
  tvgIds?: string[];
  /** Normalized URL hosts of known sources for this channel. */
  urlHosts?: string[];
}

/* ------------------------------------------------------------------------- *
 * Index definitions (§2.3)
 * ------------------------------------------------------------------------- */

export interface CatalogueIndex {
  readonly key: Record<string, 1 | -1>;
  readonly name: string;
  readonly unique?: boolean;
  readonly partialFilterExpression?: Record<string, unknown>;
}

/** Channels extension indexes (migration 004). */
export const CHANNEL_IDENTITY_INDEXES: readonly CatalogueIndex[] = [
  {
    key: { 'identity.key': 1 },
    name: 'identity_key_unique',
    unique: true,
    partialFilterExpression: { 'identity.key': { $exists: true }, mergedInto: null },
  },
  { key: { 'identity.country': 1, 'identity.language': 1 }, name: 'identity_country_language' },
];

/** Snapshot and candidate indexes (migration 005). */
export const SNAPSHOT_INDEXES: readonly CatalogueIndex[] = [
  { key: { upstream: 1, retrievedAt: -1 }, name: 'snapshot_upstream_retrieved' },
  {
    key: { upstream: 1, commitSha: 1, checksumSha256: 1 },
    name: 'snapshot_identity_unique',
    unique: true,
  },
];

export const CANDIDATE_INDEXES: readonly CatalogueIndex[] = [
  {
    /*
     * The natural key of a candidate is the LINE IT WAS FOUND ON, and a line
     * number is only unique within one upstream file. Without
     * `provenance.upstreamPath` two different files of the same snapshot that
     * carry the same URL on the same line number collide (E11000), which aborts
     * a real ingest — the captured iptv-org snapshot reproduces it. The name is
     * new because MongoDB cannot alter an existing index's key in place:
     * migration 007 drops the old `candidate_snapshot_url_line_unique` first.
     */
    key: { snapshotId: 1, 'provenance.upstreamPath': 1, urlSha256: 1, 'provenance.line': 1 },
    name: 'candidate_line_in_file_unique',
    unique: true,
  },
  { key: { 'provenance.upstreamPath': 1 }, name: 'candidate_upstream_path' },
  { key: { urlSha256: 1 }, name: 'candidate_url' },
  { key: { channelId: 1, state: 1 }, name: 'candidate_channel_state' },
  { key: { state: 1, upstream: 1 }, name: 'candidate_state_upstream' },
  { key: { 'provenance.upstreamPath': 1 }, name: 'candidate_upstream_path' },
];

/** Identity-support and dedup indexes (migration 006). */
export const DEDUP_INDEXES: Readonly<Record<string, readonly CatalogueIndex[]>> = {
  channel_aliases: [
    {
      key: { namespace: 1, value: 1, channelId: 1 },
      name: 'alias_namespace_value_channel_unique',
      unique: true,
    },
    { key: { namespace: 1, value: 1 }, name: 'alias_namespace_value' },
    { key: { channelId: 1 }, name: 'alias_channel' },
  ],
  channel_variants: [
    { key: { channelId: 1, variantKey: 1 }, name: 'variant_channel_key_unique', unique: true },
  ],
  source_authorization: [
    { key: { candidateId: 1 }, name: 'authorization_candidate_unique', unique: true },
    { key: { channelId: 1, decision: 1 }, name: 'authorization_channel_decision' },
  ],
  source_health: [
    { key: { candidateId: 1 }, name: 'health_candidate_unique', unique: true },
    { key: { state: 1, nextCheckAt: 1 }, name: 'health_state_next_check' },
  ],
  epg_mappings: [
    {
      key: { channelId: 1, namespace: 1, externalId: 1 },
      name: 'epg_channel_namespace_external_unique',
      unique: true,
    },
  ],
  reconciliation_review: [
    { key: { status: 1, createdAt: 1 }, name: 'review_status_created' },
    { key: { candidateId: 1 }, name: 'review_candidate_unique', unique: true },
  ],
  ingestion_runs: [
    { key: { snapshotId: 1 }, name: 'run_snapshot' },
    { key: { status: 1, startedAt: -1 }, name: 'run_status_started' },
  ],
};

/**
 * Pre-fix `channel_aliases` unique index (`{namespace, value}`). A tvg-id may
 * legitimately belong to more than one channel, so migration 006 replaces this
 * with `alias_namespace_value_channel_unique`.
 */
export const LEGACY_ALIAS_UNIQUE_INDEX = 'alias_namespace_value_unique';

/** Creates a set of indexes idempotently. Never drops anything. */
export async function createCatalogueIndexes(
  db: Db,
  collection: string,
  indexes: readonly CatalogueIndex[],
): Promise<void> {
  for (const index of indexes) {
    await db.collection(collection).createIndex(index.key, {
      name: index.name,
      ...(index.unique === undefined ? {} : { unique: index.unique }),
      ...(index.partialFilterExpression === undefined
        ? {}
        : { partialFilterExpression: index.partialFilterExpression }),
    });
  }
}

/** Drops only the named indexes; a missing index or collection is a no-op. */
export async function dropCatalogueIndexes(
  db: Db,
  collection: string,
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    try {
      await db.collection(collection).dropIndex(name);
    } catch (error) {
      const codeName = (error as { codeName?: string } | null)?.codeName;
      if (codeName === 'IndexNotFound' || codeName === 'NamespaceNotFound') continue;
      throw error;
    }
  }
}
