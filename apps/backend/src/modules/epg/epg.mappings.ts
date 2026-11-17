/**
 * Canonical channel ↔ guide-source mappings (TDT-API-02FG).
 *
 * `epg_mappings` is the table of record: one row per (channel, upstream id) with
 * `status: proposed | confirmed | rejected`. The legacy `aliases.namespace='epg'`
 * entry keeps working as a compatibility layer — ingestion still resolves through
 * it — but no new truth is written there and the read path prefers the canonical
 * table.
 *
 * Who may do what:
 *
 * - **Ingestion** (system actor) *proposes*: an upstream id that appears in a
 *   guide and resolves to a channel becomes a `proposed` row. It never confirms
 *   itself, so a wrong guess cannot silently go live.
 * - **A confirmed row** is what attaches a source to a channel and moves guide
 *   ingestion forward.
 * - **An operator** confirms, rejects or creates a mapping by hand; every write
 *   lands in `audit_log` with the actor and the before/after image.
 *
 * Rejection is a tombstone, not a delete: ingestion sees the row and stops
 * proposing the same pair again, which is what "no, this is not that channel"
 * has to mean.
 */
import type { EpgMapping, EpgMappingStatus } from '@tdt/contracts';
import { randomUUID } from 'node:crypto';
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { AuditDoc, ChannelDoc, ProvenanceDoc } from '../../infrastructure/schema.js';
import type { EpgMappingDoc } from '../../catalogue/schema.js';

/** The `epg` alias namespace stays valid for compatibility (contract §4.1). */
export const EPG_ALIAS_NAMESPACE = 'epg';

export interface EpgActor {
  readonly type: 'user' | 'system' | 'anonymous';
  readonly id: string;
}

export const SYSTEM_ACTOR: EpgActor = { type: 'system', id: 'epg-ingestion' };

export interface ProposeMappingInput {
  readonly channelId: string;
  readonly epgSourceId: string | null;
  readonly externalId: string;
  readonly namespace?: string;
  readonly confidence?: number;
  readonly reason?: string | null;
}

export interface MappingResolution {
  /** Upstream id → channel id, from confirmed rows only. */
  readonly byExternalId: ReadonlyMap<string, string>;
  readonly confirmed: number;
  readonly proposed: number;
  readonly rejected: number;
}

const CONFIRM_THRESHOLD = 0.9;

export class EpgMappingService {
  constructor(private readonly database: DatabaseHandle) {}

  private mappings() {
    return this.database.collection<EpgMappingDoc>(COLLECTIONS.epgMappings);
  }

  private channels() {
    return this.database.collection<ChannelDoc>(COLLECTIONS.channels);
  }

  private audits() {
    return this.database.collection<AuditDoc>(COLLECTIONS.audits);
  }

  private async record(
    actor: EpgActor,
    action: string,
    entityId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    reason: string | null,
  ): Promise<void> {
    await this.audits().insertOne({
      _id: randomUUID(),
      actor,
      action,
      entityType: 'epg_mapping',
      entityId,
      before,
      after,
      reason,
      requestId: `epg:${randomUUID()}`,
      at: new Date(),
    });
  }

  /**
   * Resolves upstream guide ids to our channels for one source.
   *
   * Confirmed canonical rows win. The legacy `epg` alias is read as a fallback so
   * a database that predates the canonical table keeps working *and* gets its
   * existing aliases proposed as rows the first time ingestion runs.
   */
  async resolveForSource(
    sourceId: string | null,
    upstreamIds: readonly string[],
  ): Promise<MappingResolution> {
    const byExternalId = new Map<string, string>();
    if (upstreamIds.length === 0) {
      return { byExternalId, confirmed: 0, proposed: 0, rejected: 0 };
    }
    const rows = await this.mappings()
      .find({
        externalId: { $in: [...upstreamIds] },
        ...(sourceId === null ? {} : { $or: [{ epgSourceId: sourceId }, { epgSourceId: null }] }),
      })
      .toArray();
    let confirmed = 0;
    let proposed = 0;
    let rejected = 0;
    const rejectedPairs = new Set<string>();
    for (const row of rows) {
      if (row.status === 'confirmed') {
        confirmed += 1;
        // A confirmed row attaches the channel to this source.
        if (!byExternalId.has(row.externalId)) byExternalId.set(row.externalId, row.channelId);
      } else if (row.status === 'proposed') {
        proposed += 1;
      } else {
        rejected += 1;
        rejectedPairs.add(`${row.channelId}|${row.externalId}`);
      }
    }

    // Compatibility fallback: channels whose guide is still only declared by the
    // `epg` alias. Ingesting from them is what the previous release did, so it
    // stays true; the proposal below records the intent in the canonical table.
    const pending = upstreamIds.filter((id) => !byExternalId.has(id));
    if (pending.length > 0) {
      const legacy = await this.channels()
        .find(
          { editorialStatus: 'published', 'aliases.namespace': EPG_ALIAS_NAMESPACE, 'aliases.value': { $in: pending } },
          { projection: { _id: 1, aliases: 1 } },
        )
        .toArray();
      for (const channel of legacy) {
        for (const alias of channel.aliases) {
          if (alias.namespace !== EPG_ALIAS_NAMESPACE || !pending.includes(alias.value)) continue;
          if (byExternalId.has(alias.value)) continue;
          if (rejectedPairs.has(`${channel._id}|${alias.value}`)) continue;
          byExternalId.set(alias.value, channel._id);
        }
      }
    }
    return { byExternalId, confirmed, proposed, rejected };
  }

