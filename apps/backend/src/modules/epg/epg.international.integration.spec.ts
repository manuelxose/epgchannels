/**
 * EPG international subsystem on a **real MongoDB** (TDT-API-02FG).
 *
 * What this suite proves, in the order the contract states it:
 *
 * - ingestion of a real XMLTV document and of the `json-tdtchannels` shape, with
 *   the source's own zone and a real daylight-saving boundary;
 * - ETag/`Last-Modified` conditional requests: a `304` writes nothing at all;
 * - incremental re-ingestion is idempotent and the per-source counters move;
 * - canonical `epg_mappings`: a confirmed row maps, an unmapped upstream id is
 *   only proposed, a rejected pair is never re-attached, and every operator
 *   decision lands in `audit_log`;
 * - duplicate detection marks `duplicateOf` without deleting either row;
 * - `coverage()` classifies `fresh | stale | empty | not-mapped` and never
 *   invents a programme;
 * - `epg_sync_runs` records every attempt, success or failure;
 * - migration 009 is idempotent and its `down` really reverts.
 */
import { afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest';
import type { TestHarness } from '../../test/harness.js';
import { createHarness } from '../../test/harness.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { AuditDoc, ChannelDoc, EpgSourceDoc, ProgrammeDoc } from '../../infrastructure/schema.js';
import type { EpgMappingDoc } from '../../catalogue/schema.js';
import { EpgIngestionService, type FetchedGuide, type GuideFetcher } from './epg.ingestion.js';
import { EpgService } from './epg.service.js';
import { EpgMappingService } from './epg.mappings.js';
import { EpgSyncRunService, MAX_ATTEMPTS, retryDelayMs } from './epg.sync.js';
import { migrate, migrationStatus, rollbackMigration } from '../../migrations/runner.js';
import { EPG_PROGRAMME_INDEXES, EPG_SOURCE_INDEXES, EPG_SYNC_RUN_INDEXES } from '../../migrations/009-epg-international.js';

const EGRESS = { blockedHosts: [], timeoutMs: 5_000 } as const;
const SOURCE_ID = '00000000-0000-4000-8000-0000000e5001';
const CHANNEL_A = '00000000-0000-4000-8000-0000000c0001';
const CHANNEL_B = '00000000-0000-4000-8000-0000000c0002';
const XMLTV_URL = 'https://guide.example.org/xmltv.xml';

let harness: TestHarness;

/** A fetcher that always answers the same document and records its inputs. */
function stubFetcher(guide: FetchedGuide): { fetcher: GuideFetcher; calls: { url: string; etag?: string | null }[] } {
  const calls: { url: string; etag?: string | null }[] = [];
  const fetcher: GuideFetcher = async (url, _egress, validators) => {
    calls.push({ url, ...(validators.etag !== undefined ? { etag: validators.etag } : {}) });
    return guide;
  };
  return { fetcher, calls };
}

function channelDoc(overrides: Partial<ChannelDoc> & Pick<ChannelDoc, '_id' | 'slug' | 'name'>): ChannelDoc {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    country: 'ES',
    shortName: overrides.name.slice(0, 20),
    region: null,
    locality: null,
    languageTag: 'es',
    category: 'generalista',
    kind: 'linear',
    websiteUrl: null,
    description: '',
    branding: null,
    editorialStatus: 'published',
    timezone: 'Europe/Madrid',
    provenance: [],
    aliases: [],
    searchText: overrides.name.toLowerCase(),
    epg: { sourceId: null, externalId: null },
    mergedInto: null,
    reviewedAt: null,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    ...overrides,
  };
}

const XMLTV_GUIDE = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="La1.TV"><display-name>La 1</display-name></channel>
  <programme start="20260329013000 +0100" stop="20260329025000 +0100" channel="La1.TV">
    <title>Telediario</title>
    <desc>Informe</desc>
    <category>NEWS</category>
  </programme>
  <programme start="20260329030000 +0200" stop="20260329040000 +0200" channel="La1.TV">
    <title>TELEDIARIO</title>
    <desc>Copia emitida con otra clave</desc>
  </programme>
  <programme start="20260329040000 +0200" stop="20260329050000 +0200" channel="La2.TV">
    <title>Documental</title>
  </programme>
