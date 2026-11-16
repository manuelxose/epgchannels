/**
 * Staging -> public authorisation gate.
 *
 * The catalogue starts private (MODULE-CONTRACT-02B hard rule 4). This module is
 * the ONLY thing that moves a channel out of staging, and it refuses unless there
 * is a recorded, approved authorisation for a source candidate of that channel.
 *
 * Why it is a separate module and not an `if` inside the pipeline: the ingest
 * path must not be able to publish. Ingestion writes `staging` + `draft`; only
 * an explicit operator decision, validated here, can promote a record.
 *
 * DEMO MODE (product-owner decision, 2026-11-16): the licence status of a source
 * is recorded as PROVENANCE but is not a gate. Every ingested source, including
 * one that declares no licence, can be promoted once a person approves it. The
 * snapshot's licence stays available for display and attribution; it is never
 * used to block a catalogue entry.
 *
 * What this still does NOT do: it never publishes a signal the platform would
 * have to proxy, transcode or forge headers for.
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

  /*
   * The snapshot must exist so the record keeps its provenance, but its licence
   * does NOT gate promotion in demo mode: a source that declares no licence is
   * promotable exactly like any other. The licence value is carried into the
   * audit row below, so what was published, and under which declared terms,
   * stays answerable.
   */
  const snapshot = await snapshots.findOne({ _id: candidate.snapshotId });
  if (snapshot === null) return { promoted: false, reason: 'snapshot-missing', detail: candidate.snapshotId };

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
      after: {
        catalogueState: 'approved',
        editorialStatus: 'published',
        candidateId: request.candidateId,
        /* Provenance of the published source, recorded but never gated on. */
        upstream: snapshot.upstream,
        snapshotId: snapshot._id,
        licenceReuse: snapshot.licence.reuse,
        licenceSpdx: snapshot.licence.spdx,
      },
      reason: request.notes ?? null,
      requestId: `promote-${request.channelId}`,
      at: now,
    });

  return { promoted: true, channelId: request.channelId, candidateId: request.candidateId, slug: channel.slug };
}

/**
 * Records an authorisation decision. Kept here so a decision and its enforcement
 * live together; the licence posture travels with the decision as provenance.
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