  /**
   * Records that an upstream id belongs to a channel, without confirming it.
   *
   * Idempotent: an existing row is left alone (a rejection keeps its status, so
   * ingestion never resurrects a decision an operator made).
   */
  async propose(
    input: ProposeMappingInput,
    actor: EpgActor = SYSTEM_ACTOR,
  ): Promise<{ created: boolean; id: string | null }> {
    const namespace = input.namespace ?? EPG_ALIAS_NAMESPACE;
    const externalId = input.externalId.trim();
    if (externalId.length === 0) return { created: false, id: null };
    const existing = await this.mappings().findOne({
      channelId: input.channelId,
      namespace,
      externalId,
    });
    if (existing) return { created: false, id: existing._id };
    const confidence = input.confidence ?? 0.5;
    const status: EpgMappingStatus =
      confidence >= CONFIRM_THRESHOLD && actor.type === 'user' ? 'confirmed' : 'proposed';
    const doc: EpgMappingDoc = {
      _id: randomUUID(),
      channelId: input.channelId,
      epgSourceId: input.epgSourceId,
      externalId,
      namespace,
      confidence,
      status,
    };
    try {
      await this.mappings().insertOne(doc);
    } catch (error) {
      // Two concurrent ingests may race on the unique key: the row exists, done.
      if ((error as { code?: number } | null)?.code === 11000) return { created: false, id: null };
      throw error;
    }
    await this.record(actor, 'epg.mapping.propose', doc._id, null, { ...doc }, input.reason ?? null);
    return { created: true, id: doc._id };
  }

  async listForChannel(channelId: string): Promise<EpgMappingDoc[]> {
    return this.mappings().find({ channelId }).sort({ status: 1, externalId: 1 }).toArray();
  }

  /** Every canonical row, for the administration view. */
  async list(
    filter: { status?: EpgMappingStatus; sourceId?: string } = {},
  ): Promise<{ rows: EpgMappingDoc[]; channels: Map<string, ChannelDoc> }> {
    const query: Record<string, unknown> = {};
    if (filter.status) query['status'] = filter.status;
    if (filter.sourceId) query['epgSourceId'] = filter.sourceId;
    const rows = await this.mappings().find(query).sort({ channelId: 1, externalId: 1 }).toArray();
    const channelIds = [...new Set(rows.map((row) => row.channelId))];
    const channels = await this.channels()
      .find({ _id: { $in: channelIds } }, { projection: { _id: 1, slug: 1, name: 1 } })
      .toArray();
    return { rows, channels: new Map(channels.map((channel) => [channel._id, channel])) };
  }

  /** Contract shape, with the conflict flag the administration UI relies on. */
  async listResolved(filter: { status?: EpgMappingStatus; sourceId?: string } = {}): Promise<EpgMapping[]> {
    const { rows, channels } = await this.list(filter);
    const owners = new Map<string, Set<string>>();
    for (const row of rows) {
      if (row.status !== 'confirmed') continue;
      const key = `${row.epgSourceId ?? ''}|${row.externalId}`;
      const set = owners.get(key) ?? new Set<string>();
      set.add(row.channelId);
      owners.set(key, set);
    }
    return rows.map((row) => {
      const channel = channels.get(row.channelId);
      return {
        id: row._id,
        channelId: row.channelId,
        channelSlug: channel?.slug ?? '',
        channelName: channel?.name ?? '',
        epgSourceId: row.epgSourceId,
        externalId: row.externalId,
        namespace: row.namespace,
        confidence: row.confidence,
        status: row.status,
        conflict: (owners.get(`${row.epgSourceId ?? ''}|${row.externalId}`)?.size ?? 0) > 1,
      };
    });
  }

