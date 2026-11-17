/**
 * Adversarial HTTP fixtures for egress tests (TDT-API-02D, SEC-01).
 *
 * A real `node:http` server bound to `127.0.0.1` on an ephemeral port, so tests
 * exercise the egress executor against an actual socket rather than a mock. It
 * can answer with any status/content-type/body, redirect, stall forever, or
 * stream an unbounded body.
 *
 * **Recording.** Every accepted TCP connection and every received request is
 * counted and described. That is the oracle for the central assertion of the SSRF
 * tests: for a blocked destination the counter must stay at **0** — the egress
 * layer refused *before* opening a socket, not after.
 *
 * **Loopback is only ever the blocked destination under test**, or an allowed
 * destination when the caller passes the explicit test-only `allowLoopbackForTests`
 * flag. This module must never be imported by production code.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureRequestRecord {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly hasAuthorization: boolean;
  readonly hasCookie: boolean;
}

export interface FixtureCounters {
  /** TCP connections accepted. */
  sockets: number;
  /** Requests whose headers arrived. */
  requests: number;
}

export type FixtureHandler = (request: http.IncomingMessage, response: http.ServerResponse) => void;

export interface HttpFixture {
  /** `http://127.0.0.1:<port>` with no trailing slash. */
  readonly origin: string;
  readonly port: number;
  readonly counters: FixtureCounters;
  readonly received: readonly FixtureRequestRecord[];
  /** Full URL for `path` on this fixture. */
  url(path: string): string;
  /** Runs `body` against the fixture, then always closes it. */
  close(): Promise<void>;
}

export interface FixtureRoute {
  readonly status?: number;
  readonly contentType?: string;
  readonly body?: string;
  /** Send `Location` and the right redirect status (default 302). */
  readonly location?: string;
  /** Never respond: the request hangs until the client gives up. */
  readonly hang?: boolean;
  /** Stream `size` bytes with no `content-length` (chunked), forever if `size` is huge. */
  readonly streamBytes?: number;
  /** Chunk size for `streamBytes` (default 16 KiB). */
  readonly chunkSize?: number;
  /** `content-length` to declare, independent of what is actually sent (lying server). */
  readonly declaredContentLength?: number;
  readonly delayMs?: number;
}

/**
 * Starts a fixture server. Routes map pathname → behaviour; an unknown path is a
 * 404. The returned `origin` is loopback: callers must treat it as hostile.
 */
export async function startHttpFixture(routes: Readonly<Record<string, FixtureRoute>> = {}): Promise<HttpFixture> {
  const counters: FixtureCounters = { sockets: 0, requests: 0 };
  const received: FixtureRequestRecord[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const timers = new Set<NodeJS.Timeout>();

  const server = http.createServer((request, response) => {
    counters.requests += 1;
    received.push({
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: request.headers,
      hasAuthorization: request.headers.authorization !== undefined,
      hasCookie: request.headers.cookie !== undefined,
    });
    if (received.length > 500) received.shift();

    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const route = routes[path];
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    if (route.hang === true) {
      // Deliberately never respond; the client's timeout must end this.
      return;
    }
    const run = (): void => {
      if (response.destroyed) return;
      const headers: Record<string, string> = {};
      if (route.contentType !== undefined) headers['content-type'] = route.contentType;
      if (route.declaredContentLength !== undefined) headers['content-length'] = String(route.declaredContentLength);
      if (route.location !== undefined) headers.location = route.location;

      if (route.streamBytes !== undefined) {
        // No content-length: the client's incremental counter must catch it.
        response.writeHead(route.status ?? 200, headers);
        const chunkSize = route.chunkSize ?? 16 * 1024;
        const chunk = Buffer.alloc(chunkSize, 0x61); // 'a'
        let sent = 0;
        const pump = (): void => {
          while (sent < route.streamBytes! && !response.destroyed) {
            sent += chunkSize;
            if (response.write(chunk) === false) {
              response.once('drain', pump);
              return;
            }
          }
          if (!response.destroyed) response.end();
        };
        pump();
        return;
      }

      const status = route.location !== undefined ? (route.status ?? 302) : (route.status ?? 200);
      response.writeHead(status, headers);
      response.end(route.body ?? '');
    };
    if (route.delayMs !== undefined && route.delayMs > 0) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        run();
      }, route.delayMs);
      timers.add(timer);
      return;
    }
    run();
  });

  server.on('connection', (socket) => {
    counters.sockets += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    port,
    counters,
    received,
    url(path: string): string {
      return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
    },
    async close(): Promise<void> {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      // Hung requests keep sockets open; destroy them so the test can end.
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
