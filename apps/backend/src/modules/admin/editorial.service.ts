/**
 * Editorial service: every catalogue mutation, with its audit entry.
 *
 * The rules that make accidental loss impossible live here:
 * - deleting a channel is not offered: channels are *withdrawn* and restored
 *   from any recorded revision;
 * - merging a duplicate folds its aliases, sources and guide mapping into the
 *   survivor and withdraws it, keeping history;
 * - every write honours an optimistic `expectedUpdatedAt` guard when the client
 *   read the record before, and every write is recorded in `audit_log`.
 */
import { randomUUID } from 'node:crypto';
import type { AuditEntry, CreateChannelInput, MergeChannelInput, UpdateChannelInput } from '@tdt/contracts';
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { AuditDoc, ChannelDoc, PlaybackSourceDoc } from '../../infrastructure/schema.js';
import { AppError } from '../../server/errors.js';
import { canonicalSlug } from '../../shared/slug.js';
import { ChannelsService } from '../channels/channels.service.js';

export interface Actor {
  readonly type: 'user' | 'system' | 'anonymous';
  readonly id: string;
}

function toAuditEntry(doc: AuditDoc): AuditEntry {
  return {
    id: doc._id,
    actor: doc.actor,
    action: doc.action,
    entityType: doc.entityType,
    entityId: doc.entityId,
    before: doc.before,
    after: doc.after,
    reason: doc.reason,
    requestId: doc.requestId,
    at: doc.at.toISOString(),
  };
}

/** Fields kept in a revision snapshot (everything a revert restores). */
const AUDITED_FIELDS = [
  'slug',
  'name',
  'shortName',
  'country',
  'region',
  'locality',
  'languageTag',
  'category',
  'kind',
  'websiteUrl',
  'description',
  'branding',
  'editorialStatus',
  'timezone',
  'aliases',
] as const;

function snapshot(channel: ChannelDoc): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of AUDITED_FIELDS) {
    out[field] = channel[field] as unknown;
  }
  return out;
}

export class EditorialService {
  constructor(private readonly database: DatabaseHandle) {}

  private channels() {
    return this.database.collection<ChannelDoc>(COLLECTIONS.channels);
  }

  private sources() {
    return this.database.collection<PlaybackSourceDoc>(COLLECTIONS.sources);
  }

  private audits() {
    return this.database.collection<AuditDoc>(COLLECTIONS.audits);
  }

  private async record(
    actor: Actor,
    action: string,
    entityType: string,
    entityId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    reason: string | null,
    requestId: string,
  ): Promise<void> {
    await this.audits().insertOne({
      _id: randomUUID(),
      actor,
      action,
      entityType,
      entityId,
      before,
      after,
      reason,
      requestId,
      at: new Date(),
    });
  }

