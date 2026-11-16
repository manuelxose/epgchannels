/**
 * Static server for the production build with SPA fallback, plus a development
 * proxy for `/api` so the shipped bundle calls the real backend on the same
 * origin — exactly the deployment topology the API is designed for.
 *
 * Used by Playwright, so the E2E suite exercises the exact shipped bundle against
 * the real backend and the real database.
 *
 *   DIST_DIR=dist/tdt-player-rebuild/browser API_PROXY=http://127.0.0.1:4010 node scripts/serve-dist.mjs
 */
import { createServer, request as proxyRequest } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const root = process.env['DIST_DIR'] ?? 'dist/tdt-player-rebuild/browser';
const port = Number(process.env['PORT'] ?? 4400);
const apiProxy = process.env['API_PROXY'] ?? 'http://127.0.0.1:4010';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

if (!existsSync(root)) {
  console.error(`[serve-dist] build not found at ${root}`);
  process.exit(1);
}

/** Forwards an API request to the backend, preserving method and body. */
function proxy(request, response, target) {
  const upstream = new URL(target);
  const forwarded = proxyRequest(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: upstream.host },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  forwarded.on('error', (error) => {
    response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: { code: 'unavailable', message: String(error) }, requestId: 'proxy' }));
  });
  request.pipe(forwarded);
}

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  // Same-origin API path: the browser sees one origin, the backend stays private.
  if (requestUrl.pathname.startsWith('/api/')) {
    proxy(request, response, apiProxy);
    return;
  }

  const safePath = normalize(decodeURIComponent(requestUrl.pathname)).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(root, safePath);

  const isFile = existsSync(filePath) && statSync(filePath).isFile();
  if (!isFile) {
    // Media and data assets must 404 instead of falling back to the SPA shell;
    // only navigation requests get index.html.
    const looksLikeAsset = /\.[a-z0-9]+$/i.test(safePath) || safePath.startsWith('/demo/');
    if (looksLikeAsset) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    filePath = join(root, 'index.html');
  }

  const body = readFileSync(filePath);
  response.writeHead(200, {
    'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  response.end(body);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[serve-dist] serving ${root} on http://127.0.0.1:${port} (api → ${apiProxy})`);
});
