/**
 * CLI: record one bulk authorization for every source of a provider.
 *
 *   node dist/scripts/authorize-provider.js --provider iptv-org [--dry-run]
 *
 * This is the operator decision "these catalogue sources may be offered", applied
 * to a whole upstream at once. It does not manufacture a licence: the record's
 * basis stays `none` and its `clauseUrl` points at the upstream's own public
 * licence, so the gate can be re-audited later without guessing.
 */
import { loadConfig } from '../config/config.js';
import { connectDatabase } from '../infrastructure/mongo.js';
import { initCliEnvironment, reportFailure } from './cli-env.js';
import { authorizeProviderSources } from '../modules/providers/bulk-authorization.js';

interface Args {
  provider: string;
  dryRun: boolean;
  actor: string;
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
  const provider = values['--provider'];
  if (!provider) throw new Error('Uso: --provider <nombre> [--dry-run] [--actor <id>]');
  return { provider, dryRun: flags.has('dry-run'), actor: values['--actor'] ?? 'operator' };
}

/** Licence that is actually relied upon, per upstream. */
const LICENCES: Record<string, { url: string; reason: string }> = {
  'iptv-org': {
    url: 'https://github.com/iptv-org/iptv/blob/master/LICENSE',
    reason:
      'Licencia de iptv-org/iptv verificada el 2026-11-16: dedicatoria al dominio público (Unlicense) en el fichero LICENSE y CC0 en el README. Cubre la copia y publicación del listado de canales y de sus URL; no es una autorización del emisor sobre la señal.',
  },
};

async function main(): Promise<void> {
  initCliEnvironment();
  const args = parseArgs(process.argv.slice(2));
  const licence = LICENCES[args.provider];
  if (licence === undefined) {
    throw new Error(`Sin licencia registrada para el proveedor ${args.provider}: añádela en LICENCES antes de autorizar.`);
  }
  const config = loadConfig();
  const database = await connectDatabase(config.MONGODB_URI, config.MONGODB_DB);
  try {
    const result = await authorizeProviderSources(database, {
      provider: args.provider,
      reason: licence.reason,
      licenceUrl: licence.url,
      actor: { id: args.actor },
      dryRun: args.dryRun,
    });
    console.log(JSON.stringify({ command: 'authorize-provider', targetDatabase: config.MONGODB_DB, ...result }, null, 2));
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  reportFailure('authorize-provider', error);
  process.exit(1);
});
