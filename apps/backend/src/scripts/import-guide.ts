/**
 * `import:guide`: ingests a **local** guide file into our own store.
 *
 * The operator supplies the file. This tool is the same normaliser the scheduled
 * job uses, so a file imported today and a feed refreshed tomorrow produce the
 * same records. Every source stores its own provenance, licence and attribution
 * per event key, so two guides can never silently overwrite each other.
 *
 *   node dist/scripts/import-guide.js --file <path> [--source-name <name>]
 *        [--kind json-tdtchannels|xmltv] [--licence <id>] [--attribution <text>]
 *        [--url <public-url>] [--enable-ingestion true|false] [--dry-run]
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../config/config.js';
import { initCliEnvironment, reportFailure } from './cli-env.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import { connectDatabase } from '../infrastructure/mongo.js';
import type { ChannelDoc, EpgSourceDoc } from '../infrastructure/schema.js';
import { migrate } from '../migrations/runner.js';
import { EpgIngestionService } from '../modules/epg/epg.ingestion.js';
import { EpgService } from '../modules/epg/epg.service.js';

interface Args {
  file: string;
  sourceName: string;
  kind: 'json-tdtchannels' | 'xmltv';
  licence: string;
  attribution: string | null;
  url: string | null;
  enableIngestion: boolean;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    file: '',
    sourceName: 'Guía de referencia (instantánea)',
    kind: 'json-tdtchannels',
    licence: 'Apache-2.0',
    attribution: null,
    url: null,
    enableIngestion: false,
    dryRun: false,
  };
  const flagsWithValue: Readonly<Record<string, keyof Args>> = {
    '--file': 'file',
    '--source-name': 'sourceName',
    '--licence': 'licence',
    '--attribution': 'attribution',
    '--url': 'url',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (flag === '--kind') {
      args.kind = value === 'xmltv' ? 'xmltv' : 'json-tdtchannels';
      index += 1;
      continue;
    }
    if (flag === '--enable-ingestion') {
      args.enableIngestion = value === 'true';
      index += 1;
      continue;
    }
    const key = flag === undefined ? undefined : flagsWithValue[flag];
    if (key !== undefined && value !== undefined) {
      (args as unknown as Record<string, unknown>)[key] = value;
      index += 1;
    }
  }
  if (!args.file) throw new Error('Missing --file <path>.');
  return { ...args, file: resolve(args.file) };
}

async function main(): Promise<void> {
  initCliEnvironment();
  const args = parseArgs(process.argv.slice(2));
  const bytes = await readFile(args.file);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const parsed = EpgIngestionService.parse({ kind: args.kind }, bytes.toString('utf8'), 'Europe/Madrid');

  console.log(
    JSON.stringify(
      {
        command: 'import:guide',
        file: args.file,
        kind: args.kind,
        digestSha256: digest,
        bytes: bytes.byteLength,
        events: parsed.events.length,
        rejected: parsed.rejected,
        upstreamChannels: parsed.channels.length,
        dryRun: args.dryRun,
      },
      null,
      2,
    ),
  );
  if (args.dryRun) return;

  const config = loadConfig();
  const database = await connectDatabase(config.MONGODB_URI, config.MONGODB_DB);
  try {
    await migrate(database);
    const epgSources = database.collection<EpgSourceDoc>(COLLECTIONS.epgSources);
    const now = new Date();
    const existing = await epgSources.findOne({ name: args.sourceName });
    const sourceId = existing?._id ?? randomUUID();
    const sourceDoc: EpgSourceDoc = {
      _id: sourceId,
      name: args.sourceName,
      kind: args.kind,
      url: args.url,
      licence: args.licence,
      attribution: args.attribution,
      ingestionEnabled: args.enableIngestion,
      status: 'published',
      lastRunAt: now,
      lastRunStatus: 'ok',
      lastRunProgrammes: 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await epgSources.replaceOne({ _id: sourceId }, sourceDoc, { upsert: true });

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

    const perUpstream = new Map<string, typeof parsed.events>();
    for (const event of parsed.events) {
      const list = perUpstream.get(event.upstreamChannel) ?? [];
      list.push(event);
      perUpstream.set(event.upstreamChannel, list);
    }
    let written = 0;
    let rejected = parsed.rejected;
    let channelsMatched = 0;
    for (const [upstreamId, events] of perUpstream) {
      const channel = byAlias.get(upstreamId);
      if (!channel) continue;
      channelsMatched += 1;
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
      rejected += result.rejected;
      await database
        .collection<ChannelDoc>(COLLECTIONS.channels)
        .updateOne({ _id: channel._id }, { $set: { epg: { sourceId, externalId: upstreamId } } });
    }
    const finished = new Date();
    await epgSources.updateOne(
      { _id: sourceId },
      { $set: { lastRunProgrammes: written, lastRunAt: finished, updatedAt: finished } },
    );
    console.log(
      JSON.stringify(
        {
          sourceId,
          provenanceDigest: digest,
          programmesWritten: written,
          rejected,
          channelsMatched,
          upstreamUnmapped: reconciliation.unmapped.length,
          upstreamUnmappedSample: reconciliation.unmapped.slice(0, 20),
        },
        null,
        2,
      ),
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  reportFailure('import:guide', error);
  process.exit(1);
});
