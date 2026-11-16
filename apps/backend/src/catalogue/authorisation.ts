/**
 * Staging -> public authorisation gate.
 *
 * The catalogue starts private (D-012, MODULE-CONTRACT-02B hard rule 4). This
 * module is the ONLY thing that moves a channel out of staging, and it refuses
 * unless there is a recorded, approved authorisation for a source candidate of
 * that channel and the source's licence permits publication.
 *
 * Why it is a separate module and not an `if` inside the pipeline: the ingest
 * path must not be able to publish. Ingestion writes `staging` + `draft`; only
 * an explicit operator decision, validated here, can promote a record.
 *
 * What this does NOT do: it never publishes a signal the platform would have to
 * proxy, transcode or forge headers for, it never decides whether a stream is
 * legal — it records and enforces a human decision — and it never promotes a
 * channel whose only sources are `unlicensed`.
 */
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type {
  ChannelDoc,
  SourceAuthorizationDoc,
  SourceCandidateDoc,
  SourceSnapshotDoc,
} from '../catalogue/schema.js';
import type { AuditDoc } from '../infrastructure/schema.js';

/** Licences whose listing may be published once an authorisation exists. */
const PUBLISHABLE_REUSE = new Set(['public-domain', 'permitted-with-attribution']);

export interface PromotionRequest {
  channelId: string;
  candidateId: string;
  decidedBy: string;
  notes?: string | null;
}

export type PromotionResult =
  | { promoted: true; channelId: string; candidateId: string; slug: string }
  | { promoted: false; reason: PromotionRejection; detail: string };

export type PromotionRejection =
  | 'channel-not-found'
  | 'channel-merged'
  | 'candidate-not-found'
  | 'candidate-not-this-channel'
  | 'candidate-rejected'
  | 'authorisation-missing'
  | 'authorisation-not-approved'
  | 'licence-not-publishable'
  | 'snapshot-missing'
  | 'conditions-prohibited';

/** Promotes one channel to `approved` + `published` when, and only when, authorised. */
export async function promoteChannel(database: DatabaseHandle, request: PromotionRequest): Promise<PromotionResult> {
  const channels = database.collection<ChannelDoc>(COLLECTIONS.channels);
  const candidates = database.collection<SourceCandidateDoc>(COLLECTIONS.sourceCandidates);
  const authorizations = database.collection<SourceAuthorizationDoc>(COLLECTIONS.sourceAuthorization);
  const snapshots = database.collection<SourceSnapshotDoc>(COLLECTIONS.sourceSnapshots);

  const channel = await channels.findOne({ _id: request.channelId });
  if (channel === null) return { promoted: false, reason: 'channel-not-found', detail: request.channelId };
  if (channel.mergedInto !== null) return { promoted: false, reason: 'channel-merged', detail: channel.mergedInto };

  const candidate = await candidates.findOne({ _id: request.candidateId });
  if (candidate === null) return { promoted: false, reason: 'candidate-not-found', detail: request.candidateId };
  if (candidate.channelId !== request.channelId) {
    return { promoted: false, reason: 'candidate-not-this-channel', detail: String(candidate.channelId) };
  }
  if (candidate.state === 'rejected') {
    return { promoted: false, reason: 'candidate-rejected', detail: candidate.rejectionReason ?? 'rejected' };
  }

  const authorization = await authorizations.findOne({ candidateId: request.candidateId });
  if (authorization === null || authorization.channelId !== request.channelId) {
    return { promoted: false, reason: 'authorisation-missing', detail: request.candidateId };
  }
  if (authorization.decision !== 'approved') {
    return { promoted: false, reason: 'authorisation-not-approved', detail: authorization.decision };
  }

  // Prohibited conditions can never be published, whatever a person decided.
  if (authorization.conditions.requiresForgedHeader || authorization.conditions.emitterAppOnly) {
    return { promoted: false, reason: 'conditions-prohibited', detail: 'forged header or app-only emitter' };
  }

  const snapshot = await snapshots.findOne({ _id: candidate.snapshotId });
  if (snapshot === null) return { promoted: false, reason: 'snapshot-missing', detail: candidate.snapshotId };
  if (!PUBLISHABLE_REUSE.has(snapshot.licence.reuse)) {
    return { promoted: false, reason: 'licence-not-publishable', detail: snapshot.licence.reuse };
  }

  const now = new Date();
  await channels.updateOne(
    { _id: request.channelId },
    {
      $set: {
        catalogueState: 'approved',
        editorialStatus: 'published',
        reviewedAt: now,
        updatedAt: now,
      },
      $inc: { revision: 1 },
    },
  );
  await database
    .collection<AuditDoc>(COLLECTIONS.audits)
    .insertOne({
      _id: `promote:${request.channelId}:${now.toISOString()}`,
      actor: { type: 'user', id: request.decidedBy },
      action: 'catalogue.promote',
      entityType: 'channel',
      entityId: request.channelId,
      before: { catalogueState: channel.catalogueState, editorialStatus: channel.editorialStatus },
      after: { catalogueState: 'approved', editorialStatus: 'published', candidateId: request.candidateId },
      reason: request.notes ?? null,
      requestId: `promote-${request.channelId}`,
      at: now,
    });

  return { promoted: true, channelId: request.channelId, candidateId: request.candidateId, slug: channel.slug };
}

/**
 * Records an authorisation decision. Kept here so a decision and its enforcement
 * live together, and so an approval always carries its licence posture.
 */
export async function recordAuthorization(
  database: DatabaseHandle,
  decision: SourceAuthorizationDoc,
): Promise<void> {
  await database
    .collection<SourceAuthorizationDoc>(COLLECTIONS.sourceAuthorization)
    .updateOne(
      { candidateId: decision.candidateId, channelId: decision.channelId },
      { $set: decision },
      { upsert: true },
    );
}
