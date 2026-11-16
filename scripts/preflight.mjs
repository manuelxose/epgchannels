/**
 * Baseline preflight for the reproducible checks.
 *
 * The verification stages in `qa/qa-manifest.json` are honest only when the data
 * service they need is reachable: the integration suites require a MongoDB replica
 * set. This script performs read-only reachability checks and exits non-zero with
 * a diagnostic when something is missing, so a "PASS" can never come from a
 * silently skipped integration stage.
 *
 * Redis is optional by design (config.ts treats an unset REDIS_URL as a no-op
 * cache), so an unreachable Redis is reported but never blocks the baseline.
 *
 *   node scripts/preflight.mjs
 *
 * Configuration (same names the application uses; values are never printed):
 *   MONGODB_URI  default mongodb://127.0.0.1:27117/?replicaSet=rs0
 *   REDIS_URL    default redis://127.0.0.1:27118
 *
 * Exit codes: 0 = ready, 1 = not ready (the printed reason names the fix).
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(ROOT, 'apps/backend/package.json'));

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:27118';

/** Never echo credentials that may be embedded in a connection string. */
function redact(uri) {
  return uri.replace(/\/\/[^/@]*@/, '//***@');
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

const results = [];
/** Only the required services decide readiness; optional ones are reported as-is. */
const required = new Set(['mongodb']);
let ready = true;

function record(name, ok, detail) {
  results.push({ name, ok, required: required.has(name), detail });
  if (!ok && required.has(name)) ready = false;
}

async function checkMongo() {
  let client;
  try {
    const { MongoClient } = require('mongodb');
    client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
    await client.connect();
    const admin = client.db('admin');
    const hello = await admin.command({ hello: 1 });
    // Integration suites rely on transactions/changefeeds: a replica set is required.
    const replicaSet = typeof hello.setName === 'string' ? hello.setName : null;
    const health = await client.db('tdt_preflight').command({ ping: 1 });
    record(
      'mongodb',
      replicaSet !== null && health.ok === 1,
      replicaSet !== null
        ? `reachable, replica set "${replicaSet}"`
        : `reachable but not a replica set; run "npm run infra:up" (${redact(MONGODB_URI)})`,
    );
  } catch (error) {
    record('mongodb', false, `unreachable: ${describe(error)} (start it with "npm run infra:up")`);
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

async function checkRedis() {
  let client;
  try {
    const { createClient } = require('redis');
    client = createClient({ url: REDIS_URL, socket: { connectTimeout: 4000, reconnectStrategy: false } });
    client.on('error', () => {});
    await client.connect();
    const pong = await client.ping();
    record('redis', pong === 'PONG', `reachable, ping -> ${pong}`);
  } catch (error) {
    record('redis', false, `unreachable: ${describe(error)} (start it with "npm run infra:up")`);
  } finally {
    if (client) await client.quit().catch(() => client.destroy());
  }
}

async function checkWorkspace(name) {
  try {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, name, 'package.json'), 'utf8'));
    record(name, true, `${manifest.name}@${manifest.version}`);
  } catch (error) {
    record(name, false, `unreadable package.json: ${describe(error)}`);
  }
}

await checkMongo();
await checkRedis();
for (const workspace of ['packages/contracts', 'packages/api-client', 'apps/backend']) {
  await checkWorkspace(workspace);
}

const verdict = ready ? 'READY' : 'NOT READY';
console.log(JSON.stringify({ preflight: verdict, checks: results }, null, 2));
process.exit(ready ? 0 : 1);