  async createChannel(input: CreateChannelInput, actor: Actor, requestId: string): Promise<ChannelDoc> {
    const slug = input.slug ?? canonicalSlug(input.name);
    const existing = await this.channels().findOne({ slug });
    if (existing) {
      throw AppError.conflict(`Ya existe un canal con el slug "${slug}".`);
    }
    const now = new Date();
    const draft: ChannelDoc = {
      _id: randomUUID(),
      slug,
      name: input.name,
      shortName: input.shortName ?? input.name.slice(0, 40),
      country: input.country,
      region: input.region ?? null,
      locality: input.locality ?? null,
      languageTag: input.language ?? 'es',
      category: input.category,
      kind: input.kind ?? 'linear',
      websiteUrl: input.websiteUrl ?? null,
      description: input.description ?? '',
      branding: input.branding ?? null,
      editorialStatus: input.editorialStatus ?? 'draft',
      timezone: input.timezone ?? 'Europe/Madrid',
      provenance: input.provenance.map((entry) => ({
        source: entry.source,
        label: entry.label,
        url: entry.url,
        licence: entry.licence,
        attribution: entry.attribution,
        digestSha256: null,
        capturedAt: now,
        editorial: entry.editorial,
      })),
      aliases: [...(input.aliases ?? [])],
      searchText: '',
      epg: null,
      mergedInto: null,
      reviewedAt: null,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    draft.searchText = ChannelsService.searchTextFor(draft);
    await this.channels().insertOne(draft);
    await this.record(actor, 'channel.create', 'channel', draft._id, null, snapshot(draft), null, requestId);
    return draft;
  }

  async updateChannel(
    id: string,
    input: UpdateChannelInput,
    actor: Actor,
    requestId: string,
  ): Promise<ChannelDoc> {
    const existing = await this.channels().findOne({ _id: id });
    if (!existing) throw AppError.notFound('Canal no encontrado.');
    if (input.expectedUpdatedAt && input.expectedUpdatedAt !== existing.updatedAt.toISOString()) {
      throw AppError.conflict('El canal ha cambiado desde que lo leíste; vuelve a cargarlo.');
    }
    if (input.slug && input.slug !== existing.slug) {
      const clash = await this.channels().findOne({ slug: input.slug, _id: { $ne: id } });
      if (clash) throw AppError.conflict(`El slug "${input.slug}" ya está en uso.`);
    }
    const changes = { ...input } as Record<string, unknown>;
    delete changes['expectedUpdatedAt'];
    delete changes['reason'];
    const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
    const updated: ChannelDoc = {
      ...existing,
      ...defined,
      updatedAt: new Date(),
      revision: existing.revision + 1,
    };
    updated.searchText = ChannelsService.searchTextFor(updated);
    await this.channels().replaceOne({ _id: id }, updated);
    await this.record(
      actor,
      'channel.update',
      'channel',
      id,
      snapshot(existing),
      snapshot(updated),
      input.reason ?? null,
      requestId,
    );
    return updated;
  }

  /** Restores the audited state of one channel from a recorded revision. */
  async revertChannel(id: string, auditId: string, actor: Actor, requestId: string): Promise<ChannelDoc> {
    const channel = await this.channels().findOne({ _id: id });
    if (!channel) throw AppError.notFound('Canal no encontrado.');
    const entry = await this.audits().findOne({ _id: auditId, entityType: 'channel', entityId: id });
    if (!entry) throw AppError.notFound('Revisión no encontrada para este canal.');
    const target = entry.before ?? entry.after;
    if (!target) throw AppError.conflict('La revisión no contiene un estado restaurable.');
    const restored: ChannelDoc = {
      ...channel,
      ...(target as Partial<ChannelDoc>),
      updatedAt: new Date(),
      revision: channel.revision + 1,
    };
    restored.searchText = ChannelsService.searchTextFor(restored);
    await this.channels().replaceOne({ _id: id }, restored);
    await this.record(
      actor,
      'channel.revert',
      'channel',
      id,
      snapshot(channel),
      snapshot(restored),
      `Revisión ${auditId}`,
      requestId,
    );
    return restored;
  }

  /**
   * Folds `duplicateId` into `id`: aliases, sources and guide mapping move to the
   * survivor; the duplicate is withdrawn with a pointer, never deleted.
   */
  async mergeChannels(
    id: string,
    input: MergeChannelInput,
    actor: Actor,
    requestId: string,
  ): Promise<ChannelDoc> {
    if (id === input.duplicateId) throw AppError.badRequest('Un canal no se puede fusionar consigo mismo.');
    const survivor = await this.channels().findOne({ _id: id });
    const duplicate = await this.channels().findOne({ _id: input.duplicateId });
    if (!survivor || !duplicate) throw AppError.notFound('Canal no encontrado.');
    if (duplicate.mergedInto) {
      throw AppError.conflict(`El canal ya se fusionó en ${duplicate.mergedInto}.`);
    }
    const mergedAliases = [
      ...survivor.aliases,
      ...duplicate.aliases,
      { namespace: 'merged-from', value: duplicate.slug },
      { namespace: 'merged-from', value: duplicate._id },
    ];
    const uniqueAliases = [
      ...new Map(mergedAliases.map((alias) => [`${alias.namespace}|${alias.value}`, alias])).values(),
    ];
    const now = new Date();
    const updatedSurvivor: ChannelDoc = {
      ...survivor,
      aliases: uniqueAliases,
      epg: survivor.epg ?? duplicate.epg,
      updatedAt: now,
      revision: survivor.revision + 1,
    };
    updatedSurvivor.searchText = ChannelsService.searchTextFor(updatedSurvivor);
    await this.channels().replaceOne({ _id: survivor._id }, updatedSurvivor);

    await this.sources().updateMany(
      { channelId: duplicate._id },
      { $set: { channelId: survivor._id, updatedAt: now } },
    );
    const withdrawn: ChannelDoc = {
      ...duplicate,
      editorialStatus: 'withdrawn',
      mergedInto: survivor._id,
      updatedAt: now,
      revision: duplicate.revision + 1,
    };
    await this.channels().replaceOne({ _id: duplicate._id }, withdrawn);

    await this.record(
      actor,
      'channel.merge',
      'channel',
      survivor._id,
      snapshot(duplicate),
      snapshot(updatedSurvivor),
      input.reason,
      requestId,
    );
    return updatedSurvivor;
  }

  async listAudits(
    filter: { entityType?: string | undefined; entityId?: string | undefined; action?: string | undefined },
    page: number,
    pageSize: number,
  ): Promise<{ entries: AuditEntry[]; total: number }> {
    const query: Record<string, unknown> = {};
    if (filter.entityType) query['entityType'] = filter.entityType;
    if (filter.entityId) query['entityId'] = filter.entityId;
    if (filter.action) query['action'] = filter.action;
    const [total, docs] = await Promise.all([
      this.audits().countDocuments(query),
      this.audits()
        .find(query)
        .sort({ at: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
    ]);
    return { entries: docs.map(toAuditEntry), total };
  }

  async recordExternal(
    actor: Actor,
    action: string,
    entityType: string,
    entityId: string,
    requestId: string,
    after: Record<string, unknown> = {},
  ): Promise<void> {
    await this.record(actor, action, entityType, entityId, null, after, null, requestId);
  }
}
