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
    await this.editorial.recordExternal(actor, 'source.create', 'source', doc._id, requestId, {
      channelId: doc.channelId,
      type: doc.type,
      permission: doc.permission,
    });
    return doc;
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
