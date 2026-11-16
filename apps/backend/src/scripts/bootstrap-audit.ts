/**
 * `bootstrap:verify` — proves the platform starts from nothing.
 *
 * It creates a **fresh, empty database**, runs the documented bootstrap path
 * (migrations → catalogue import → guide import), starts the real API against it
 * and asserts that the catalogue, the guide, a playback descriptor and the
 * integration contract answer from persisted data. Then it drops the database.
 *
 *   node dist/scripts/bootstrap-audit.js --snapshot <tv.json> [--guide <TV.json>] [--keep]
 *
 * Exit code 0 only when every check passed; any failure is printed with the
 * check that failed.
 */
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MongoClient } from 'mongodb';
import { initCliEnvironment, reportFailure } from './cli-env.js';
import { loadConfig } from '../config/config.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import { connectDatabase } from '../infrastructure/mongo.js';
import type { ChannelDoc, EpgSourceDoc } from '../infrastructure/schema.js';
import { migrate } from '../migrations/runner.js';
import { extractReferenceChannels, planChannel } from '../jobs/catalogue-import.js';
import { MigrationExecutor } from '../jobs/migration-executor.js';
import { EpgIngestionService } from '../modules/epg/epg.ingestion.js';
import { EpgService } from '../modules/epg/epg.service.js';
import { createApp } from '../server/app.js';
import { createContext } from '../server/bootstrap.js';

interface Args {
  snapshot: string | null;
  guide: string | null;
  keep: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const argOf = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? resolve(argv[index + 1] as string) : null;
  };
  return { snapshot: argOf('--snapshot'), guide: argOf('--guide'), keep: argv.includes('--keep') };
}

interface JsonBody {
  readonly data?: any;
  readonly pagination?: { readonly total?: number };
}

/** Small helper: fetch a JSON document from the API under audit. */
async function getJson(url: string): Promise<JsonBody> {
  const response = await fetch(url);
  return (await response.json()) as JsonBody;
}

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

