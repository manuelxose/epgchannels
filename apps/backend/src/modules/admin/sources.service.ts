/**
 * Source registry writes (`/api/v1/admin/sources*`).
 *
 * A source cannot be created without an explicit permission and the conditions
 * it was granted under. Creation never decides exposure by itself: the
 * publication policy does, on every read.
 */
import { randomUUID } from 'node:crypto';
import type { CreateSourceInput, UpdateSourceInput, VerifySourceResult } from '@tdt/contracts';
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { ChannelDoc, PlaybackSourceDoc } from '../../infrastructure/schema.js';
import { AppError } from '../../server/errors.js';
import type { EgressOptions } from '../../infrastructure/egress.js';
import { providerRegistry } from '../providers/providers.registry.js';
import { AuthorizationRepository } from '../providers/authorization.repository.js';
import type { AuthorizationRecord } from '../providers/authorization.js';
import { classifyHost } from '../providers/provider-kinds.js';
import type { Actor } from './editorial.service.js';
import { EditorialService } from './editorial.service.js';

export interface SourceWithExposure {
  readonly source: PlaybackSourceDoc;
  readonly publiclyExposed: boolean;
  readonly exclusionReason: string | null;
}

export class SourcesService {
  constructor(
    private readonly database: DatabaseHandle,
    private readonly editorial: EditorialService,
  ) {}

  private sources() {
    return this.database.collection<PlaybackSourceDoc>(COLLECTIONS.sources);
  }

