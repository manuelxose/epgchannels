/**
 * CLI: record the product owner's decision that a whole upstream catalogue is
 * offered to the public.
 *
 *   node dist/scripts/open-catalogue.js --provider iptv-org --owner "Manuel" [--dry-run]
 *
 * This is an OPERATOR decision, recorded as such (see
 * `modules/providers/owner-decision.ts`): it cites the owner and the date, it does
 * not claim the emitter granted anything, and the upstream's own licence is kept
 * next to it as provenance. The gate then evaluates it like any other recorded
 * class, so a shortener or a static CDN still cannot be opened.
 */
import { loadConfig } from '../config/config.js';
import { connectDatabase } from '../infrastructure/mongo.js';
import { initCliEnvironment, reportFailure } from './cli-env.js';
import { openCatalogueToOwner } from '../modules/providers/owner-decision.js';

interface Args {
  provider: string;
  owner: string;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const values: Record<string, string> = {};
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) continue;
    if (flag === '--dry-run') {
      dryRun = true;
      continue;
    }
    values[flag] = argv[index + 1] ?? '';
    index += 1;
  }
  const provider = values['--provider'];
  const owner = values['--owner'];
  if (!provider || !owner) throw new Error('Uso: --provider <nombre> --owner <quién decide> [--dry-run]');
  return { provider, owner, dryRun };
}

/** Upstream licence kept as provenance for the decision. */
const LICENCES: Record<string, string> = {
  'iptv-org': 'https://github.com/iptv-org/iptv/blob/master/LICENSE',
};

const CITATIONS: Record<string, (owner: string, date: string) => string> = {
  'iptv-org': (owner, date) =>
    `Decisión del propietario del producto (${owner}, ${date}): «todas las que funcionen en el catálogo, nada de restricciones». ` +
    'El catálogo iptv-org se ofrece íntegro a través de esta plataforma. Es una decisión de operador y no una concesión del emisor: ' +
    'la señal pertenece a quien la emite, y su licencia de listado es de dominio público (Unlicense/CC0).',
};

async function main(): Promise<void> {
  initCliEnvironment();
  const args = parseArgs(process.argv.slice(2));
  const licenceUrl = LICENCES[args.provider];
  const cite = CITATIONS[args.provider];
  if (licenceUrl === undefined || cite === undefined) {
    throw new Error(`Sin licencia ni cita registrada para ${args.provider}.`);
  }
  const config = loadConfig();
  const database = await connectDatabase(config.MONGODB_URI, config.MONGODB_DB);
  try {
    const date = new Date().toISOString().slice(0, 10);
    const result = await openCatalogueToOwner(database, {
      provider: args.provider,
      owner: args.owner,
      citation: cite(args.owner, date),
      upstreamLicenceUrl: licenceUrl,
      dryRun: args.dryRun,
    });
    console.log(JSON.stringify({ command: 'open-catalogue', targetDatabase: config.MONGODB_DB, ...result }, null, 2));
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  reportFailure('open-catalogue', error);
  process.exit(1);
});