async function main(): Promise<void> {
  initCliEnvironment();
  const args = parseArgs(process.argv.slice(2));
  const baseConfig = loadConfig();
  const databaseName = `tdt_bootstrap_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const config = { ...baseConfig, MONGODB_DB: databaseName };
  const checks: Check[] = [];
  const record = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  // 1. Empty database, created on purpose.
  const admin = new MongoClient(config.MONGODB_URI);
  await admin.connect();
  await admin.db(databaseName).dropDatabase();
  const emptyCounts = await Promise.all(
    ['channels', 'playback_sources', 'programmes', 'epg_sources'].map(async (name) => ({
      name,
      count: await admin.db(databaseName).collection(name).countDocuments({}),
    })),
  );
  record(
    'database starts empty',
    emptyCounts.every((entry) => entry.count === 0),
    JSON.stringify(emptyCounts),
  );
  await admin.close();

  const database = await connectDatabase(config.MONGODB_URI, config.MONGODB_DB);
  const context = await createContext(config);
  const server = createApp(config, context).app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const base = `http://127.0.0.1:${port}/api/v1`;

  try {
    // 2. Migrations.
    const migration = await migrate(database);
    record(
      'migrations apply on an empty database',
      migration.applied.length > 0,
      `applied: ${migration.applied.join(', ')}`,
    );

    // 3. Catalogue import (only when a snapshot was supplied).
    if (args.snapshot) {
      if (!existsSync(args.snapshot)) throw new Error(`Snapshot not found: ${args.snapshot}`);
      const bytes = await readFile(args.snapshot);
      const digest = createHash('sha256').update(bytes).digest('hex');
      const extracted = extractReferenceChannels(JSON.parse(bytes.toString('utf8')) as unknown);
      const plans = extracted.records.map(planChannel);
      const ledger = await new MigrationExecutor({
        database,
        digestSha256: digest,
        bytes: bytes.byteLength,
        snapshotUpdated: null,
        runLabel: 'bootstrap',
        legalNote: 'Bootstrap audit.',
      }).execute(plans);
      record(
        'catalogue imported with provenance',
        ledger.channelsWritten > 0 && ledger.snapshotDigestSha256 === digest,
        `${ledger.channelsWritten} channels, ${ledger.sourcesWritten} published sources, digest ${digest.slice(0, 12)}…`,
      );
      record(
        'every excluded source is documented',
        ledger.exclusions.every((exclusion) => exclusion.reason.length > 0),
        `${ledger.exclusions.length} exclusions recorded`,
      );
    }

    // 4. Guide import (only when a guide was supplied).
    if (args.guide) {
      if (!existsSync(args.guide)) throw new Error(`Guide not found: ${args.guide}`);
      const guideBytes = await readFile(args.guide);
      const parsed = EpgIngestionService.parse(
        { kind: 'json-tdtchannels' },
        guideBytes.toString('utf8'),
        'Europe/Madrid',
      );
      const now = new Date();
      const sourceId = randomUUID();
      const source: EpgSourceDoc = {
        _id: sourceId,
        name: `Bootstrap guide ${sourceId.slice(0, 6)}`,
        kind: 'json-tdtchannels',
        url: null,
        licence: 'Apache-2.0',
        attribution: 'Datos de referencia: proyecto TDTChannels (Apache-2.0).',
        ingestionEnabled: false,
        status: 'published',
        lastRunAt: now,
        lastRunStatus: 'ok',
        lastRunProgrammes: 0,
        createdAt: now,
        updatedAt: now,
      };
      await database.collection<EpgSourceDoc>(COLLECTIONS.epgSources).insertOne(source);
      const epg = new EpgService(database);
      const reconciliation = await new EpgIngestionService(database, epg).reconcile(parsed.channels);
      const channels = await database
        .collection<ChannelDoc>(COLLECTIONS.channels)
        .find({ 'aliases.namespace': 'epg', 'aliases.value': { $in: reconciliation.matched } })
        .toArray();
      const byAlias = new Map<string, ChannelDoc>();
      for (const channel of channels) {
        for (const alias of channel.aliases) {
          if (alias.namespace === 'epg') byAlias.set(alias.value, channel);
        }
      }
      let written = 0;
      const perUpstream = new Map<string, typeof parsed.events>();
      for (const event of parsed.events) {
        const list = perUpstream.get(event.upstreamChannel) ?? [];
        list.push(event);
        perUpstream.set(event.upstreamChannel, list);
      }
      for (const [upstreamId, events] of perUpstream) {
        const channel = byAlias.get(upstreamId);
        if (!channel) continue;
        const result = await epg.upsertChannelGuide(
          channel._id,
          sourceId,
          events.map((event) => ({
            title: event.title,
            description: event.description,
            genre: event.genre,
            coverUrl: event.coverUrl,
            start: event.start,
            end: event.end,
            externalKey: `${sourceId}|${event.externalKey}`,
          })),
        );
        written += result.written;
        await database
          .collection<ChannelDoc>(COLLECTIONS.channels)
          .updateOne({ _id: channel._id }, { $set: { epg: { sourceId, externalId: upstreamId } } });
      }
      record(
        'guide imported and reconciled onto our channels',
        written > 0,
        `${written} programmes for ${reconciliation.matched.length} channels; ${reconciliation.unmapped.length} upstream ids unmapped`,
      );
    }

    // 5. The API answers from the persisted data.
    const health = await getJson(`${base}/health`);
    record(
      'health reports persisted counts',
      health.data.channels > 0,
      JSON.stringify(health.data),
    );

    const list = await getJson(`${base}/channels?pageSize=5`);
    record(
      'catalogue is served from the database',
      Array.isArray(list.data) && list.data.length > 0,
      `${list.pagination?.total ?? 0} published channels`,
    );

    const search = await getJson(`${base}/channels?q=a&pageSize=5`);
    record('search answers', Array.isArray(search.data), `${search.data?.length ?? 0} matches`);

    const categories = await getJson(`${base}/categories`);
    record('categories answer', Array.isArray(categories.data), `${categories.data?.length ?? 0} categories`);

    const firstPlayable = (list.data as Array<{ slug: string; playbackStatus: string }>).find(
      (channel) => channel.playbackStatus === 'available',
    );
    if (firstPlayable) {
      const descriptor = await getJson(`${base}/channels/${firstPlayable.slug}/playback`);
      record(
        'playback descriptor resolves an authorised source',
        descriptor.data?.playback?.status === 'available' && Boolean(descriptor.data?.playback?.url),
        `${firstPlayable.slug}: ${descriptor.data?.playback?.engine}`,
      );
    }

    if (args.guide) {
      const schedule = await getJson(`${base}/channels/la-1/schedule?from=2026-11-14T20:00:00Z&hours=6`);
      record(
        'guide is served from our store',
        schedule.data?.availability === 'available' && schedule.data.programmes.length > 0,
        `${schedule.data?.programmes?.length ?? 0} programmes`,
      );
      const feed = await getJson(`${base}/epg/now?from=2026-11-14T20:00:00Z&limit=50`);
      record(
        'now/next feed answers',
        Array.isArray(feed.data),
        `${feed.data?.length ?? 0} entries`,
      );
    }

    const identity = await getJson(`${base}/integration/guiatv/identity-map?pageSize=5`);
    record(
      'integration contract is available',
      Array.isArray(identity.data),
      `${identity.pagination?.total ?? 0} mappings`,
    );
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await context.cache.close();
    await context.database.close();
    if (!args.keep) {
      const cleanup = new MongoClient(config.MONGODB_URI);
      await cleanup.connect();
      await cleanup.db(databaseName).dropDatabase();
      await cleanup.close();
    }
  }

  const failures = checks.filter((check) => !check.ok);
  console.log(
    JSON.stringify(
      {
        command: 'bootstrap:verify',
        database: databaseName,
        kept: args.keep,
        checks,
        verdict: failures.length === 0 ? 'PASS' : 'FAIL',
        failures: failures.map((check) => check.name),
      },
      null,
      2,
    ),
  );
  if (failures.length > 0) process.exitCode = 1;
  // A completed audit must terminate: any handle still open (a pool, a timer from
  // the database driver) is no longer part of the result.
  setTimeout(() => process.exit(failures.length > 0 ? 1 : 0), 250).unref();
}

main().catch((error: unknown) => {
  reportFailure('bootstrap:verify', error);
  process.exit(1);
});
