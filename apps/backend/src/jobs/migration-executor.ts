/**
 * Migration executor: commits a reviewed plan into our own store.
 *
 * Properties the hito depends on:
 * - **idempotent**: a channel is keyed by its legacy alias, so re-running an
 *   import updates instead of duplicating;
 * - **nothing is lost silently**: every excluded record is written to the
 *   migration report with its reason;
 * - **auditable**: the run is recorded in the ledger and in `audit_log` with the
 *   digest of the exact snapshot bytes it read;
 * - **reversible**: because nothing is deleted, a later editorial decision can
 *   withdraw or re-publish any record.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { ChannelDoc, PlaybackSourceDoc } from '../infrastructure/schema.js';
import { canonicalSlug } from '../shared/slug.js';
import { ChannelsService } from '../modules/channels/channels.service.js';
import type { ChannelImportPlan, ImportedSourcePlan } from './catalogue-import.js';

export interface ImportStats {
  channelsCreated: number;
  channelsUpdated: number;
  sourcePublished: number;
  sourceWithheld: number;
  sourcesSkippedDuplicate: number;
}

export interface MigrationLedgerDoc {
  _id: string;
  kind: 'catalogue-import';
  runAt: Date;
  snapshotDigestSha256: string;
  snapshotBytes: number;
  snapshotUpdated: number | null;
  channelRecords: number;
  channelsWritten: number;
  sourcesWritten: number;
  sourcesWithheld: number;
  exclusions: Array<{ legacyId: string; name: string; reason: string; detail: string | null }>;
  publishedSlugCollisions: Array<{ slug: string; kept: string; renamed: string }>;
  stats: ImportStats;
}

export interface ImportContext {
  readonly database: DatabaseHandle;
  readonly digestSha256: string;
  readonly bytes: number;
  readonly snapshotUpdated: number | null;
  readonly legalNote: string;
  readonly runLabel: string;
}

const LEGACY_NAMESPACE = 'legacy-tdt';

function sourceDocFromPlan(
  channelId: string,
  plan: ImportedSourcePlan,
  capturedAt: Date,
  provenance: { label: string; url: string | null; licence: string; attribution: string | null; digest: string },
): PlaybackSourceDoc {
  return {
    _id: randomUUID(),
    channelId,
    provider: plan.provider,
    type: plan.type,
    url: plan.url,
    officialPageUrl: plan.officialPageUrl,
    permission: plan.permission,
    authorisationEvidence:
      plan.withheldReason === null
        ? `Emisor: ${plan.emitter.label} (${plan.emitter.basis}). Procedencia: ${provenance.label}.`
        : `No integrable: ${plan.withheldReason}. Emisor: ${plan.emitter.label}.`,
    conditions: plan.conditions,
    priority: plan.priority,
    editorialStatus: plan.editorialStatus,
    technicalStatus: 'unknown',
    lastVerifiedAt: null,
    lastVerification: null,
    provenance: [
      {
        source: 'reference-snapshot',
        label: provenance.label,
        url: provenance.url,
        licence: provenance.licence,
        attribution: provenance.attribution,
        digestSha256: provenance.digest,
        capturedAt,
        editorial: false,
      },
    ],
    createdAt: capturedAt,
    updatedAt: capturedAt,
    revision: 1,
  };
}

export class MigrationExecutor {
  private readonly channels;
  private readonly sources;
  private readonly ledger;

  constructor(private readonly context: ImportContext) {
    this.channels = context.database.collection<ChannelDoc>(COLLECTIONS.channels);
    this.sources = context.database.collection<PlaybackSourceDoc>(COLLECTIONS.sources);
    this.ledger = context.database.db.collection<MigrationLedgerDoc>(COLLECTIONS.migrationLedger);
  }

  /**
   * Writes every planned channel and its sources. Channels are committed first
   * and sources second, in two passes, so a slug collision can be resolved
   * before any source points at a channel.
   */
  async execute(plans: readonly ChannelImportPlan[]): Promise<MigrationLedgerDoc> {
    const now = new Date();
    const stats: ImportStats = {
      channelsCreated: 0,
      channelsUpdated: 0,
      sourcePublished: 0,
      sourceWithheld: 0,
      sourcesSkippedDuplicate: 0,
    };
    const exclusions: MigrationLedgerDoc['exclusions'] = [];
    const collisions: MigrationLedgerDoc['publishedSlugCollisions'] = [];

    for (const plan of plans) {
      const record = plan.record;
      const existing = await this.channels.findOne({
        aliases: { $elemMatch: { namespace: LEGACY_NAMESPACE, value: record.legacyId } },
      });

      const desiredSlug = canonicalSlug(plan.slugSeed);
      let slug = existing?.slug ?? desiredSlug;
      if (!existing) {
        const clash = await this.channels.findOne({ slug });
        if (clash) {
          // Never merge two different channels by accident: keep both, distinguish
          // the slug deterministically, and record it for review.
          const suffixed = `${desiredSlug}-${record.index}`.slice(0, 120);
          collisions.push({ slug: desiredSlug, kept: clash.slug, renamed: suffixed });
          slug = suffixed;
        }
      }

      const hasPublished = plan.hasPublishedSource;
      const provenanceLabel = 'Catálogo de referencia TDTChannels (instantánea suministrada por el operador)';
      const provenanceUrl = 'https://github.com/LaQuay/TDTChannels';
      const provenanceAttribution =
        'Datos de referencia: proyecto TDTChannels (github.com/LaQuay/TDTChannels), Apache-2.0. ' +
        'Metadatos reutilizados conforme a su licencia; las descripciones editoriales son propias.';
      const provenance = [
        {
          source: 'tdtchannels-snapshot',
          label: 'Catálogo de referencia TDTChannels (instantánea suministrada por el operador)',
          url: 'https://github.com/LaQuay/TDTChannels',
          licence: 'Apache-2.0',
          attribution:
            'Datos de referencia: proyecto TDTChannels (github.com/LaQuay/TDTChannels), Apache-2.0. ' +
            'Metadatos reutilizados conforme a su licencia; las descripciones editoriales son propias.',
          digestSha256: this.context.digestSha256,
          capturedAt: now,
          editorial: false,
        },
      ];

      const base: ChannelDoc = {
        _id: existing?._id ?? randomUUID(),
        slug,
        name: record.name,
        shortName: record.name.slice(0, 40),
        country: record.countryCode === 'ES' ? 'ES' : 'INT',
        region: record.regionCode ? { code: record.regionCode, name: record.ambit } : null,
        locality: null,
        languageTag: record.countryCode === 'ES' ? 'es' : 'multi',
        category: record.suggestedCategory,
        kind: record.tags.includes('EVT') ? 'eventual' : 'linear',
        websiteUrl: record.webUrl,
        // Our own editorial description starts empty: nothing copied.
        description: existing?.description ?? '',
        branding: record.logoUrl
          ? { logoSrc: record.logoUrl, logoSrcPermission: record.countryCode === 'ES' ? 'emitter' : 'emitter' }
          : existing?.branding ?? null,
        editorialStatus: hasPublished ? 'published' : 'review',
        timezone: record.countryCode === 'ES' ? 'Europe/Madrid' : 'UTC',
        provenance: existing
          ? [...existing.provenance.filter((entry) => entry.source !== 'tdtchannels-snapshot'), ...provenance]
          : provenance,
        aliases: [
          { namespace: LEGACY_NAMESPACE, value: record.legacyId },
          ...(record.epgId ? [{ namespace: 'epg', value: record.epgId }] : []),
          ...(existing?.aliases.filter(
            (alias) => alias.namespace !== LEGACY_NAMESPACE && alias.namespace !== 'epg',
          ) ?? []),
        ],
        searchText: '',
        epg: existing?.epg ?? (record.epgId ? { sourceId: null, externalId: record.epgId } : null),
        mergedInto: null,
        reviewedAt: existing?.reviewedAt ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        revision: (existing?.revision ?? 0) + 1,
      };
      base.searchText = ChannelsService.searchTextFor(base);

      if (existing) {
        await this.channels.replaceOne({ _id: base._id }, base);
        stats.channelsUpdated += 1;
      } else {
        await this.channels.insertOne(base);
        stats.channelsCreated += 1;
      }

      for (const sourcePlan of plan.sources) {
        const duplicate = await this.sources.findOne({ channelId: base._id, url: sourcePlan.url, type: sourcePlan.type });
        if (duplicate) {
          stats.sourcesSkippedDuplicate += 1;
          continue;
        }
        const doc = sourceDocFromPlan(base._id, sourcePlan, now, {
          label: provenanceLabel,
          url: provenanceUrl,
          licence: 'Apache-2.0',
          attribution: provenanceAttribution,
          digest: this.context.digestSha256,
        });
        await this.sources.insertOne(doc);
        if (doc.editorialStatus === 'published') {
          stats.sourcePublished += 1;
        } else {
          stats.sourceWithheld += 1;
          exclusions.push({
            legacyId: record.legacyId,
            name: record.name,
            reason: sourcePlan.withheldReason ?? 'unlicensed',
            detail: `${sourcePlan.type} · ${sourcePlan.emitter.label} · ${sourcePlan.emitter.basis}`,
          });
        }
      }

      if (!hasPublished) {
        exclusions.push({
          legacyId: record.legacyId,
          name: record.name,
          reason: record.options.length === 0 ? 'no-public-source' : 'no-integratable-source',
          detail: `${record.options.length} opción(es) registradas; canal publicado solo cuando la redacción lo decida.`,
        });
      }
    }

    const doc: MigrationLedgerDoc = {
      _id: `${this.context.runLabel}:${now.toISOString()}`,
      kind: 'catalogue-import',
      runAt: now,
      snapshotDigestSha256: this.context.digestSha256,
      snapshotBytes: this.context.bytes,
      snapshotUpdated: this.context.snapshotUpdated,
      channelRecords: plans.length,
      channelsWritten: plans.length,
      sourcesWritten: stats.sourcePublished,
      sourcesWithheld: stats.sourceWithheld,
      exclusions,
      publishedSlugCollisions: collisions,
      stats,
    };
    await this.ledger.insertOne(doc);
    return doc;
  }
}
