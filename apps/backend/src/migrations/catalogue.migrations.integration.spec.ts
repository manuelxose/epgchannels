/**
 * Catalogue migration and store integration: real MongoDB, fresh database per
 * suite, proving the identity-preservation and reversibility guarantees of
 * MODULE-CONTRACT-02B §3.3.
 *
 * Covered here:
 * - every new collection and index in §2.3 exists after migration;
 * - the partial identity index actually enforces uniqueness and excludes merged
 *   records;
 * - pre-existing channels keep `_id`, `slug`, `mergedInto`, `aliases`,
 *   `provenance` and `epg` while gaining `identity` + `catalogueState`;
 * - migrating twice is a no-op and an explicit rollback restores the previous
 *   shape and records the rollback in the ledger;
 * - `ChannelStore` writes are deterministic and idempotent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestHarness } from '../test/harness.js';
import { createHarness } from '../test/harness.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { ChannelDoc as LegacyChannelDoc } from '../infrastructure/schema.js';
import { migrate, migrationStatus, rollbackMigration } from './runner.js';
import { ChannelStore } from '../catalogue/store.js';
import type {
  ChannelAliasDoc,
  ChannelDoc as ExtendedChannelDoc,
  IngestionMetrics,
  IngestionRunDoc,
  SourceCandidateDoc,
} from '../catalogue/schema.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  const database = harness.context.database;
  for (const name of [
    COLLECTIONS.channels,
    COLLECTIONS.sourceSnapshots,
    COLLECTIONS.sourceCandidates,
    COLLECTIONS.channelAliases,
    COLLECTIONS.channelVariants,
    COLLECTIONS.sourceAuthorization,
    COLLECTIONS.sourceHealth,
    COLLECTIONS.epgMappings,
    COLLECTIONS.reconciliationReview,
    COLLECTIONS.ingestionRuns,
  ]) {
    await database.db.collection(name).deleteMany({});
  }
  await database.db.collection(COLLECTIONS.migrationLedger).deleteMany({});
});

function legacyChannel(id: string, overrides: Partial<LegacyChannelDoc> = {}): LegacyChannelDoc {
  const slug = overrides.slug ?? `canal-${id}`;
  return {
    _id: id,
    slug,
    name: overrides.name ?? 'Canal Ejemplo',
    shortName: 'Canal Ejemplo',
    country: overrides.country ?? 'ES',
    region: overrides.region ?? { code: 'MD', name: 'Comunidad de Madrid' },
    locality: null,
    languageTag: overrides.languageTag ?? 'es',
    category: 'generalista',
    kind: 'linear',
    websiteUrl: null,
    description: overrides.description ?? '',
    branding: null,
    editorialStatus: overrides.editorialStatus ?? 'published',
    timezone: 'Europe/Madrid',
    provenance: overrides.provenance ?? [
      {
        source: 'tdtchannels-snapshot',
        label: 'Ref',
        url: null,
        licence: 'Apache-2.0',
        attribution: null,
        digestSha256: 'a'.repeat(64),
        capturedAt: NOW,
        editorial: false,
      },
    ],
    aliases: overrides.aliases ?? [{ namespace: 'legacy-tdt', value: 'Spain/Generalistas/Canal Ejemplo' }],
    searchText: 'canal ejemplo',
    epg: overrides.epg ?? { sourceId: null, externalId: 'Uno.TV' },
    mergedInto: overrides.mergedInto ?? null,
    reviewedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1,
  };
}

function catalogueChannel(id: string, overrides: Partial<ExtendedChannelDoc> = {}): ExtendedChannelDoc {
  const base = legacyChannel(id);
  const slug = overrides.slug ?? base.slug;
  return {
    ...base,
    identity: { key: `es:${slug}`, country: 'ES', language: 'es', variantKey: null, network: null },
    publicSlugSource: 'name',
    catalogueState: 'staging',
    ...overrides,
  };
}

function candidateDoc(id: string): SourceCandidateDoc {
  return {
    _id: id,
    channelId: null,
    snapshotId: 'snap-1',
    upstream: 'iptv-org',
    url: 'https://example.com/stream.m3u8',
    normalizedUrl: 'https://example.com/stream.m3u8',
    urlSha256: 'b'.repeat(64),
    type: 'hls',
    name: 'Canal Ejemplo',
    attributes: {},
    country: 'ES',
    provider: null,
    groupTitle: null,
    language: 'es',
    quality: null,
    flags: [],
    provenance: {
      snapshotId: 'snap-1',
      upstream: 'iptv-org',
      upstreamPath: 'streams/es.m3u',
      line: 1,
      rawName: 'Canal Ejemplo',
      rawAttributes: {},
      retrievedAt: NOW,
      checksumSha256: 'c'.repeat(64),
    },
    state: 'staging',
    rejectionReason: null,
    duplicateOf: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function runDoc(id: string, metrics: IngestionMetrics): IngestionRunDoc {
  return {
    _id: id,
    snapshotId: 'snap-1',
    upstream: 'iptv-org',
    startedAt: NOW,
    finishedAt: null,
    status: 'running',
    createdChannelIds: ['ch-run'],
    createdCandidateIds: ['cand-run'],
    metrics,
  };
}

function aliasDoc(id: string, channelId: string): ChannelAliasDoc {
  return {
    _id: id,
    channelId,
    namespace: 'tvg-id',
    value: 'Uno.TV',
    source: 'iptv-org',
    confidence: 1,
    createdAt: NOW,
  };
}

const EMPTY_METRICS: IngestionMetrics = {
  upstream: 'iptv-org',
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

async function indexNames(collection: string): Promise<Set<string>> {
  const rows = await harness.context.database.db.collection(collection).indexes();
  return new Set(rows.map((row) => row.name ?? ''));
}

describe('catalogue migrations on a real database', () => {
  it('creates every collection and required index in §2.3 on an empty database', async () => {
    await migrate(harness.context.database);

    const expected: Record<string, string[]> = {
      [COLLECTIONS.channels]: ['identity_key_unique', 'identity_country_language'],
      [COLLECTIONS.sourceSnapshots]: ['snapshot_upstream_retrieved', 'snapshot_identity_unique'],
      [COLLECTIONS.sourceCandidates]: [
        /*
         * The natural key now includes provenance.upstreamPath. A line number is
         * only unique inside one upstream file, and omitting the path let two
         * files of the same snapshot collide on the same URL and line (E11000),
         * aborting a real ingest. Migration 007 replaces the previous index.
         */
        'candidate_line_in_file_unique',
        'candidate_url',
        'candidate_channel_state',
        'candidate_state_upstream',
        'candidate_upstream_path',
      ],
      [COLLECTIONS.channelAliases]: ['alias_namespace_value_channel_unique', 'alias_namespace_value', 'alias_channel'],
      [COLLECTIONS.channelVariants]: ['variant_channel_key_unique'],
      [COLLECTIONS.sourceAuthorization]: ['authorization_candidate_unique', 'authorization_channel_decision'],
      [COLLECTIONS.sourceHealth]: ['health_candidate_unique', 'health_state_next_check'],
      [COLLECTIONS.epgMappings]: ['epg_channel_namespace_external_unique'],
      [COLLECTIONS.reconciliationReview]: ['review_status_created', 'review_candidate_unique'],
      [COLLECTIONS.ingestionRuns]: ['run_snapshot', 'run_status_started'],
    };

    for (const [collection, names] of Object.entries(expected)) {
      const actual = await indexNames(collection);
      for (const name of names) {
        expect(actual.has(name), `${collection} index ${name}`).toBe(true);
      }
    }
  });

  it('replaces the pre-fix alias unique index so fresh and existing databases converge', async () => {
    const database = harness.context.database;
    // Simulate a database that already ran the pre-fix migration.
    await database.db
      .collection(COLLECTIONS.channelAliases)
      .createIndex({ namespace: 1, value: 1 }, { name: 'alias_namespace_value_unique', unique: true });

    await migrate(database);

    const names = await indexNames(COLLECTIONS.channelAliases);
    expect(names).not.toContain('alias_namespace_value_unique');
    expect(names).toContain('alias_namespace_value_channel_unique');
    expect(names).toContain('alias_namespace_value');
    expect(names).toContain('alias_channel');
  });

  it('preserves _id, slug, mergedInto and relationships while backfilling identity', async () => {
    const database = harness.context.database;
    const channels = database.collection<LegacyChannelDoc>(COLLECTIONS.channels);
    await channels.insertMany([
      legacyChannel('es-1', { slug: 'canal-publico-uno', name: 'Canal Público Uno' }),
      legacyChannel('int-1', {
        slug: 'canal-europeo',
        country: 'INT',
        region: null,
        languageTag: 'multi',
        mergedInto: 'es-1',
      }),
    ]);

    const before = await channels.find({}).sort({ _id: 1 }).toArray();

    await migrate(database);

    const after = await channels.find({}).sort({ _id: 1 }).toArray();
    expect(after).toHaveLength(2);

    for (const doc of after) {
      const prior = before.find((entry) => entry._id === doc._id);
      expect(prior).toBeDefined();
      // Identities preserved verbatim.
      expect(doc._id).toBe(prior?._id);
      expect(doc.slug).toBe(prior?.slug);
      expect(doc.mergedInto).toBe(prior?.mergedInto);
      expect(doc.aliases).toEqual(prior?.aliases);
      expect(doc.epg).toEqual(prior?.epg);
      expect(doc.provenance.map((p) => ({ source: p.source, licence: p.licence, digestSha256: p.digestSha256 }))).toEqual(
        prior?.provenance.map((p) => ({ source: p.source, licence: p.licence, digestSha256: p.digestSha256 })),
      );
      expect(doc.description).toBe(prior?.description);
      expect(doc.editorialStatus).toBe(prior?.editorialStatus);
    }

    const spanish = after.find((doc) => doc._id === 'es-1');
    expect(spanish).toMatchObject({
      identity: { key: 'es:canal-publico-uno', country: 'ES', language: 'es', variantKey: null, network: null },
      catalogueState: 'approved',
      publicSlugSource: null,
    });

    const merged = after.find((doc) => doc._id === 'int-1');
    expect(merged).toMatchObject({
      mergedInto: 'es-1',
      identity: { key: 'int:canal-europeo', country: null, language: 'und' },
      catalogueState: 'approved',
    });
  });

  it('is a no-op on the second run', async () => {
    const database = harness.context.database;
    await database.collection<LegacyChannelDoc>(COLLECTIONS.channels).insertOne(legacyChannel('es-1'));

    await migrate(database);
    const afterFirst = await database
      .collection<LegacyChannelDoc>(COLLECTIONS.channels)
      .find({})
      .sort({ _id: 1 })
      .toArray();

    const second = await migrate(database);
    expect(second.applied).toEqual([]);

    const afterSecond = await database
      .collection<LegacyChannelDoc>(COLLECTIONS.channels)
      .find({})
      .sort({ _id: 1 })
      .toArray();
    expect(afterSecond).toEqual(afterFirst);
  });

  it('rolls back 004, restores the previous shape and records the rollback', async () => {
    const database = harness.context.database;
    await database.collection<LegacyChannelDoc>(COLLECTIONS.channels).insertOne(legacyChannel('es-1'));
    await migrate(database);

    expect(await indexNames(COLLECTIONS.channels)).toContain('identity_key_unique');

    const result = await rollbackMigration(database, '004-catalogue-identity');
    expect(result.name).toBe('004-catalogue-identity');

    const channel = await database.collection<LegacyChannelDoc>(COLLECTIONS.channels).findOne({ _id: 'es-1' });
    expect(channel).not.toHaveProperty('identity');
    expect(channel).not.toHaveProperty('catalogueState');
    expect(channel).not.toHaveProperty('publicSlugSource');
    expect(channel?.slug).toBe('canal-es-1');

    expect(await indexNames(COLLECTIONS.channels)).not.toContain('identity_key_unique');

    const status = await migrationStatus(database);
    expect(status.pending).toContain('004-catalogue-identity');

    const rollbackRecord = await database.db
      .collection(COLLECTIONS.migrationLedger)
      .findOne({ name: '004-catalogue-identity', kind: 'rolled-back' });
    expect(rollbackRecord?.rolledBackAt).toBeInstanceOf(Date);
  });

  it('rolls back 005 and 006 by dropping only the indexes those migrations created', async () => {
    const database = harness.context.database;
    await migrate(database);

    await rollbackMigration(database, '006-incremental-dedup');
    await rollbackMigration(database, '005-source-snapshot-provenance');

    expect(await indexNames(COLLECTIONS.channelAliases)).not.toContain('alias_namespace_value_channel_unique');
    expect(await indexNames(COLLECTIONS.channelAliases)).not.toContain('alias_namespace_value');
    expect(await indexNames(COLLECTIONS.sourceCandidates)).not.toContain('candidate_snapshot_url_line_unique');
    expect(await indexNames(COLLECTIONS.ingestionRuns)).not.toContain('run_snapshot');
    expect(await indexNames(COLLECTIONS.channels)).toContain('identity_key_unique');
  });

  it('rejects a duplicate identity key and excludes merged records from the partial index', async () => {
    const database = harness.context.database;
    await migrate(database); // creates the partial unique index

    const channels = database.collection<ExtendedChannelDoc>(COLLECTIONS.channels);
    await channels.insertOne(
      catalogueChannel('a', {
        identity: { key: 'es:dup', country: 'ES', language: 'es', variantKey: null, network: null },
      }),
    );
    // A merged record shares the key but is excluded from the partial index.
    await channels.insertOne(
      catalogueChannel('b', {
        mergedInto: 'a',
        identity: { key: 'es:dup', country: 'ES', language: 'es', variantKey: null, network: null },
      }),
    );

    await expect(
      channels.insertOne(
        catalogueChannel('c', {
          identity: { key: 'es:dup', country: 'ES', language: 'es', variantKey: null, network: null },
        }),
      ),
    ).rejects.toThrow(/E11000|duplicate key/i);
  });
});