  async create(input: CreateSourceInput, actor: Actor, requestId: string): Promise<PlaybackSourceDoc> {
    const channel = await this.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .findOne({ _id: input.channelId });
    if (!channel) throw AppError.notFound('Canal no encontrado.');
    if (!providerRegistry.forSource({ type: input.type, provider: input.provider })) {
      throw AppError.badRequest(`No hay proveedor de integración para el tipo "${input.type}".`);
    }
    if (input.type === 'external' && !input.officialPageUrl) {
      throw AppError.badRequest('Una fuente externa necesita la página oficial del emisor.');
    }
    if (!input.url && input.type !== 'external') {
      throw AppError.badRequest('Una fuente reproducible necesita una URL pública.');
    }
    if (input.permission === 'unlicensed') {
      throw AppError.badRequest(
        'Una fuente sin permiso de integración no puede registrarse como reproducible; usa el estado editorial "withdrawn".',
      );
    }
    const now = new Date();
    const doc: PlaybackSourceDoc = {
      _id: randomUUID(),
      channelId: input.channelId,
      provider: input.provider,
      type: input.type,
      url: input.url,
      officialPageUrl: input.officialPageUrl ?? null,
      permission: input.permission,
      authorisationEvidence: input.authorisationEvidence ?? null,
      conditions: {
        embedAllowed: input.conditions.embedAllowed,
        proxyAllowed: input.conditions.proxyAllowed,
        worldwide: input.conditions.worldwide,
        restrictedRegions: input.conditions.restrictedRegions,
        browserCompatibility: input.conditions.browserCompatibility,
        requiresForgedHeader: input.conditions.requiresForgedHeader,
        emitterAppOnly: input.conditions.emitterAppOnly,
        notes: input.conditions.notes ?? null,
      },
      priority: input.priority ?? 100,
      editorialStatus: input.editorialStatus ?? 'published',
      technicalStatus: 'unknown',
      lastVerifiedAt: null,
      lastVerification: null,
      provenance: [
        {
          source: 'editorial',
          label: `Alta editorial de fuente (${actor.id})`,
          url: input.officialPageUrl ?? null,
          licence: input.permission,
          attribution: null,
          digestSha256: null,
          capturedAt: now,
          editorial: true,
        },
      ],
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    await this.sources().insertOne(doc);
    /*
     * 02C: registering a source with an explicit, permitted integration is the
     * operator's own authorisation decision, so it is recorded next to the
     * source. Without it the eligibility gate would refuse the very source the
     * operator just approved. The permission vocabulary maps onto a playback
     * class here and nowhere else.
     */
    await this.recordAuthorization(doc, actor);
    await this.editorial.recordExternal(actor, 'source.create', 'source', doc._id, requestId, {
      channelId: doc.channelId,
      type: doc.type,
      permission: doc.permission,
    });
    return doc;
  }

  /**
   * Records the 02C authorization decision implied by an operator registration.
   *
   * The line this method must not cross: the DECISION may be recorded
   * automatically, but the EVIDENCE that makes it citable may not be fabricated.
   * A registration without a pointer to real licensing evidence is recorded as
   * `unresolved`, so the gate denies it until a person records a right citing
   * something that exists. Minting a `written-licence` with a synthetic citation
   * would make every newly registered source playable with no evidence at all,
   * which is exactly the inversion this milestone exists to prevent.
   */
  private async recordAuthorization(source: PlaybackSourceDoc, actor: Actor): Promise<void> {
    const isExternal = source.type === 'external' || source.permission === 'official-player-only';
    const isEmbed = source.type === 'youtube' || source.type === 'official-embed';

    /*
     * Real evidence means the operator pointed at something: a page or document
     * that can be re-checked. A bare registration is not evidence.
     */
    const evidenceUrl = source.officialPageUrl ?? source.authorisationEvidence ?? null;
    const hasEvidence = evidenceUrl !== null && evidenceUrl.trim().length > 0;

    const verdict = !hasEvidence
      ? 'unresolved'
      : isExternal
        ? 'external-link-only'
        : isEmbed
          ? 'permitted-official-embed'
          : 'permitted-direct-playback';
    const method = !hasEvidence
      ? 'none'
      : isExternal
        ? 'external-link'
        : isEmbed
          ? 'official-embed'
          : 'direct-playback';

    const now = new Date();
    const host = source.url === null ? null : this.hostOf(source.url);
    /*
     * The origin kind comes from the measured taxonomy, so a shortener or a
     * static CDN registered through the admin API is classified as such and the
     * gate refuses it exactly like a seeded one.
     *
     * `catalogue_reference` is that taxonomy's answer for a host we have never
     * measured, which is right for an ingested catalogue line but wrong here: an
     * operator registering a source is asserting it is the emitter's own
     * endpoint, not a pointer into someone's playlist. So the unknown-host case
     * becomes `broadcaster`, while the KNOWN-bad kinds (shortener, cdn) stay
     * exactly as measured and can never be talked into authorising anything.
     */
    const measured = classifyHost(source.url);
    const providerKind =
      measured.kind === 'catalogue_reference' && measured.basis === 'unknown-host'
        ? 'broadcaster'
        : measured.kind;

    const record: AuthorizationRecord = {
      _id: `editorial:${source._id}`,
      operatorId: `editorial:${actor.id}`,
      sourceUrl: source.url ?? `editorial:${source._id}`,
      providerKind,
      verdict,
      basis: hasEvidence ? 'written-licence' : 'none',
      quotedClause: source.authorisationEvidence,
      /* No synthetic citation: an absent one stays absent so the gate denies. */
      clauseUrl: hasEvidence ? evidenceUrl : null,
      method,
      publicationScope: !hasEvidence ? 'none' : isExternal ? 'external-only' : 'in-app',
      territory: {
        /* `restrictedRegions` is a DENY list; it is never used as the allow list. */
        allowed: [],
        restricted: source.conditions.restrictedRegions,
        worldwide: source.conditions.worldwide,
        geoBlocked: false,
      },
      restrictions: hasEvidence ? [] : ['Sin evidencia de licencia registrada: no se reproduce.'],
      attribution: source.provider,
      discovery: {
        upstream: null,
        snapshotId: null,
        path: null,
        line: null,
        sourceUrl: source.url,
        documentUrl: evidenceUrl,
        retrievedAt: now,
      },
      lifecycle: 'active',
      expiresAt: null,
      validationTimestamp: null,
      authorizationTimestamp: now,
      /*
       * A distinct value from a researched decision: an auditor must be able to
       * tell an auto-minted registration from a reviewed right at a glance.
       */
      reviewStatus: 'pending-review',
      notes: `Alta editorial por ${actor.id}${host === null ? '' : ` (host ${host})`}`,
    };
    await new AuthorizationRepository(this.database).record(record);
  }

  /** Lowercased host of a URL, or `null` when it does not parse. */
  private hostOf(url: string): string | null {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  async update(id: string, input: UpdateSourceInput, actor: Actor, requestId: string): Promise<PlaybackSourceDoc> {
    const existing = await this.sources().findOne({ _id: id });
    if (!existing) throw AppError.notFound('Fuente no encontrada.');
    if (input.expectedUpdatedAt && input.expectedUpdatedAt !== existing.updatedAt.toISOString()) {
      throw AppError.conflict('La fuente ha cambiado desde que la leíste; vuelve a cargarla.');
    }
    const { expectedUpdatedAt: _expected, reason: _reason, conditions, ...rest } = input;
    const now = new Date();
    const updated: PlaybackSourceDoc = {
      ...existing,
      ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
      conditions: {
        ...existing.conditions,
        ...Object.fromEntries(
          Object.entries(conditions ?? {}).filter(([, value]) => value !== undefined),
        ),
      },
      updatedAt: now,
      revision: existing.revision + 1,
    };
    await this.sources().replaceOne({ _id: id }, updated);
    await this.editorial.recordExternal(actor, 'source.update', 'source', id, requestId, {
      permission: updated.permission,
      editorialStatus: updated.editorialStatus,
      priority: updated.priority,
    });
    return updated;
  }

  /** Withdrawal is the supported removal: the record keeps its history. */
  async withdraw(id: string, actor: Actor, requestId: string, reason: string): Promise<PlaybackSourceDoc> {
    const existing = await this.sources().findOne({ _id: id });
    if (!existing) throw AppError.notFound('Fuente no encontrada.');
    const updated: PlaybackSourceDoc = {
      ...existing,
      editorialStatus: 'withdrawn',
      updatedAt: new Date(),
      revision: existing.revision + 1,
    };
    await this.sources().replaceOne({ _id: id }, updated);
    await this.editorial.recordExternal(actor, 'source.withdraw', 'source', id, requestId, { reason });
    return updated;
  }

  /**
   * Re-points an existing source at another channel (TDT-API-02FG §5
   * `POST /admin/sources/:id/assign`).
   *
   * Reuse, not re-implementation: this is a source write and therefore keeps the
   * same rules as every other one — the target channel must exist, the revision
   * moves, and `audit_log` records the move with the channel it came from. It does
   * NOT touch the authorization decision: a right is recorded per URL/operator, so
   * moving a source does not manufacture permission for the new channel. The
   * eligibility gate re-evaluates on the next read and refuses if it must.
   */
  async assign(
    id: string,
    input: { readonly channelId: string; readonly reason: string },
    actor: Actor,
    requestId: string,
  ): Promise<PlaybackSourceDoc> {
    const existing = await this.sources().findOne({ _id: id });
    if (!existing) throw AppError.notFound('Fuente no encontrada.');
    const channel = await this.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .findOne({ _id: input.channelId });
    if (!channel) throw AppError.notFound('Canal no encontrado.');
    if (channel.mergedInto !== null) {
      throw AppError.conflict('El canal indicado fue fusionado en otro; asigna la fuente al canal vigente.');
    }
    if (existing.channelId === input.channelId) {
      /* Idempotent: still audited, so a repeated click is visible in the trail. */
      await this.editorial.recordExternal(actor, 'source.assign.noop', 'source', id, requestId, {
        channelId: input.channelId,
        reason: input.reason,
      });
      return existing;
    }
    const updated: PlaybackSourceDoc = {
      ...existing,
      channelId: input.channelId,
      updatedAt: new Date(),
      revision: existing.revision + 1,
    };
    await this.sources().replaceOne({ _id: id }, updated);
    await this.editorial.recordExternal(actor, 'source.assign', 'source', id, requestId, {
      fromChannelId: existing.channelId,
      toChannelId: input.channelId,
      reason: input.reason,
    });
    return updated;
  }

  async verify(id: string, egress: EgressOptions, actor: Actor, requestId: string): Promise<VerifySourceResult> {
    const source = await this.sources().findOne({ _id: id });
    if (!source) throw AppError.notFound('Fuente no encontrada.');
    const check = await providerRegistry.verify(source, egress);
    const checkedAt = new Date();
    await this.sources().updateOne(
      { _id: id },
      {
        $set: {
          technicalStatus: check.technicalStatus,
          lastVerifiedAt: checkedAt,
          lastVerification: {
            status: check.technicalStatus,
            httpStatus: check.httpStatus,
            message: check.message,
            checkedAt,
          },
          updatedAt: checkedAt,
        },
        $inc: { revision: 1 },
      },
    );
    await this.editorial.recordExternal(actor, 'source.verify', 'source', id, requestId, {
      status: check.technicalStatus,
      httpStatus: check.httpStatus,
    });
    return {
      sourceId: id,
      status: check.technicalStatus as VerifySourceResult['status'],
      httpStatus: check.httpStatus,
      checkedAt: checkedAt.toISOString(),
      message: check.message,
    };
  }
}