</tv>`;

const XMLTV_FULL: FetchedGuide = {
  status: 200,
  ok: true,
  body: XMLTV_GUIDE,
  etag: '"v1"',
  lastModified: 'Sun, 29 Mar 2026 01:00:00 GMT',
};

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  const db = harness.context.database.db;
  for (const name of [
    COLLECTIONS.channels,
    COLLECTIONS.programmes,
    COLLECTIONS.epgSources,
    COLLECTIONS.epgMappings,
    COLLECTIONS.epgSyncRuns,
    COLLECTIONS.audits,
    COLLECTIONS.jobRuns,
  ]) {
    await db.collection(name).deleteMany({});
  }
  const now = new Date('2026-03-28T00:00:00Z');
  const source: EpgSourceDoc = {
    _id: SOURCE_ID,
    name: 'Guía XMLTV de prueba',
    kind: 'xmltv',
    url: XMLTV_URL,
    licence: 'Apache-2.0',
    attribution: 'Guía de prueba',
    ingestionEnabled: true,
    status: 'published',
    lastRunAt: null,
    lastRunStatus: 'never',
    lastRunProgrammes: 0,
    createdAt: now,
    updatedAt: now,
    country: 'ES',
    language: 'es',
    timezone: 'Europe/Madrid',
    fetchIntervalMinutes: 60,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    nextRunAt: null,
    httpEtag: null,
    httpLastModified: null,
  };
  await db.collection<EpgSourceDoc>(COLLECTIONS.epgSources).insertOne(source);
  await db.collection<ChannelDoc>(COLLECTIONS.channels).insertMany([
    channelDoc({ _id: CHANNEL_A, slug: 'la-1', name: 'La 1' }),
    channelDoc({ _id: CHANNEL_B, slug: 'la-2', name: 'La 2' }),
  ]);
});

function services(fetcher?: GuideFetcher): {
  epg: EpgService;
  ingestion: EpgIngestionService;
  mappings: EpgMappingService;
  runs: EpgSyncRunService;
} {
  const epg = new EpgService(harness.context.database);
  const ingestion = new EpgIngestionService(harness.context.database, epg, fetcher);
  return {
    epg,
    ingestion,
    mappings: new EpgMappingService(harness.context.database),
    runs: new EpgSyncRunService(harness.context.database),
  };
}

describe('XMLTV ingestion on a real database', () => {
  it('ingests a confirmed mapping, normalises the DST boundary and records the run', async () => {
    const { ingestion, mappings } = services(stubFetcher(XMLTV_FULL).fetcher);
    await mappings.create(
      { channelId: CHANNEL_A, epgSourceId: SOURCE_ID, externalId: 'La1.TV' },
      { type: 'user', id: 'editor-1' },
      'Emparejamiento revisado a mano.',
    );

    const result = await ingestion.runSource(SOURCE_ID, EGRESS, 'manual:editor-1', { trigger: 'manual' });
    expect(result.status).toBe('ok');
    expect(result.channelsMatched).toBe(1);

    const docs = await harness.context.database
      .collection<ProgrammeDoc>(COLLECTIONS.programmes)
      .find({ channelId: CHANNEL_A })
      .sort({ start: 1 })
      .toArray();
    expect(docs).toHaveLength(2);
    // 01:30+01:00 and 03:00+02:00 are one hour apart in real time: the 02:00
    // local hour does not exist on 2026-03-29.
    expect(docs[0]?.start.toISOString()).toBe('2026-03-29T00:30:00.000Z');
    expect(docs[1]?.start.toISOString()).toBe('2026-03-29T01:00:00.000Z');
    // The zone of the upstream reading is kept for audit.
    expect(docs[0]?.timezone).toBe('UTC');
    expect(docs[0]?.originalStart?.toISOString()).toBe('2026-03-29T00:30:00.000Z');

    const source = await harness.context.database
      .collection<EpgSourceDoc>(COLLECTIONS.epgSources)
      .findOne({ _id: SOURCE_ID });
    expect(source?.lastRunStatus).toBe('ok');
    expect(source?.consecutiveFailures).toBe(0);
    expect(source?.httpEtag).toBe('"v1"');
    expect(source?.lastSuccessAt).toBeInstanceOf(Date);
    expect(source?.nextRunAt).toBeInstanceOf(Date);

    const runs = await services().runs.list({ sourceId: SOURCE_ID });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'ok', trigger: 'manual', sourceName: 'Guía XMLTV de prueba' });
    expect(runs[0]?.programmes).toBeGreaterThan(0);
  });

  it('sends the stored validators and does nothing at all on a 304', async () => {
    const { ingestion, mappings } = services();
    await mappings.create({ channelId: CHANNEL_A, epgSourceId: SOURCE_ID, externalId: 'La1.TV' }, { type: 'user', id: 'editor-1' });
    const first = stubFetcher(XMLTV_FULL);
    const firstService = new EpgIngestionService(harness.context.database, new EpgService(harness.context.database), first.fetcher);
    await firstService.runSource(SOURCE_ID, EGRESS, 'scheduled');

    const notModified = stubFetcher({ status: 304, ok: false, body: null, etag: '"v1"', lastModified: null });
    const second = new EpgIngestionService(harness.context.database, new EpgService(harness.context.database), notModified.fetcher);
    const before = await harness.context.database.collection<ProgrammeDoc>(COLLECTIONS.programmes).countDocuments();
    const result = await second.runSource(SOURCE_ID, EGRESS, 'incremental', { trigger: 'incremental' });

    expect(notModified.calls[0]?.etag).toBe('"v1"');
    expect(result).toMatchObject({ status: 'ok', programmes: 0 });
    expect(await harness.context.database.collection<ProgrammeDoc>(COLLECTIONS.programmes).countDocuments()).toBe(before);
    // The validator is kept: a guarded 304 must not erase what we have.
    const source = await harness.context.database.collection<EpgSourceDoc>(COLLECTIONS.epgSources).findOne({ _id: SOURCE_ID });
    expect(source?.httpEtag).toBe('"v1"');
    void ingestion;
  });

  it('is idempotent: re-ingesting the same guide writes no second emission', async () => {
    const { ingestion, mappings } = services(stubFetcher(XMLTV_FULL).fetcher);
    await mappings.create({ channelId: CHANNEL_A, epgSourceId: SOURCE_ID, externalId: 'La1.TV' }, { type: 'user', id: 'editor-1' });
    await ingestion.runSource(SOURCE_ID, EGRESS, 'scheduled');
    const first = await harness.context.database.collection<ProgrammeDoc>(COLLECTIONS.programmes).countDocuments();
    await ingestion.runSource(SOURCE_ID, EGRESS, 'scheduled');
    const second = await harness.context.database.collection<ProgrammeDoc>(COLLECTIONS.programmes).countDocuments();
    expect(second).toBe(first);
  });

  it('ingests the json-tdtchannels shape with absolute epoch seconds', async () => {
    await harness.context.database.collection<EpgSourceDoc>(COLLECTIONS.epgSources).updateOne(
      { _id: SOURCE_ID },
      { $set: { kind: 'json-tdtchannels' } },
    );
    const payload = JSON.stringify({
      0: {
        name: 'La1.TV',
        events: [
          { hi: 1774746000, hf: 1774749600, t: 'Telediario', d: '', g: 'NEWS' },
        ],
      },
    });
    const { ingestion, mappings } = services(stubFetcher({ status: 200, ok: true, body: payload, etag: null, lastModified: null }).fetcher);
    await mappings.create({ channelId: CHANNEL_A, epgSourceId: SOURCE_ID, externalId: 'La1.TV' }, { type: 'user', id: 'editor-1' });
    const result = await ingestion.runSource(SOURCE_ID, EGRESS, 'scheduled');
    expect(result.status).toBe('ok');
    const doc = await harness.context.database.collection<ProgrammeDoc>(COLLECTIONS.programmes).findOne({ channelId: CHANNEL_A });
    expect(doc?.start.toISOString()).toBe('2026-03-29T01:00:00.000Z');
    expect(doc?.timezone).toBe('UTC');
  });

  it('proposes — never confirms — a mapping it discovered through the legacy alias', async () => {
    await harness.context.database.collection<ChannelDoc>(COLLECTIONS.channels).updateOne(
      { _id: CHANNEL_A },
      { $set: { aliases: [{ namespace: 'epg', value: 'La1.TV' }] } },
    );
    const { ingestion, mappings } = services(stubFetcher(XMLTV_FULL).fetcher);
    const result = await ingestion.runSource(SOURCE_ID, EGRESS, 'scheduled');
    expect(result.channelsMatched).toBe(1);
    const rows = await mappings.listForChannel(CHANNEL_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('proposed');
    expect(rows[0]?.externalId).toBe('La1.TV');
  });

  it('never resolves a rejected pair again and keeps the tombstone', async () => {
    const { ingestion, mappings } = services(stubFetcher(XMLTV_FULL).fetcher);
    const row = await mappings.create(
      { channelId: CHANNEL_A, epgSourceId: SOURCE_ID, externalId: 'La1.TV' },
      { type: 'user', id: 'editor-1' },
    );
    await mappings.decide(row._id, 'rejected', { type: 'user', id: 'editor-1' }, 'No es el mismo canal.');
    const result = await ingestion.runSource(SOURCE_ID, EGRESS, 'scheduled');
    expect(result.channelsMatched).toBe(0);
    expect(await harness.context.database.collection<ProgrammeDoc>(COLLECTIONS.programmes).countDocuments()).toBe(0);
    const row2 = await harness.context.database.collection<EpgMappingDoc>(COLLECTIONS.epgMappings).findOne({ _id: row._id });
    expect(row2?.status).toBe('rejected');
    // The rejection withdraws the attachment but never deletes the channel.
    const channel = await harness.context.database.collection<ChannelDoc>(COLLECTIONS.channels).findOne({ _id: CHANNEL_A });
    expect(channel).not.toBeNull();
    expect(channel?.epg?.sourceId).toBeNull();
  });

  it('records a failure, moves the retry counter and does not invent a programme', async () => {
    const failing: GuideFetcher = async () => {
      throw new Error('connect ECONNREFUSED https://guide.example.org/xmltv.xml');
    };
    const { ingestion } = services(failing);
    const result = await ingestion.runSource(SOURCE_ID, EGRESS, 'scheduled');
    expect(result.status).toBe('failed');
    expect(result.message).not.toContain('https://');
    expect(await harness.context.database.collection<ProgrammeDoc>(COLLECTIONS.programmes).countDocuments()).toBe(0);

    const source = await harness.context.database.collection<EpgSourceDoc>(COLLECTIONS.epgSources).findOne({ _id: SOURCE_ID });
    expect(source?.consecutiveFailures).toBe(1);
    expect(source?.lastRunStatus).toBe('failed');
    expect(source?.nextRunAt?.getTime()).toBe(
      new Date((source?.lastRunAt?.getTime() ?? 0) + retryDelayMs(1, 60)).getTime(),
    );
    const failed = await services().runs.failures();
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).not.toContain('https://');
  });

  it('refuses a source whose ingestion is disabled', async () => {
    await harness.context.database.collection<EpgSourceDoc>(COLLECTIONS.epgSources).updateOne(
      { _id: SOURCE_ID },
      { $set: { ingestionEnabled: false } },
    );
    const { ingestion } = services(stubFetcher(XMLTV_FULL).fetcher);
    const result = await ingestion.runSource(SOURCE_ID, EGRESS, 'scheduled');
    expect(result.status).toBe('failed');
    expect(result.message).toContain('deshabilitada');
  });
});

describe('scheduled rounds', () => {
  it('skips a source past the retry cap unless forced', async () => {
    await harness.context.database.collection<EpgSourceDoc>(COLLECTIONS.epgSources).updateOne(
      { _id: SOURCE_ID },
      { $set: { consecutiveFailures: MAX_ATTEMPTS, lastRunAt: new Date('2026-03-28T00:00:00Z'), nextRunAt: new Date('2026-03-28T00:00:00Z') } },
    );
    const stub = stubFetcher(XMLTV_FULL);
    const { ingestion } = services(stub.fetcher);
    const scheduled = await ingestion.runAll(EGRESS);
    expect(scheduled).toHaveLength(0);
    expect(stub.calls).toHaveLength(0);
    const forced = await ingestion.runAll(EGRESS, { force: true });
    expect(forced).toHaveLength(1);
  });
});

describe('duplicate detection', () => {
  it('marks duplicateOf on the overlapping emission and keeps both rows', async () => {
    const { epg } = services();
    const outcome = await epg.upsertChannelGuide(CHANNEL_A, SOURCE_ID, [
      { title: 'Telediario', description: '', genre: null, coverUrl: null, start: new Date('2026-11-14T20:00:00Z'), end: new Date('2026-11-14T21:00:00Z'), externalKey: 'a' },
      { title: 'TELEDIARIO', description: '', genre: null, coverUrl: null, start: new Date('2026-11-14T20:05:00Z'), end: new Date('2026-11-14T21:05:00Z'), externalKey: 'b' },
      { title: 'Documental', description: '', genre: null, coverUrl: null, start: new Date('2026-11-14T21:00:00Z'), end: new Date('2026-11-14T22:00:00Z'), externalKey: 'c' },
    ]);
    expect(outcome.duplicates).toBe(1);
    const docs = await harness.context.database
      .collection<ProgrammeDoc>(COLLECTIONS.programmes)
      .find({ channelId: CHANNEL_A })
      .sort({ start: 1 })
      .toArray();
    // Three rows survive: dedup marks, it never deletes.
    expect(docs).toHaveLength(3);
    expect(docs[0]?.duplicateOf).toBeNull();
    expect(docs[1]?.duplicateOf).toBe(docs[0]?._id);

    const duplicates = await epg.duplicatesOf(CHANNEL_A);
    expect(duplicates).toEqual([{ id: docs[1]?._id, duplicateOf: docs[0]?._id }]);
  });

  it('does not serve a duplicate in the public schedule', async () => {
    const { epg } = services();
    await epg.upsertChannelGuide(CHANNEL_A, SOURCE_ID, [
      { title: 'Cine', description: '', genre: null, coverUrl: null, start: new Date('2026-11-14T20:00:00Z'), end: new Date('2026-11-14T22:00:00Z'), externalKey: 'a' },
      { title: 'Cine', description: '', genre: null, coverUrl: null, start: new Date('2026-11-14T20:30:00Z'), end: new Date('2026-11-14T22:30:00Z'), externalKey: 'b' },
    ]);
    const channel = await harness.context.database.collection<ChannelDoc>(COLLECTIONS.channels).findOne({ _id: CHANNEL_A });
    await harness.context.database.collection<ChannelDoc>(COLLECTIONS.channels).updateOne(
      { _id: CHANNEL_A },
      { $set: { epg: { sourceId: SOURCE_ID, externalId: 'La1.TV' } } },
    );
    const updated = await harness.context.database.collection<ChannelDoc>(COLLECTIONS.channels).findOne({ _id: CHANNEL_A });
    const schedule = await epg.scheduleFor(updated ?? channel!, new Date('2026-11-14T20:00:00Z'), 6);
    expect(schedule.data.programmes).toHaveLength(1);
    expect(schedule.data.availability).toBe('available');
  });
});

describe('coverage', () => {
  it('classifies fresh, stale, empty and not-mapped without inventing data', async () => {
    const { epg } = services();
    const now = new Date('2026-11-14T21:00:00Z');
    // Channel A: programmes that end after `now` and were just refreshed → fresh.
    await harness.context.database.collection<ChannelDoc>(COLLECTIONS.channels).updateOne(
      { _id: CHANNEL_A },
      { $set: { epg: { sourceId: SOURCE_ID, externalId: 'La1.TV' } } },
    );
    await harness.context.database.collection<ProgrammeDoc>(COLLECTIONS.programmes).insertOne({
      _id: 'p-fresh',
      channelId: CHANNEL_A,
      sourceId: SOURCE_ID,
      title: 'Ahora',
      description: '',
      genre: null,
      coverUrl: null,
      start: new Date('2026-11-14T20:00:00Z'),
      end: new Date('2026-11-14T22:00:00Z'),
      externalKey: 'fresh',
      editedAt: null,
      createdAt: now,
      updatedAt: now,
      duplicateOf: null,
      stale: false,
    });
    // Channel B: mapped, but only an emission that already ended a week ago.
    await harness.context.database.collection<ChannelDoc>(COLLECTIONS.channels).updateOne(
      { _id: CHANNEL_B },
      { $set: { epg: { sourceId: SOURCE_ID, externalId: 'La2.TV' } } },
    );
    await harness.context.database.collection<ProgrammeDoc>(COLLECTIONS.programmes).insertOne({
      _id: 'p-old',
      channelId: CHANNEL_B,
      sourceId: SOURCE_ID,
      title: 'Hace una semana',
      description: '',
      genre: null,
      coverUrl: null,
      start: new Date('2026-11-07T20:00:00Z'),
      end: new Date('2026-11-07T21:00:00Z'),
      externalKey: 'old',
      editedAt: null,
      createdAt: now,
      updatedAt: now,
      duplicateOf: null,
      stale: true,
    });

    const coverage = await epg.coverage({ now });
    const byId = new Map(coverage.entries.map((entry) => [entry.channelId, entry]));
    expect(byId.get(CHANNEL_A)?.status).toBe('fresh');
    expect(byId.get(CHANNEL_A)?.availability).toBe('available');
    expect(byId.get(CHANNEL_B)?.status).toBe('empty');
    expect(coverage.totals.channels).toBe(2);
    expect(coverage.totals.fresh).toBe(1);

    // Nothing mapped: the answer is `not-mapped`, not a fabricated schedule.
    await harness.context.database.collection<ChannelDoc>(COLLECTIONS.channels).updateMany(
      {},
      { $set: { epg: { sourceId: null, externalId: null } } },
    );
    const unmapped = await epg.coverage({ now });
    expect(unmapped.totals.notMapped).toBe(2);
    expect(unmapped.entries.every((entry) => entry.status === 'not-mapped')).toBe(true);
    expect(unmapped.entries.every((entry) => entry.availability === 'not-mapped')).toBe(true);
  });
});

describe('canonical mappings and audit', () => {
  it('audits create, confirm and reject with the actor', async () => {
    const { mappings } = services();
    const actor = { type: 'user' as const, id: 'editor-7' };
    const row = await mappings.create(
      { channelId: CHANNEL_A, epgSourceId: SOURCE_ID, externalId: 'La1.TV' },
      actor,
      'Alta manual',
    );
    expect(row.status).toBe('confirmed');
    await mappings.decide(row._id, 'rejected', actor, 'Duplicado');
    await mappings.decide(row._id, 'confirmed', actor, 'Se confirma tras revisar');

    const audits = await harness.context.database
      .collection<AuditDoc>(COLLECTIONS.audits)
      .find({ entityType: 'epg_mapping' })
      .sort({ at: 1 })
      .toArray();
    const actions = audits.map((entry) => entry.action);
    expect(actions).toContain('epg.mapping.create');
    expect(actions).toContain('epg.mapping.reject');
    expect(actions).toContain('epg.mapping.confirm');
    expect(audits.every((entry) => entry.actor.id === 'editor-7')).toBe(true);

    // Confirming attaches the legacy alias as well, for compatibility.
    const channel = await harness.context.database.collection<ChannelDoc>(COLLECTIONS.channels).findOne({ _id: CHANNEL_A });
    expect(channel?.epg).toEqual({ sourceId: SOURCE_ID, externalId: 'La1.TV' });
    expect(channel?.aliases.some((alias) => alias.namespace === 'epg' && alias.value === 'La1.TV')).toBe(true);
  });

  it('flags a conflict when two confirmed rows claim one upstream id', async () => {
    const { mappings } = services();
    const actor = { type: 'user' as const, id: 'editor-7' };
    await mappings.create({ channelId: CHANNEL_A, epgSourceId: SOURCE_ID, externalId: 'Share.TV' }, actor);
    await mappings.create({ channelId: CHANNEL_B, epgSourceId: SOURCE_ID, externalId: 'Share.TV' }, actor);
    const resolved = await mappings.listResolved({ status: 'confirmed' });
    expect(resolved).toHaveLength(2);
    expect(resolved.every((row) => row.conflict)).toBe(true);
    expect(resolved[0]?.channelSlug).toBe('la-1');
  });

  it('refuses to map a channel that does not exist', async () => {
    const { mappings } = services();
    await expect(
      mappings.create({ channelId: '00000000-0000-4000-8000-0000000000ff', epgSourceId: SOURCE_ID, externalId: 'X' }, {
        type: 'user',
        id: 'editor-7',
      }),
    ).rejects.toThrow(/Canal no encontrado/);
  });
});

describe('migration 009', () => {
  it('creates its indexes, is idempotent and its down really reverts', async () => {
    const db = harness.context.database.db;
    await db.collection(COLLECTIONS.migrationLedger).deleteMany({});
    await migrate(harness.context.database);

    const programmeIndexes = await db.collection(COLLECTIONS.programmes).indexes();
    for (const index of EPG_PROGRAMME_INDEXES) {
      expect(programmeIndexes.some((entry) => entry.name === index.name)).toBe(true);
    }
    const sourceIndexes = await db.collection(COLLECTIONS.epgSources).indexes();
    for (const index of EPG_SOURCE_INDEXES) {
      expect(sourceIndexes.some((entry) => entry.name === index.name)).toBe(true);
    }
    const runIndexes = await db.collection(COLLECTIONS.epgSyncRuns).indexes();
    for (const index of EPG_SYNC_RUN_INDEXES) {
      expect(runIndexes.some((entry) => entry.name === index.name)).toBe(true);
    }

    // Idempotent: a second migrate applies nothing new.
    const again = await migrate(harness.context.database);
    expect(again.applied).toHaveLength(0);
    expect(again.already).toContain('009-epg-international');

    const status = await migrationStatus(harness.context.database);
    expect(status.pending).not.toContain('009-epg-international');

    // Down: indexes and collection go, documents and their other fields stay.
    await rollbackMigration(harness.context.database, '009-epg-international');
    const afterProgramme = await db.collection(COLLECTIONS.programmes).indexes();
    for (const index of EPG_PROGRAMME_INDEXES) {
      expect(afterProgramme.some((entry) => entry.name === index.name)).toBe(false);
    }
    const afterSource = await db.collection(COLLECTIONS.epgSources).indexes();
    expect(afterSource.some((entry) => entry.name === 'next_run_queue')).toBe(false);
    expect(await db.listCollections({ name: COLLECTIONS.epgSyncRuns }).toArray()).toHaveLength(0);
    const source = await db.collection<EpgSourceDoc>(COLLECTIONS.epgSources).findOne({ _id: SOURCE_ID });
    expect(source).not.toBeNull();
    expect(source?.timezone).toBeUndefined();
    expect(source?.nextRunAt).toBeUndefined();
    // Fields the subsystem did not introduce survive the rollback.
    expect(source?.name).toBe('Guía XMLTV de prueba');
    expect(await db.collection(COLLECTIONS.channels).countDocuments()).toBe(2);
    // The rolled-back migration is recorded, so a later migrate applies it again.
    const after = await migrationStatus(harness.context.database);
    expect(after.pending).toContain('009-epg-international');
  });
});
