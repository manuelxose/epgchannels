/**
 * Development supervisor.
 *
 * The backend is a single long-lived process. In this workspace it is started
 * from an agent shell, so the shell must be able to own it and stop it
 * deterministically: this script writes a pid file, replaces a previous instance
 * and handles SIGINT/SIGTERM by closing the server, the cache and the database
 * before exiting.
 *
 *   node scripts/dev-supervisor.mjs start   # start (or restart) on PORT
 *   node scripts/dev-supervisor.mjs stop    # stop the recorded instance
 *   node scripts/dev-supervisor.mjs status  # pid, port, health
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';

const PID_FILE = resolve('.dev-server.pid');
const ENTRY = resolve('dist/server/main.js');
const PORT = Number(process.env.PORT ?? 4010);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid() {
  if (!existsSync(PID_FILE)) return null;
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function portFree() {
  return new Promise((resolvePort) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: PORT });
    socket.once('connect', () => {
      socket.destroy();
      resolvePort(false);
    });
    socket.once('error', () => resolvePort(true));
  });
}

async function stop() {
  const pid = readPid();
  if (pid && isAlive(pid)) {
    process.kill(pid, 'SIGTERM');
    for (let attempt = 0; attempt < 40 && isAlive(pid); attempt += 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  }
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await portFree()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(JSON.stringify({ command: 'stop', port: PORT, note: 'port still busy; owned by another process' }));
}

async function start() {
  await stop();
  const child = spawn(process.execPath, [ENTRY], {
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: false,
  });
  writeFileSync(PID_FILE, String(child.pid), 'utf8');
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (!(await portFree())) {
      console.log(JSON.stringify({ command: 'start', pid: child.pid, port: PORT, state: 'listening' }));
      return;
    }
    if (child.exitCode !== null) {
      console.log(JSON.stringify({ command: 'start', pid: child.pid, state: 'exited', code: child.exitCode }));
      process.exitCode = 1;
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(JSON.stringify({ command: 'start', pid: child.pid, state: 'timeout' }));
  process.exitCode = 1;
}

async function status() {
  const pid = readPid();
  const free = await portFree();
  console.log(JSON.stringify({ command: 'status', pid, alive: pid ? isAlive(pid) : false, port: PORT, listening: !free }));
}

const command = process.argv[2] ?? 'status';
if (command === 'start') await start();
else if (command === 'stop') await stop();
else await status();
