/**
 * One-command development environment.
 *
 *   npm run dev        API (:4010) + Angular dev server (:4200)
 *
 * The web server proxies `/api/v1` to the backend (`apps/frontend/proxy.conf.json`),
 * so the browser sees a single origin — the same topology as production.
 *
 * Ports come from the environment (`PORT` for the API, `WEB_PORT` for the
 * client) so this script can never disagree with `apps/backend/.env`.
 *
 * Process handling: both servers are spawned as the real programs
 * (`node` and the Angular CLI script) rather than through `npm` and `cmd.exe`.
 * That matters on Windows: a killed shell leaves its grandchildren orphaned, and
 * an orphaned server keeps its port. Spawning the program directly makes the
 * recorded PID the PID that actually holds the port, so both Ctrl+C and
 * `npm run stop:dev` can stop it deterministically.
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { MongoClient } from 'mongodb';

const API_PORT = Number(process.env.PORT ?? 4010);
const WEB_PORT = Number(process.env.WEB_PORT ?? 4200);
const WEB_HOSTS = ['localhost', '127.0.0.1'];
const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0';
const PID_FILE = resolve('.dev-pids.json');

const BACKEND_DIR = resolve('apps/backend');
const FRONTEND_DIR = resolve('apps/frontend');
const requireFromFrontend = createRequire(join(FRONTEND_DIR, 'package.json'));
// Resolved to an absolute path so the process command line identifies the checkout.
const ANGULAR_CLI = requireFromFrontend.resolve('@angular/cli/bin/ng.js');

const children = [];
let shuttingDown = false;

function recordPids() {
  const roots = children.map((entry) => entry.child.pid).filter((pid) => Number.isInteger(pid));
  writeFileSync(PID_FILE, `${JSON.stringify({ roots, apiPort: API_PORT, webPort: WEB_PORT, startedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
}

function prefixed(prefix, chunk) {
  for (const text of chunk.toString().split(/\r?\n/)) {
    if (text.trim().length > 0) process.stdout.write(`${prefix} ${text}\n`);
  }
}

function start(name, prefix, command, args, cwd, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
  child.stdout.on('data', (chunk) => prefixed(prefix, chunk));
  child.stderr.on('data', (chunk) => prefixed(prefix, chunk));
  child.on('exit', (code) => {
    if (!shuttingDown) {
      process.stderr.write(`\n[dev] ${name} terminó con código ${code ?? 'desconocido'}\n`);
      shutdown(code === 0 ? 0 : 1);
    }
  });
  children.push({ name, child });
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (child.killed || !child.pid) continue;
    // The PID here is the server itself, so its children die with it.
    child.kill();
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    }
  }
  rmSync(PID_FILE, { force: true });
  setTimeout(() => process.exit(code), 1200);
}

process.on('SIGINT', () => {
  process.stdout.write('\n[dev] deteniendo…\n');
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));

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
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  return false;
}

async function infrastructureReachable() {
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return true;
  } catch (error) {
    process.stderr.write(
      [
        '',
        `[dev] La base de datos no responde en ${MONGODB_URI}`,
        `      (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`,
        '',
        '      Levántala con:  npm run infra:up',
        '',
      ].join('\n'),
    );
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function occupiedMessage(port, hint) {
  return [
    '',
    `[dev] El puerto ${port} ya está ocupado.`,
    '      Detén lo que lo ocupa con:  npm run stop:dev',
    `      O usa otros puertos:        ${hint}`,
    '',
  ].join('\n');
}

async function main() {
  if (!existsSync(join(BACKEND_DIR, 'src/server/dev.ts')) || !existsSync(join(FRONTEND_DIR, 'angular.json'))) {
    process.stderr.write('[dev] Ejecuta este comando desde la raíz del repositorio.\n');
    process.exit(1);
  }
  if (!existsSync(join(FRONTEND_DIR, 'node_modules'))) {
    process.stderr.write('[dev] Faltan las dependencias del cliente: (cd apps/frontend && npm install)\n');
    process.exit(1);
  }
  if (await portBusy(API_PORT)) {
    process.stderr.write(occupiedMessage(API_PORT, 'PORT=4020 WEB_PORT=4201 npm run dev'));
    process.exit(1);
  }
  if (await portBusy(WEB_PORT, WEB_HOSTS)) {
    process.stderr.write(occupiedMessage(WEB_PORT, 'WEB_PORT=4201 npm run dev'));
    process.exit(1);
  }
  if (!(await infrastructureReachable())) {
    process.exit(1);
  }

  process.stdout.write(
    `[dev] api → http://127.0.0.1:${API_PORT}/api/v1   web → http://localhost:${WEB_PORT}\n`,
  );

  start(
    'backend',
    '[api]',
    process.execPath,
    ['--watch', '--experimental-strip-types', '--experimental-transform-types', 'src/server/dev.ts'],
    BACKEND_DIR,
    { PORT: String(API_PORT) },
  );
  recordPids();
  if (!(await waitForPort(API_PORT, ['127.0.0.1'], 120_000))) {
    process.stderr.write('[dev] El backend no abrió el puerto en 120s; revisa la salida [api].\n');
    return shutdown(1);
  }

  start(
    'frontend',
    '[web]',
    process.execPath,
    [ANGULAR_CLI, 'serve', '--port', String(WEB_PORT), '--proxy-config', 'proxy.conf.json'],
    FRONTEND_DIR,
    { TDT_API_BASE_URL: '/api/v1' },
  );
  recordPids();
  if (!(await waitForPort(WEB_PORT, WEB_HOSTS, 300_000))) {
    process.stderr.write('[dev] El cliente no abrió el puerto en 300s; revisa la salida [web].\n');
    return shutdown(1);
  }
  process.stdout.write(`[dev] listo: abre http://localhost:${WEB_PORT}/television\n`);
}

main().catch((error) => {
  process.stderr.write(`[dev] ${error instanceof Error ? error.message : String(error)}\n`);
  shutdown(1);
});
