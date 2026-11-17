/**
 * CLI: import the iptv-org catalogue into our database.
 *
 *   node dist/scripts/import-iptv-org.js --snapshot <dir> --channels <csv> [--dry-run] [--limit N]
 *
 * `--dry-run` computes every number the import would act on and writes nothing;
 * run it first. The report is printed as one JSON object so it can be recorded
 * as evidence verbatim.
 */
import { resolve } from 'node:path';
import { loadConfig } from '../config/config.js';
import { connectDatabase } from '../infrastructure/mongo.js';
import { initCliEnvironment, reportFailure } from './cli-env.js';
import { importIptvOrg } from '../ingestion/iptv-org.import.js';

interface Args {
  snapshot: string;
  channels: string;
  dryRun: boolean;
  limit?: number;
}

function parseArgs(argv: readonly string[]): Args {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) continue;
    if (flag === '--dry-run') {
      flags.add('dry-run');
      continue;
    }
    values[flag] = argv[index + 1] ?? '';
    index += 1;
  }
  const snapshot = values['--snapshot'];
  const channels = values['--channels'];
  if (!snapshot || !channels) {
    throw new Error('Uso: --snapshot <dir> --channels <channels.csv> [--dry-run] [--limit N]');
  }
  const limitRaw = values['--limit'];
  return {
    snapshot: resolve(snapshot),
    channels: resolve(channels),
    dryRun: flags.has('dry-run'),
    ...(limitRaw === undefined || limitRaw === '' ? {} : { limit: Number(limitRaw) }),
  };
}

async function main(): Promise<void> {
  initCliEnvironment();
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const database = await connectDatabase(config.MONGODB_URI, config.MONGODB_DB);
  try {
    const result = await importIptvOrg(database, {
      snapshotRoot: args.snapshot,
      channelsCsv: args.channels,
      dryRun: args.dryRun,
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    });
    console.log(JSON.stringify({ command: 'import:iptv-org', targetDatabase: config.MONGODB_DB, ...result }, null, 2));
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  reportFailure('import:iptv-org', error);
  process.exit(1);
});
