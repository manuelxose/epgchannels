/**
 * Concise port error for development.
 *
 * Node's `EADDRINUSE` arrives as an unhandled 'error' event with a stack trace,
 * which tells a developer nothing about what is holding the port or what to do.
 * This wrapper turns it into one readable line and a non-zero exit.
 */
import type { Server } from 'node:http';

export function explainListenError(error: NodeJS.ErrnoException, port: number, host: string): string | null {
  if (error.code === 'EADDRINUSE') {
    return [
      `El puerto ${port} ya está en uso en ${host}.`,
      '',
      'Suelen ocurrir dos cosas:',
      '  1. Ya hay otra instancia en marcha (el modo --watch la reinicia por ti).',
      '     Comprueba con:  node scripts/free-port.mjs ' + port,
      '  2. Quieres otro puerto:  PORT=4020 npm run dev:backend',
    ].join('\n');
  }
  if (error.code === 'EACCES') {
    return `No hay permiso para escuchar en ${host}:${port}. Usa un puerto por encima de 1024 (PORT=4020).`;
  }
  return null;
}

/** Wires the explanation for a server that is about to listen. */
export function listenWithExplanation(server: Server, port: number, host: string): void {
  server.on('error', (error: NodeJS.ErrnoException) => {
    const explanation = explainListenError(error, port, host);
    if (explanation) {
      process.stderr.write(`\n${explanation}\n\n`);
      process.exit(1);
    }
    throw error;
  });
}