describe('ChannelStore idempotency', () => {
  it('repeats upsertChannel, insertCandidate and recordRun without creating duplicates', async () => {
    const store = new ChannelStore(harness.context.database);

    const channel = catalogueChannel('ch-1', { slug: 'canal-idempotente' });
    await store.upsertChannel(channel);
    await store.upsertChannel(channel);

    const candidate = candidateDoc('cand-1');
    await store.insertCandidate(candidate);
    await store.insertCandidate(candidate);

    await store.recordRun(runDoc('run-1', EMPTY_METRICS));
    await store.recordRun(runDoc('run-1', EMPTY_METRICS));

    const alias = aliasDoc('alias-1', 'ch-1');
    await store.addAlias(alias);
    await store.addAlias(alias);

    expect(await harness.context.database.collection(COLLECTIONS.channels).countDocuments({})).toBe(1);
    expect(await harness.context.database.collection(COLLECTIONS.sourceCandidates).countDocuments({})).toBe(1);
    expect(await harness.context.database.collection(COLLECTIONS.ingestionRuns).countDocuments({})).toBe(1);
    expect(await harness.context.database.collection(COLLECTIONS.channelAliases).countDocuments({})).toBe(1);
  });

  it('findByKey and findByAlias resolve the canonical channel', async () => {
    const store = new ChannelStore(harness.context.database);
    const channel = catalogueChannel('ch-1', { slug: 'canal-resuelto' });
    await store.upsertChannel(channel);
    await store.addAlias(aliasDoc('alias-1', 'ch-1'));

    const byKey = await store.findByKey('es:canal-resuelto');
    expect(byKey?._id).toBe('ch-1');

    const byAlias = await store.findByAlias('tvg-id', 'Uno.TV');
    expect(byAlias?._id).toBe('ch-1');
  });

  it('rollbackRun removes exactly what the run created', async () => {
    const store = new ChannelStore(harness.context.database);
    await store.upsertChannel(catalogueChannel('ch-run'));
    await store.insertCandidate(candidateDoc('cand-run'));

    const run = runDoc('run-1', EMPTY_METRICS);
    await store.recordRun(run);

    const result = await store.rollbackRun('run-1');
    expect(result.removed).toBe(2);
    expect(await harness.context.database.collection(COLLECTIONS.channels).countDocuments({})).toBe(0);
    expect(await harness.context.database.collection(COLLECTIONS.sourceCandidates).countDocuments({})).toBe(0);

    const storedRun = await harness.context.database.collection<IngestionRunDoc>(COLLECTIONS.ingestionRuns).findOne({ _id: 'run-1' });
    expect(storedRun?.status).toBe('rolled-back');
  });

  it('allows a shared tvg-id across channels and idempotently re-adds the same alias', async () => {
    const store = new ChannelStore(harness.context.database);
    await migrate(harness.context.database); // ensures the new unique index set exists

    await store.upsertChannel(catalogueChannel('ch-1', { slug: 'canal-uno' }));
    await store.upsertChannel(catalogueChannel('ch-2', { slug: 'canal-dos' }));

    // Same tvg-id, different channels → both attach without error.
    await store.addAlias(aliasDoc('alias-1', 'ch-1')); // value 'Uno.TV'
    await store.addAlias(aliasDoc('alias-2', 'ch-2')); // value 'Uno.TV'

    // Repeated add of the same {namespace, value, channelId} is a no-op, even
    // when a fresh `_id` is supplied (natural-key idempotency).
    await store.addAlias(aliasDoc('alias-1b', 'ch-1'));

    expect(await harness.context.database.collection(COLLECTIONS.channelAliases).countDocuments({})).toBe(2);

    const owners = await harness.context.database
      .collection<ChannelAliasDoc>(COLLECTIONS.channelAliases)
      .find({ namespace: 'tvg-id', value: 'Uno.TV' })
      .sort({ channelId: 1 })
      .toArray();
    expect(owners.map((owner) => owner.channelId)).toEqual(['ch-1', 'ch-2']);
  });

  it('listIdentities projects tvgIds and urlHosts via batched queries', async () => {
    const store = new ChannelStore(harness.context.database);
    await store.upsertChannel(catalogueChannel('ch-1', { slug: 'canal-uno' }));
    await store.addAlias(aliasDoc('alias-1', 'ch-1')); // 'Uno.TV'
    await store.addAlias({ ...aliasDoc('alias-2', 'ch-1'), value: 'Uno.HD' });
    await store.insertCandidate({
      ...candidateDoc('cand-1'),
      channelId: 'ch-1',
      urlSha256: `${'b'.repeat(63)}1`,
      normalizedUrl: 'https://rtve.es/live.m3u8',
    });
    await store.insertCandidate({
      ...candidateDoc('cand-2'),
      channelId: 'ch-1',
      urlSha256: `${'b'.repeat(63)}2`,
      normalizedUrl: 'https://rtve.es/alt.m3u8',
    });

    const identities = await store.listIdentities();
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      channelId: 'ch-1',
      key: 'es:canal-uno',
      tvgIds: expect.arrayContaining(['Uno.TV', 'Uno.HD']),
      urlHosts: expect.arrayContaining(['rtve.es']),
    });
  });
});
