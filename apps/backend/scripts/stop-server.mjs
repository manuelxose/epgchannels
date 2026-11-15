// Restart the server on port 4010: stop the listener, wait for the port, relaunch.
import { execSync, spawn } from 'node:child_process';
import net from 'node:net';

const port = 4010;

// 1. Stop whatever listens on the port.
try {
  const raw = execSync(
    `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess"`,
    { encoding: 'utf8' },
  ).trim();
  for (const pid of raw.split(/\s+/).filter(Boolean)) {
    console.log('stopping pid', pid);
    try {
      execSync(`Stop-Process -Id ${pid} -Force`, { stdio: 'inherit' });
    } catch {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'inherit' });
    }
  }
} catch (error) {
  console.log('nothing listening:', String(error).slice(0, 80));
}

// 2. Wait until the port is actually free.
for (let attempt = 0; attempt < 40; attempt += 1) {
  const free = await new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
  if (free) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
console.log('port', port, 'free');
