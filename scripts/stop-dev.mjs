/**
 * Stops the development run started by `npm run dev` of THIS repository.
 *
 * `scripts/dev.mjs` writes the PIDs of the two servers it started to
 * `.dev-pids.json`. Because those PIDs are the server processes themselves (not a
 * shell in between), stopping them is exact: no scanning, no guessing, and no
 * risk of touching another checkout's servers.
 *
 * The fallback (no PID file, e.g. a run started before this file existed) only
 * matches this checkout's own paths, never a generic command shape.
 *
 *   node scripts/stop-dev.mjs
 */
import net from 'node:net';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const pidFile = resolve('.dev-pids.json');
const repoRoot = resolve('.').toLowerCase().replace(/\\/g, '/');
const ports = [4010, 4200];

function portBusy(port) {
  return new Promise((resolveBusy) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolveBusy(true);
    });
    socket.once('error', () => resolveBusy(false));
  });
}

function kill(pid) {
  return spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }).status === 0;
}

function recorded() {
  if (!existsSync(pidFile)) return null;
  try {
    const data = JSON.parse(readFileSync(pidFile, 'utf8'));
    return Array.isArray(data.roots) ? data.roots.filter((pid) => Number.isInteger(pid)) : null;
  } catch {
    return null;
  }
}

/**
 * Fallback: processes whose command line names this checkout's dev entry points.
 * Both are absolute paths, so no other repository can match them.
 */
function byAbsolutePath() {
  const backendDev = `${repoRoot}/apps/backend/src/server/dev.ts`;
  const angularCli = `${repoRoot}/apps/frontend/node_modules/@angular/cli/bin/ng.js`;
  const found = new Set();
  let output = '';
  try {
    output = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }",
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return found;
  }
  for (const row of output.split(/\r?\n/)) {
    const separator = row.indexOf('|');
    if (separator < 0) continue;
    const pid = row.slice(0, separator).trim();
    const command = row.slice(separator + 1).toLowerCase().replace(/\\/g, '/');
    if (!/^\d+$/.test(pid)) continue;
    // The watcher runs with a relative `src/server/dev.ts`; it is included only
    // when it also carries the absolute Angular CLI path or the checkout path.
    if (command.includes(backendDev) || command.includes(angularCli)) found.add(Number(pid));
  }
  return found;
}

const fromFile = recorded();
const targets = fromFile ?? [...byAbsolutePath()];

if (fromFile === null) {
  console.log('no hay registro de PIDs; buscando por rutas absolutas de este repositorio');
}
for (const pid of targets) {
  console.log(`${kill(pid) ? 'detenido' : 'ya no existía'} pid ${pid}`);
}
if (targets.length === 0) {
  console.log('no había procesos de desarrollo de este repositorio');
}
if (existsSync(pidFile)) rmSync(pidFile, { force: true });

await new Promise((resolveWait) => setTimeout(resolveWait, 1800));
let allFree = true;
for (const port of ports) {
  const free = !(await portBusy(port));
  if (!free) allFree = false;
  console.log(`puerto ${port}: ${free ? 'libre' : 'TODAVÍA OCUPADO'}`);
}
if (!allFree) {
  console.log(
    [
      '',
      'Un proceso ajeno a este repositorio ocupa ese puerto y este script no lo mata.',
      `Localízalo con:  netstat -ano | findstr :${ports.join('  ó  :')}`,
      '',
    ].join('\n'),
  );
}
process.exitCode = allFree ? 0 : 1;
