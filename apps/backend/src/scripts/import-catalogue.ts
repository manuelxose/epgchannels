/**
 * `import:catalogue`: migrates an operator-supplied reference snapshot into our
 * own canonical store.
 *
 * Usage:
 *   node dist/scripts/import-catalogue.js --file /abs/path/tv.json [--dry-run] [--report out.json]
 *
 * The file is read locally. Nothing is fetched. The snapshot digest is recorded
 * in the migration ledger and on every record's provenance.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { initCliEnvironment, reportFailure } from './cli-env.js';
import { loadConfig } from '../config/config.js';
import { connectDatabase } from '../infrastructure/mongo.js';
import { migrate } from '../migrations/runner.js';
import { extractReferenceChannels, planChannel, type ChannelImportPlan } from '../jobs/catalogue-import.js';
import { MigrationExecutor } from '../jobs/migration-executor.js';

interface Args {
  file: string;
  dryRun: boolean;
  report: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  let file = '';
  let dryRun = false;
  let report: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--file') {
      file = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--report') {
      report = argv[index + 1] ?? null;
      index += 1;
    }
  }
  if (!file) {
    throw new Error('Missing --file <path>.');
  }
  return { file: resolve(file), dryRun, report: report ? resolve(report) : null };
}

function summarise(plans: readonly ChannelImportPlan[]) {
  const byPermission = new Map<string, number>();
  const byType = new Map<string, number>();
  const withheld = new Map<string, number>();
  const emitters = new Map<string, number>();
  for (const plan of plans) {
    for (const source of plan.sources) {
      byType.set(source.type, (byType.get(source.type) ?? 0) + 1);
      emitters.set(source.emitter.host || 'unknown', (emitters.get(source.emitter.host || 'unknown') ?? 0) + 1);
      if (source.withheldReason) {
        withheld.set(source.withheldReason, (withheld.get(source.withheldReason) ?? 0) + 1);
      } else {
        byPermission.set(source.permission, (byPermission.get(source.permission) ?? 0) + 1);
      }
    }
  }
  const sorted = (map: Map<string, number>): Record<string, number> =>
    Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
  return {
    channels: plans.length,
    channelsWithPublishedSource: plans.filter((plan) => plan.hasPublishedSource).length,
    sourcesByType: sorted(byType),
    publishedByPermission: sorted(byPermission),
    withheldByReason: sorted(withheld),
    topEmitters: Object.fromEntries(Object.entries(sorted(emitters)).slice(0, 25)),
  };
}

async function main(): Promise<void> {
  initCliEnvironment();
  const args = parseArgs(process.argv.slice(2));
  const bytes = await readFile(args.file);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const snapshot: unknown = JSON.parse(bytes.toString('utf8'));
  const extracted = extractReferenceChannels(snapshot);
  const plans = extracted.records.map(planChannel);
  const summary = summarise(plans);
  const updated =
    typeof (snapshot as { updated?: unknown }).updated === 'number'
      ? ((snapshot as { updated: number }).updated as number)
      : null;

  const baseReport = {
    command: 'import:catalogue',
    file: args.file,
    digestSha256: digest,
    bytes: bytes.byteLength,
    snapshotUpdated: updated,
    recordsRejected: extracted.rejected,
    ...summary,
  };

  console.log(JSON.stringify({ ...baseReport, dryRun: args.dryRun }, null, 2));

  if (args.dryRun) {
    if (args.report) {
      await writeFile(args.report, JSON.stringify({ ...baseReport, plans: summarise(plans) }, null, 2), 'utf8');
    }
    return;
  }

  const config = loadConfig();
  const database = await connectDatabase(config.MONGODB_URI, config.MONGODB_DB);
  try {
    await migrate(database);
    const executor = new MigrationExecutor({
      database,
      digestSha256: digest,
      bytes: bytes.byteLength,
      snapshotUpdated: updated,
      runLabel: 'catalogue-import',
      legalNote:
        'Los metadatos se reutilizan conforme a la licencia Apache-2.0 del catálogo de referencia y se acreditan. ' +
        'Las descripciones editoriales y la taxonomía son propias. Las señales pertenecen a sus emisores.',
    });
    const ledger = await executor.execute(plans);
    const report = {
      ...baseReport,
      stored: {
        runId: ledger._id,
        stats: ledger.stats,
        exclusions: ledger.exclusions.length,
        slugCollisions: ledger.publishedSlugCollisions.length,
      },
    };
    if (args.report) {
      await writeFile(
        args.report,
        JSON.stringify({ ...report, exclusionDetails: ledger.exclusions, slugCollisions: ledger.publishedSlugCollisions }, null, 2),
        'utf8',
      );
      console.log(JSON.stringify({ reportWritten: args.report }));
    }
    console.log(JSON.stringify(report.stored, null, 2));
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  reportFailure('import:catalogue', error);
  process.exit(1);
});
