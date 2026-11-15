/**
 * `openapi:export` writes the OpenAPI 3.1 document the SDK is generated from.
 *
 * Usage: node dist/scripts/export-openapi.js [--base-url https://host] [--out path]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildOpenApi } from '../server/openapi.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const argOf = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? (argv[index + 1] as string) : fallback;
  };
  const baseUrl = argOf('--base-url', 'http://127.0.0.1:4010');
  const out = resolve(argOf('--out', 'openapi/openapi.json'));
  const document = buildOpenApi(baseUrl);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify(
      {
        command: 'openapi:export',
        out,
        openapi: document.openapi,
        paths: Object.keys(document.paths).length,
        schemas: Object.keys(document.components.schemas).length,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ command: 'openapi:export', status: 'failed', error: String(error) }));
  process.exit(1);
});
