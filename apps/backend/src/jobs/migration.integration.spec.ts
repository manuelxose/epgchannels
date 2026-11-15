/**
 * Migration integration: the real import pipeline over a real database.
 *
 * The payload below mirrors the *shape* of an operator-supplied reference
 * snapshot (it is written by this test, not copied from anyone's catalogue), so
 * the pipeline is exercised end to end: extraction, editorial taxonomy, emitter
 * decisions, source planning, idempotent writing and the exclusion ledger.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestHarness } from '../test/harness.js';
import { createHarness } from '../test/harness.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { ChannelDoc, EpgSourceDoc, PlaybackSourceDoc } from '../infrastructure/schema.js';
import { categoryForAmbit, extractReferenceChannels, planChannel } from '../jobs/catalogue-import.js';
import { MigrationExecutor, type MigrationLedgerDoc } from '../jobs/migration-executor.js';
import { migrate } from '../migrations/runner.js';

/** A reference snapshot with the same structure as the real one. */
const SNAPSHOT = {
  updated: 1_794_000_000,
  countries: [
    {
      name: 'Spain',
      ambits: [
        {
          name: 'Generalistas',
          channels: [
            {
              name: 'Canal Público Uno',
              web: 'https://www.rtve.es/play/directo/uno/',
              logo: 'https://www.rtve.es/logo.png',
              epg_id: 'Uno.TV',
              options: [{ format: 'm3u8', url: 'https://rtvelivestream.rtve.es/uno/main.m3u8' }],
              extra_info: ['GEO'],
            },
            {
              name: 'Canal Deportivo',
              web: 'https://www.mitele.es/directo/deportivo',
              epg_id: 'Dep.TV',
              options: [{ format: 'm3u8', url: 'https://stream.example.cdn/deportivo.m3u8', geo2: 'ES' }],
              extra_info: [],
            },
            {
              name: 'Canal Con App',
              // An emitter with no recorded decision: the signal is never exposed.
              web: 'https://app-unknown.example.com/',
              options: [{ format: 'm3u8', url: 'https://app.example.cdn/señal.m3u8' }],
              extra_info: ['UAG'],
            },
            {
              name: 'Canal Del Foro',
              web: 'https://foro.example.com/directo',
              options: [{ format: 'm3u8', url: 'https://cdn.foro.example.com/live.m3u8' }],
              extra_info: ['REF'],
            },
            {
              name: 'Canal De La Plataforma',
              web: 'https://www.youtube.com/@canal/live',
              options: [{ format: 'youtube', url: 'https://www.youtube.com/channel/UC1234567890123456789012/live' }],
              extra_info: ['EMB'],
            },
            {
              name: 'Canal Con Tokens',
              web: 'https://www.rtve.es/tokens/',
              options: [
                {
                  format: 'm3u8',
                  url: 'https://ads.example.net/playlist.m3u8?did=[DEVICE_ID]&ip=[IP]',
                },
              ],
              extra_info: [],
            },
          ],
        },
        {
          name: 'Andalucía',
          channels: [
            {
              name: 'Canal Local Sur',
              web: 'https://www.canalsurmas.es/directo',
              options: [{ format: 'm3u8', url: 'https://canalsurmas.es/live.m3u8' }],
            },
            {
              name: 'Canal Sin Info',
              web: 'https://www.canalsurmas.es/otro',
              options: [],
            },
          ],
        },
        {
          name: 'C. de Madrid',
          channels: [
            {
              name: 'Canal Madrileño',
              web: 'https://www.telemadrid.es/directo',
              options: [{ format: 'm3u8', url: 'https://cdn.telemadrid.es/live.m3u8' }],
            },
          ],
        },
      ],
    },
    {
      name: 'International',
      ambits: [
        {
          name: 'Int. Europa',
          channels: [
            {
              name: 'Canal Europeo',
              web: 'https://www.rtp.pt/play/direto',
              options: [{ format: 'm3u8', url: 'https://rtp.pt/live.m3u8' }],
            },
          ],
        },
      ],
    },
  ],
};

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.context.database.collection(COLLECTIONS.channels).deleteMany({});
  await harness.context.database.collection(COLLECTIONS.sources).deleteMany({});
  await harness.context.database.db.collection(COLLECTIONS.migrationLedger).deleteMany({});
});