  /**
   * Operator decision. Confirming attaches the source to the channel and keeps
   * the legacy alias in step; rejecting withdraws the attachment and records a
   * tombstone. Both are audited.
   */
  async decide(
    mappingId: string,
    decision: 'confirmed' | 'rejected',
    actor: EpgActor,
    reason: string | null,
  ): Promise<EpgMappingDoc> {
    const row = await this.mappings().findOne({ _id: mappingId });
    if (!row) throw new Error('Mapeo EPG no encontrado.');
    if (row.status === decision) return row;
    await this.mappings().updateOne({ _id: mappingId }, { $set: { status: decision } });
    const updated: EpgMappingDoc = { ...row, status: decision };

    if (decision === 'confirmed') {
      await this.attach(row.channelId, row.epgSourceId, row.externalId, actor);
    } else {
      await this.detach(row.channelId, row.externalId);
    }
    await this.record(actor, `epg.mapping.${decision === 'confirmed' ? 'confirm' : 'reject'}`, mappingId, { ...row }, { ...updated }, reason);
    return updated;
  }

  /**
   * Manual mapping. A user-created row is confirmed on the spot (`confidence`
   * defaults to 1), because the operator is the authority the row encodes.
   */
  async create(
    input: ProposeMappingInput,
    actor: EpgActor,
    reason: string | null = null,
  ): Promise<EpgMappingDoc> {
    const namespace = input.namespace ?? EPG_ALIAS_NAMESPACE;
    const externalId = input.externalId.trim();
    if (externalId.length === 0) throw new Error('El identificador externo es obligatorio.');
    const channel = await this.channels().findOne({ _id: input.channelId });
    if (!channel) throw new Error('Canal no encontrado.');
    const confidence = input.confidence ?? 1;
    const status: EpgMappingStatus = confidence >= CONFIRM_THRESHOLD ? 'confirmed' : 'proposed';
    const doc: EpgMappingDoc = {
      _id: randomUUID(),
      channelId: input.channelId,
      epgSourceId: input.epgSourceId,
      externalId,
      namespace,
      confidence,
      status,
    };
    await this.mappings().replaceOne({ channelId: input.channelId, namespace, externalId }, doc, { upsert: true });
    if (status === 'confirmed') await this.attach(input.channelId, input.epgSourceId, externalId, actor);
    await this.record(actor, 'epg.mapping.create', doc._id, null, { ...doc }, reason);
    return doc;
  }

  /**
   * Attaches a guide to a channel: canonical `epg` block plus the legacy alias,
   * so a feed ingested through either path resolves to the same channel.
   */
  private async attach(
    channelId: string,
    sourceId: string | null,
    externalId: string,
    actor: EpgActor,
  ): Promise<void> {
    const channel = await this.channels().findOne({ _id: channelId });
    if (!channel) return;
    const aliases = channel.aliases.some(
      (alias) => alias.namespace === EPG_ALIAS_NAMESPACE && alias.value === externalId,
    )
      ? channel.aliases
      : [...channel.aliases, { namespace: EPG_ALIAS_NAMESPACE, value: externalId }];
    const provenance: ProvenanceDoc[] = channel.provenance.some((entry) => entry.source === 'epg-mapping')
      ? channel.provenance
      : [
          ...channel.provenance,
          {
            source: 'epg-mapping',
            label: 'Mapeo EPG confirmado',
            url: null,
            licence: 'editorial',
            attribution: null,
            digestSha256: null,
            capturedAt: new Date(),
            editorial: true,
          },
        ];
    await this.channels().updateOne(
      { _id: channelId },
      {
        $set: {
          ...(sourceId === null ? {} : { epg: { sourceId, externalId } }),
          aliases,
          provenance,
          updatedAt: new Date(),
        },
        $inc: { revision: 1 },
      },
    );
    await this.record(actor, 'epg.mapping.attach', channelId, { epg: channel.epg, aliases: channel.aliases }, { epg: sourceId === null ? channel.epg : { sourceId, externalId }, aliases }, null);
  }

  /** Withdraws the guide of a channel (rejection). Programmes are kept. */
  private async detach(channelId: string, externalId: string): Promise<void> {
    const channel = await this.channels().findOne({ _id: channelId });
    if (!channel) return;
    await this.channels().updateOne(
      { _id: channelId },
      {
        $set: {
          epg: { sourceId: null, externalId: null },
          aliases: channel.aliases.filter(
            (alias) => !(alias.namespace === EPG_ALIAS_NAMESPACE && alias.value === externalId),
          ),
          updatedAt: new Date(),
        },
        $inc: { revision: 1 },
      },
    );
  }
}
