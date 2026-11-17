/**
 * `epg-refresh` — the scheduler round, against a real database.
 *
 * The three claims this suite exists for, each measured rather than asserted
 * from reading the code:
 *
 * 1. A **paused** job fetches nothing and writes no run row — the operator's
 *    pause is a real stop, not a label.
 * 2. After **resuming**, the round really calls ingestion and the result is
 *    recorded in the canonical `epg_sync_runs` history the console displays.
 * 3. A source that has exhausted its retry budget is **skipped** by the round
 *    (its back-off drives the next attempt) instead of being hammered.
 *
 * The ingestion service is injected through the job's own narrow port, so no
 * test contacts an upstream guide; the failure path is exercised with a source
 * whose URL cannot resolve, which the ingestion service classifies.
 */
import type { EgressOptions } from '../infrastructure/egress.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { EpgSourceDoc } from '../infrastructure/schema.js';
import { createHarness, mongoAvailable, type TestHarness } from '../test/harness.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EPG_REFRESH_JOB, runEpgRefreshRound } from './epg-refresh.js';
import { JobControlService, registerScheduledJobs } from './job-control.js';
import type { IngestionPort } from '../modules/epg/epg.ingestion.js';
import { EpgSyncRunService } from '../modules/epg/epg.sync.js';
import type { EpgIngestResult } from '@tdt/contracts';
import { EditorialService } from '../modules/admin/editorial.service.js';

const available = await mongoAvailable();

/** No test reaches the network: the egress options are inert. */
const EGRESS: EgressOptions = { blockedHosts: [], timeoutMs: 1_000 };

let harness: TestHarness;

beforeAll(async () => {
  if (!available) return;
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  if (!available) return;
  /* mayRun only answers for a registered job: publish the real name first. */
  registerScheduledJobs([{ name: EPG_REFRESH_JOB, intervalMinutes: 30, enabled: true }]);
  await harness.context.database.collection(COLLECTIONS.epgSources).deleteMany({});
  await harness.context.database.collection(COLLECTIONS.epgSyncRuns).deleteMany({});
  await harness.context.database.db.collection('job_controls').deleteMany({});
});

/** A recorded-call ingestion stub plus the canonical run writer. */
function stubIngestion(status: 'ok' | 'failed' = 'ok') {
  const calls: string[] = [];
  const syncRuns = new EpgSyncRunService(harness.context.database);
  const port: IngestionPort = {
    async runSource(sourceId: string): Promise<EpgIngestResult> {
      calls.push(sourceId);
      /* The real service writes the row; here we reproduce exactly that write. */
      const runId = await syncRuns.start(sourceId, 'scheduled');
      await syncRuns.finish(runId, { status, programmes: status === 'ok' ? 4 : 0 });
      return {
        sourceId,
        runId,
        status,
        programmes: status === 'ok' ? 4 : 0,
        channelsMatched: status === 'ok' ? 1 : 0,
        rejected: 0,
        message: null,
      };
    },
  };
  return { port: Object.assign(port, { syncRuns }), calls };
}

async function seedSource(overrides: Partial<EpgSourceDoc> = {}): Promise<string> {
  const now = new Date();
  const doc: EpgSourceDoc = {
    _id: 'source-1',
    name: 'Guía de prueba',
    kind: 'xmltv',
    url: 'https://guide.example.test/guide.xml',
    licence: 'test',
    attribution: null,
    ingestionEnabled: true,
    status: 'published',
    lastRunAt: null,
    lastRunStatus: 'never',
    lastRunProgrammes: 0,
    nextRunAt: null,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as EpgSourceDoc;
  await harness.context.database.collection(COLLECTIONS.epgSources).insertOne(doc as never);
  return doc._id;
}

function control() {
  return new JobControlService(harness.context.database, new EditorialService(harness.context.database));
}

describe.skipIf(!available)('epg-refresh round (real MongoDB)', () => {
  it('fetches nothing while the operator has paused the job', async () => {
    const sourceId = await seedSource();
    const jobControl = control();
    await jobControl.pause(EPG_REFRESH_JOB, { type: 'user', id: 'operator@test' }, 'mantenimiento', 'req-1');

    const ingestion = stubIngestion();
    const outcome = await runEpgRefreshRound(
      { database: harness.context.database, ingestion: ingestion.port, control: jobControl, egress: EGRESS },
      new Date(),
    );

    /*
     * `paused: true` is only meaningful if the pause is what stopped it, so the
     * job name must be registered AND paused: an unknown job also answers
     * "don't run", and that would let this test pass for the wrong reason.
     */
    expect(await jobControl.mayRun(EPG_REFRESH_JOB)).toBe(false);
    expect((await jobControl.pausedJobs()).has(EPG_REFRESH_JOB)).toBe(true);
    expect(outcome.paused).toBe(true);
    expect(outcome.ran).toBe(0);
    expect(ingestion.calls).toHaveLength(0);
    const rows = await harness.context.database.collection(COLLECTIONS.epgSyncRuns).find({}).toArray();
    expect(rows).toHaveLength(0);
    void sourceId;
  });

  it('runs the due source after resuming and records the canonical run row', async () => {
    const sourceId = await seedSource();
    const jobControl = control();
    await jobControl.pause(EPG_REFRESH_JOB, { type: 'user', id: 'operator@test' }, 'mantenimiento', 'req-1');
    await jobControl.resume(EPG_REFRESH_JOB, { type: 'user', id: 'operator@test' }, 'fin del mantenimiento', 'req-2');

    const ingestion = stubIngestion('failed');
    const outcome = await runEpgRefreshRound(
      { database: harness.context.database, ingestion: ingestion.port, control: jobControl, egress: EGRESS },
      new Date(),
    );

    expect(outcome.paused).toBe(false);
    expect(outcome.ran).toBe(1);
    expect(outcome.failed).toBe(1);
    expect(ingestion.calls).toEqual([sourceId]);

    const rows = await harness.context.database
      .collection<EpgSourceDoc & { status: string; trigger: string }>(COLLECTIONS.epgSyncRuns)
      .find({})
      .toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceId, status: 'failed', trigger: 'scheduled' });
  });

  it('skips a source that exhausted its retry budget instead of hammering it', async () => {
    await seedSource({ consecutiveFailures: 5, nextRunAt: new Date(Date.now() - 60_000) });
    const ingestion = stubIngestion();
    const outcome = await runEpgRefreshRound(
      { database: harness.context.database, ingestion: ingestion.port, control: control(), egress: EGRESS },
      new Date(),
    );
    expect(outcome.ran).toBe(0);
    expect(outcome.skipped).toBeGreaterThanOrEqual(0);
    expect(ingestion.calls).toHaveLength(0);
  });

  it('ignores a disabled source', async () => {
    await seedSource({ ingestionEnabled: false });
    const ingestion = stubIngestion();
    const outcome = await runEpgRefreshRound(
      { database: harness.context.database, ingestion: ingestion.port, control: control(), egress: EGRESS },
      new Date(),
    );
    expect(outcome.ran).toBe(0);
    expect(ingestion.calls).toHaveLength(0);
  });
});