function plans() {
  const extracted = extractReferenceChannels(SNAPSHOT);
  return { extracted, plans: extracted.records.map(planChannel) };
}

function executor(): MigrationExecutor {
  return new MigrationExecutor({
    database: harness.context.database,
    digestSha256: 'a'.repeat(64),
    bytes: 4096,
    snapshotUpdated: SNAPSHOT.updated,
    runLabel: 'catalogue-import',
    legalNote: 'Prueba.',
  });
}

describe('editorial taxonomy applied to the reference structure', () => {
  it('maps each ambit onto our own category', () => {
    expect(categoryForAmbit('Spain', 'Generalistas', null)).toBe('generalista');
    expect(categoryForAmbit('Spain', 'Deportivos', null)).toBe('deportes');
    expect(categoryForAmbit('Spain', 'Informativos', null)).toBe('informativos');
    expect(categoryForAmbit('Spain', 'Andalucía', 'AN')).toBe('autonomica');
    expect(categoryForAmbit('International', 'Int. Europa', null)).toBe('internacional');
  });

  it('resolves Spanish regions to ISO 3166-2:ES codes and leaves international ones unmapped', () => {
    const { extracted } = plans();
    const records = extracted.records;
    expect(records.find((record) => record.name === 'Canal Local Sur')?.regionCode).toBe('AN');
    expect(records.find((record) => record.name === 'Canal Madrileño')?.regionCode).toBe('MD');
    const european = records.find((record) => record.name === 'Canal Europeo');
    expect(european?.regionCode).toBeNull();
    expect(european?.countryCode).toBe('INT');
  });

  it('extracts every record of the snapshot, rejecting none it can read', () => {
    const { extracted } = plans();
    expect(extracted.records).toHaveLength(10);
    expect(extracted.rejected).toBe(0);
  });
});

describe('source planning by integration conditions', () => {
  it('publishes a public broadcaster stream and a licensed operator stream', () => {
    const { plans: list } = plans();
    const publicChannel = list.find((plan) => plan.record.name === 'Canal Público Uno');
    expect(publicChannel?.hasPublishedSource).toBe(true);
    const source = publicChannel?.sources[0];
    expect(source?.permission).toBe('emitter-public-stream');
    expect(source?.withheldReason).toBeNull();
  });

  it('withholds a source that needs the emitter application', () => {
    const { plans: list } = plans();
    const channel = list.find((plan) => plan.record.name === 'Canal Con App');
    expect(channel?.hasPublishedSource).toBe(false);
    expect(channel?.sources.some((source) => source.withheldReason === 'emitter-app-only')).toBe(true);
  });

  it('withholds a source that needs a Referer we will not forge', () => {
    const { plans: list } = plans();
    const channel = list.find((plan) => plan.record.name === 'Canal Del Foro');
    expect(channel?.sources.some((source) => source.withheldReason === 'requires-forged-header')).toBe(true);
  });

  it('withholds a URL that needs client-side tokens', () => {
    const { plans: list } = plans();
    const channel = list.find((plan) => plan.record.name === 'Canal Con Tokens');
    expect(channel?.sources.some((source) => source.withheldReason === 'credentials-required')).toBe(true);
  });

  it('integrates a platform channel only through its official player', () => {
    const { plans: list } = plans();
    const channel = list.find((plan) => plan.record.name === 'Canal De La Plataforma');
    const source = channel?.sources[0];
    expect(source?.type).toBe('youtube');
    expect(source?.permission).toBe('emitter-embeddable');
    expect(source?.editorialStatus).toBe('published');
  });

  it('keeps an emitter with no recorded decision as a withheld draft', () => {
    const { plans: list } = plans();
    const channel = list.find((plan) => plan.record.name === 'Canal Madrileño');
    expect(channel?.hasPublishedSource).toBe(false);
    expect(channel?.sources.some((source) => source.withheldReason === 'unlicensed')).toBe(true);
  });

  it('adds an external reference for a channel with no usable option', () => {
    const { plans: list } = plans();
    const channel = list.find((plan) => plan.record.name === 'Canal Sin Info');
    expect(channel?.sources).toHaveLength(1);
    expect(channel?.sources[0]?.type).toBe('external');
  });
});

