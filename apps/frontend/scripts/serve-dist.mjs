/**
 * Minimal static file server for the production build with SPA fallback.
 * Used by Playwright so E2E exercises the exact shipped bundle.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const root = process.env['DIST_DIR'] ?? 'dist/tdt-player-rebuild/browser';
const port = Number(process.env['PORT'] ?? 4400);

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

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
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
  console.log(`[serve-dist] serving ${root} on http://127.0.0.1:${port}`);
});
