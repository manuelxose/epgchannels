/**
 * `ChannelStore`: the deterministic, idempotent write surface for the new
 * catalogue concepts, against a `DatabaseHandle` (MODULE-CONTRACT-02B §3.3).
 *
 * Idempotency rule: every write is keyed by its document `_id`, which is a
 * deterministic UUID v5 (stable-ids rule). A re-run therefore updates the same
 * record instead of creating a duplicate. Multi-document deletes use `$in` so a
 * missing id is a no-op, and no single failure aborts unrelated writes.
 *
 * What it does *not* do: it never assigns identity (callers supply `_id` and
 * `identity.key`), never rewrites a channel's `slug`/`mergedInto`/relationships,
 * never publishes anything, and never touches the runtime network.
 */
import type { Collection } from 'mongodb';
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type {
  ChannelAliasDoc,
  ChannelDoc,
  ChannelIdentityView,
  ChannelVariantDoc,
  IngestionMetrics,
  IngestionRunDoc,
  ReconciliationReviewDoc,
  SourceCandidateDoc,
} from './schema.js';

export class ChannelStore {
  private readonly channels: Collection<ChannelDoc>;
  private readonly candidates: Collection<SourceCandidateDoc>;
  private readonly aliases: Collection<ChannelAliasDoc>;
  private readonly variants: Collection<ChannelVariantDoc>;
  private readonly reviews: Collection<ReconciliationReviewDoc>;
  private readonly runs: Collection<IngestionRunDoc>;

  constructor(database: DatabaseHandle) {
    this.channels = database.collection<ChannelDoc>(COLLECTIONS.channels);
    this.candidates = database.collection<SourceCandidateDoc>(COLLECTIONS.sourceCandidates);
    this.aliases = database.collection<ChannelAliasDoc>(COLLECTIONS.channelAliases);
    this.variants = database.collection<ChannelVariantDoc>(COLLECTIONS.channelVariants);
    this.reviews = database.collection<ReconciliationReviewDoc>(COLLECTIONS.reconciliationReview);
    this.runs = database.collection<IngestionRunDoc>(COLLECTIONS.ingestionRuns);
  }

  /** Deterministic upsert by `_id`: same id, same document, forever. */
  async upsertChannel(doc: ChannelDoc): Promise<void> {
    await this.channels.replaceOne({ _id: doc._id }, doc, { upsert: true });
  }

  /** Finds the active (non-merged) channel for an identity key. */
  async findByKey(key: string): Promise<ChannelDoc | null> {
    return this.channels.findOne({ 'identity.key': key, mergedInto: null });
  }

  /** Bounded, deterministically ordered identity projections for reconciliation. */
  async listIdentities(limit = 1000): Promise<ChannelIdentityView[]> {
    const docs = await this.channels
      .find(
        { 'identity.key': { $exists: true }, mergedInto: null },
        { projection: { _id: 1, name: 1, identity: 1 } },
      )
      .sort({ 'identity.key': 1 })
      .limit(limit)
      .toArray();
    return docs.map((doc) => ({
      channelId: doc._id,
      key: doc.identity.key,
      name: doc.name,
      country: doc.identity.country,
      language: doc.identity.language,
      variantKey: doc.identity.variantKey,
    }));
  }

  /** Idempotent insert: a repeated insert of the same `_id` is a no-op. */
  async insertCandidate(doc: SourceCandidateDoc): Promise<void> {
    const { _id, ...rest } = doc;
    await this.candidates.updateOne({ _id }, { $setOnInsert: rest }, { upsert: true });
  }

  async findCandidateByUrlSha(urlSha256: string, snapshotId: string): Promise<SourceCandidateDoc | null> {
    return this.candidates.findOne({ urlSha256, snapshotId });
  }

  /** Resolves an alias through the `channel_aliases` collection to its channel. */
  async findByAlias(namespace: string, value: string): Promise<ChannelDoc | null> {
    const alias = await this.aliases.findOne({
      namespace: namespace as ChannelAliasDoc['namespace'],
      value,
    });
    if (!alias) return null;
    return this.channels.findOne({ _id: alias.channelId });
  }

  async addAlias(doc: ChannelAliasDoc): Promise<void> {
    const { _id, ...rest } = doc;
    await this.aliases.updateOne({ _id }, { $setOnInsert: rest }, { upsert: true });
  }

  async addVariant(doc: ChannelVariantDoc): Promise<void> {
    const { _id, ...rest } = doc;
    await this.variants.updateOne({ _id }, { $setOnInsert: rest }, { upsert: true });
  }

  async queueReview(doc: ReconciliationReviewDoc): Promise<void> {
    const { _id, ...rest } = doc;
    await this.reviews.updateOne({ _id }, { $setOnInsert: rest }, { upsert: true });
  }

  async recordRun(doc: IngestionRunDoc): Promise<void> {
    const { _id, ...rest } = doc;
    await this.runs.updateOne({ _id }, { $setOnInsert: rest }, { upsert: true });
  }

  async finishRun(
    runId: string,
    status: 'completed' | 'failed',
    metrics: IngestionMetrics,
  ): Promise<void> {
    await this.runs.updateOne(
      { _id: runId },
      { $set: { status, finishedAt: new Date(), metrics } },
    );
  }

  /**
   * Rolls a run back by deleting exactly the channels and candidates the ledger
   * recorded as created by it, then marks the run `rolled-back`. It never
   * deletes records created by another run.
   */
  async rollbackRun(runId: string): Promise<{ removed: number }> {
    const run = await this.runs.findOne({ _id: runId });
    if (!run) return { removed: 0 };
    const [channels, candidates] = await Promise.all([
      this.channels.deleteMany({ _id: { $in: run.createdChannelIds } }),
      this.candidates.deleteMany({ _id: { $in: run.createdCandidateIds } }),
    ]);
    await this.runs.updateOne(
      { _id: runId },
      { $set: { status: 'rolled-back', finishedAt: new Date() } },
    );
    return { removed: channels.deletedCount + candidates.deletedCount };
  }
}