describe('executing the migration', () => {
  it('writes channels with our own identity, aliases and provenance', async () => {
    const { plans: list } = plans();
    const ledger = await executor().execute(list);
    expect(ledger.stats.channelsCreated).toBe(list.length);

    const channel = await harness.context.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .findOne({ name: 'Canal Público Uno' });
    expect(channel?._id).toMatch(/^[0-9a-f-]{36}$/);
    expect(channel?.slug).toBe('canal-publico-uno');
    expect(channel?.editorialStatus).toBe('published');
    expect(channel?.aliases).toEqual(
      expect.arrayContaining([
        { namespace: 'legacy-tdt', value: 'Spain/Generalistas/Canal Público Uno' },
        { namespace: 'epg', value: 'Uno.TV' },
      ]),
    );
    expect(channel?.provenance[0]).toMatchObject({ source: 'tdtchannels-snapshot', licence: 'Apache-2.0' });
    expect(channel?.provenance[0]?.digestSha256).toBe('a'.repeat(64));
  });

  it('records every excluded source with its reason, losing nothing silently', async () => {
    const { plans: list } = plans();
    const ledger = await executor().execute(list);
    const reasons = new Set(ledger.exclusions.map((exclusion) => exclusion.reason));
    expect(reasons).toContain('emitter-app-only');
    expect(reasons).toContain('requires-forged-header');
    expect(reasons).toContain('credentials-required');
    expect(reasons).toContain('unlicensed');
    for (const exclusion of ledger.exclusions) {
      expect(exclusion.legacyId.length).toBeGreaterThan(0);
      expect(exclusion.name.length).toBeGreaterThan(0);
    }
  });

  it('is idempotent: re-running updates instead of duplicating', async () => {
    const first = plans();
    await executor().execute(first.plans);
    const channelsAfterFirst = await harness.context.database.collection(COLLECTIONS.channels).countDocuments({});
    const sourcesAfterFirst = await harness.context.database.collection(COLLECTIONS.sources).countDocuments({});

    const second = plans();
    const ledger = await executor().execute(second.plans);
    expect(ledger.stats.channelsCreated).toBe(0);
    expect(ledger.stats.channelsUpdated).toBe(first.plans.length);
    expect(await harness.context.database.collection(COLLECTIONS.channels).countDocuments({})).toBe(channelsAfterFirst);
    expect(await harness.context.database.collection(COLLECTIONS.sources).countDocuments({})).toBe(sourcesAfterFirst);
  });

  it('never publishes an unreviewed emitter and keeps the channel for review', async () => {
    const { plans: list } = plans();
    await executor().execute(list);
    const channel = await harness.context.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .findOne({ name: 'Canal Madrileño' });
    expect(channel?.editorialStatus).toBe('review');
    const sources = await harness.context.database
      .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
      .find({ channelId: channel?._id ?? String() })
      .toArray();
    expect(sources.every((source) => source.editorialStatus !== 'published')).toBe(true);
  });

  it('records the snapshot digest in the migration ledger', async () => {
    const { plans: list } = plans();
    const ledger = await executor().execute(list);
    const stored = await harness.context.database.db
      .collection<MigrationLedgerDoc>(COLLECTIONS.migrationLedger)
      .findOne({ _id: ledger._id });
    expect(stored?.snapshotDigestSha256).toBe('a'.repeat(64));
    expect(stored?.channelRecords).toBe(list.length);
  });
});

describe('migrations', () => {
  it('are idempotent and leave nothing pending', async () => {
    const first = await migrate(harness.context.database);
    const second = await migrate(harness.context.database);
    expect(first.applied.length).toBeGreaterThan(0);
    expect(second.applied).toEqual([]);
    expect(second.already.length).toBe(first.applied.length + first.already.length);
  });

  it('register the editorial guide source', async () => {
    await migrate(harness.context.database);
    const editorial = await harness.context.database
      .collection<EpgSourceDoc>(COLLECTIONS.epgSources)
      .findOne({ kind: 'editorial' });
    expect(editorial?.name).toBe('Redacción TDT Platform');
    expect(editorial?.ingestionEnabled).toBe(false);
  });
});
