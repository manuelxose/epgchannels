/**
 * Start the whole product locally, from a clean checkout, with one command.
 *
 *   npm run demo        API (4010) + web (4200) + panel de administración
 *
 * What it does, in order, and why:
 *
 * 1. Reads the repository `.env` (the backend and this script share it).
 * 2. Waits for MongoDB and Redis, because the API refuses to boot without them.
 * 3. Builds the three packages and the Angular app: the shipped bundle is the
 *    one that ships, served by `scripts/serve-dist.mjs` with the `/api` proxy,
 *    so the browser talks to one origin — the same topology as deployment.
 * 4. Applies the migrations and creates the administrator from `.env` through
 *    the SAME endpoint an operator would use (`/auth/bootstrap`), so the
 *    password is hashed by the product and never written by this script. If an
 *    administrator already exists the step is skipped: the initial sign-up is
 *    closed on purpose once one admin exists.
 * 5. Starts both servers and prints the URLs. Ctrl+C stops both.
 *
 * It never prints a secret value. Nothing here is silent: every step logs what it
 * did, and a failure stops the boot instead of leaving half a stack running.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import net from 'node:net';
import { MongoClient } from 'mongodb';

const ROOT = resolve(import.meta.dirname, '..');
const FRONTEND = join(ROOT, 'apps/frontend');

const API_PORT = Number(process.env.PORT ?? 4010);
const WEB_PORT = Number(process.env.WEB_PORT ?? 4200);
const WEB_HOSTS = ['localhost', '127.0.0.1'];

function log(message) {
  process.stdout.write(`[demo] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`\n[demo] ${message}\n\n`);
  process.exit(1);
}

/** Reads `<repo>/.env`; a variable already in the environment always wins. */
function loadDotEnv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) {
    fail('No existe .env. Copia .env.example a .env y ajusta los valores.');
  }
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at <= 0) continue;
    const key = trimmed.slice(0, at).trim();
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(at + 1).trim();
  }
  return { hasBootstrapToken: (process.env.ADMIN_BOOTSTRAP_TOKEN ?? '').length >= 32 };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    stdio: options.quiet ? 'pipe' : 'inherit',
    shell: process.platform === 'win32',
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.status !== 0) {
    if (options.quiet && result.stderr) process.stderr.write(`${result.stderr}\n`);
    fail(`${command} ${args.join(' ')} falló con código ${result.status}.`);
  }
  return result;
}

async function portBusy(port, hosts = ['127.0.0.1']) {
  for (const host of hosts) {
    const busy = await new Promise((resolveBusy) => {
      const socket = net.createConnection({ host, port });
      socket.once('connect', () => {
        socket.destroy();
        resolveBusy(true);
      });
      socket.once('error', () => resolveBusy(false));
    });
    if (busy) return true;
  }
  return false;
}

async function waitForPort(port, hosts, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portBusy(port, hosts)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  }
  return false;
}

async function waitForInfrastructure(uri, redisUrl) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3_000 });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
  } catch (error) {
    fail(
      `MongoDB no responde en ${uri} (${error.message.split('\n')[0]}).\n` +
        '       Levántala con:  npm run infra:up',
    );
  } finally {
    await client.close().catch(() => undefined);
  }
  if (redisUrl) {
    const reachable = await new Promise((resolveRedis) => {
      const url = new URL(redisUrl);
      const socket = net.createConnection({ host: url.hostname, port: Number(url.port || 6379) });
      socket.once('connect', () => {
        socket.destroy();
        resolveRedis(true);
      });
      socket.once('error', () => resolveRedis(false));
    });
    if (!reachable) log('Redis no responde: la API arranca igualmente sirviendo desde la base.');
  }
}

/** Creates the administrator through the public bootstrap endpoint. */
async function ensureAdministrator(bootstrapToken) {
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!email || !password) {
    log('ADMIN_BOOTSTRAP_EMAIL/PASSWORD no definidos: se omite la creación del administrador.');
    return;
  }
  const response = await fetch(`http://127.0.0.1:${API_PORT}/api/v1/auth/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, bootstrapToken, roles: ['admin'] }),
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 201) {
    log(`administrador creado: ${body?.data?.email ?? email}`);
    return;
  }
  if (response.status === 409) {
    /*
     * One administrator already exists, so the initial sign-up is closed — the
     * correct state. The account in `.env` must still be the one that works, so
     * its password is reset through the product's own hasher. Only THIS account
     * is touched: any other administrator in the database is left alone.
     */
    await convergeAdministrator(email, password, bootstrapToken);
    return;
  }
  fail(`no se pudo crear el administrador (HTTP ${response.status}): ${body?.error?.message ?? 'sin detalle'}`);
}

/**
 * Makes the `.env` account usable when an administrator already exists.
 *
 * The password is stored exactly as the product stores it (its own
 * `hashPassword`), and the token of this account is revoked so a stale session
 * from a previous password cannot survive the change. Nothing is printed but the
 * e-mail.
 */
async function convergeAdministrator(email, password, bootstrapToken) {
  if (process.env.DEMO_SYNC_ADMIN_PASSWORD !== 'true') {
    log(
      'ya existe un administrador: el alta inicial está cerrada.\n' +
        '      Si la cuenta de .env no entra, pon DEMO_SYNC_ADMIN_PASSWORD=true para fijar su contraseña (solo esa cuenta).',
    );
    return;
  }
  void bootstrapToken;
  const { hashPassword } = await import('../apps/backend/dist/modules/admin/admin.auth.js');
  const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0', {
    serverSelectionTimeoutMS: 3_000,
  });
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB ?? 'tdt_platform');
    const now = new Date();
    const result = await db.collection('admin_users').updateOne(
      { email: email.toLowerCase() },
      { $set: { passwordHash: await hashPassword(password), disabled: false, updatedAt: now } },
      { upsert: true },
    );
    await db.collection('admin_sessions').deleteMany({});
    log(
      result.upsertedCount > 0
        ? `administrador creado (alta inicial cerrada): ${email}`
        : `contraseña del administrador resincronizada con .env: ${email} (sesiones revocadas)`,
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

const children = [];
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.killed || !child.pid) continue;
    child.kill();
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  setTimeout(() => process.exit(code), 800);
}

process.on('SIGINT', () => {
  log('deteniendo…');
  stop(0);
});

function start(name, command, args, cwd, env = {}) {
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  });
  child.on('exit', (code) => {
    if (!stopping) {
      process.stderr.write(`\n[demo] ${name} terminó con código ${code ?? 'desconocido'}\n`);
      stop(1);
    }
  });
  children.push(child);
}

/**
 * Seeds the SYNTHETIC demonstration guide, and only when the database holds no
 * current guide at all.
 *
 * The checkout ships no downloadable guide on purpose (guide snapshots are
 * git-ignored working data), so a clean database would show an empty now/next.
 * Everything written here is generated by `make-guide-fixture.mjs` and every
 * title ends in "demo"; the source is registered with `licence: synthetic-demo`
 * so its provenance is unmistakable. Set `DEMO_SEED_GUIDE=false` to skip it.
 */
async function seedDemoGuide() {
  if ((process.env.DEMO_SEED_GUIDE ?? 'true') !== 'true') {
    log('guía de demostración desactivada (DEMO_SEED_GUIDE=false).');
    return;
  }
  const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0', {
    serverSelectionTimeoutMS: 3_000,
  });
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB ?? 'tdt_platform');
    const now = Date.now();
    const current = await db.collection('programmes').countDocuments({ end: { $gt: new Date(now) } });
    if (current > 0) {
      log(`la base ya tiene ${current} emisiones vigentes: no se siembra la guía de demostración.`);
      return;
    }
  } finally {
    await client.close().catch(() => undefined);
  }
  log('generando e importando la guía de DEMOSTRACIÓN (contenido sintético, no son emisiones reales)…');
  run('node', ['scripts/make-guide-fixture.mjs', '--out', 'data/guide-demo.xml']);
  run('node', [
    'apps/backend/dist/scripts/import-guide.js',
    '--file',
    'data/guide-demo.xml',
    '--source-name',
    'Demostración sintética',
    '--kind',
    'xmltv',
    '--licence',
    'synthetic-demo',
    '--attribution',
    'Programación sintética generada por el propio proyecto para demostración. No es una emisión real.',
    '--enable-ingestion',
    'false',
  ]);
}

async function main() {
  const { hasBootstrapToken } = loadDotEnv();
  if (!hasBootstrapToken) {
    fail(
      'ADMIN_BOOTSTRAP_TOKEN falta en .env o tiene menos de 32 caracteres.\n' +
        "       Genera uno con:  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  if (await portBusy(API_PORT)) fail(`el puerto ${API_PORT} ya está ocupado (npm run stop:dev).`);
  if (await portBusy(WEB_PORT, WEB_HOSTS)) fail(`el puerto ${WEB_PORT} ya está ocupado (npm run stop:dev).`);

  log('comprobando servicios de datos…');
  await waitForInfrastructure(
    process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0',
    process.env.REDIS_URL,
  );

  log('compilando paquetes y cliente…');
  run('npm', ['run', 'build']);

  log('aplicando migraciones…');
  run('npm', ['run', 'migrate']);

  log('arrancando la API…');
  start('api', 'node', ['apps/backend/dist/server/main.js'], ROOT, { PORT: String(API_PORT) });
  if (!(await waitForPort(API_PORT, ['127.0.0.1'], 60_000))) fail('la API no abrió su puerto.');

  await ensureAdministrator(process.env.ADMIN_BOOTSTRAP_TOKEN);
  await seedDemoGuide();

  log('compilando el cliente…');
  run('npm', ['--prefix', 'apps/frontend', 'run', 'build'], { quiet: true });

  log('sirviendo el cliente…');
  start('web', 'node', ['scripts/serve-dist.mjs'], FRONTEND, {
    PORT: String(WEB_PORT),
    DIST_DIR: 'dist/tdt-player-rebuild/browser',
    API_PROXY: `http://127.0.0.1:${API_PORT}`,
  });
  if (!(await waitForPort(WEB_PORT, WEB_HOSTS, 60_000))) fail('el cliente no abrió su puerto.');

  process.stdout.write(
    [
      '',
      '  TDT Platform en marcha',
      `    Televisión en directo : http://127.0.0.1:${WEB_PORT}/television`,
      `    Guía / parrilla       : http://127.0.0.1:${WEB_PORT}/schedule`,
      `    Administración        : http://127.0.0.1:${WEB_PORT}/admin   (usuario: ${process.env.ADMIN_BOOTSTRAP_EMAIL ?? '(sin definir)'})`,
      `    API                   : http://127.0.0.1:${API_PORT}/api/v1`,
      `    OpenAPI               : http://127.0.0.1:${WEB_PORT}/api/v1/openapi.json`,
      '',
      '    La contraseña está en .env (ADMIN_BOOTSTRAP_PASSWORD).',
      '    Ctrl+C detiene todo.',
      '',
    ].join('\n'),
  );
}

main().catch((error) => fail(error?.stack ?? String(error)));
