/**
 * Decisive comparison: does hls.js play a stream that Chromium's NATIVE <video>
 * path refuses?
 *
 * The catalogue playback check points a raw `<video>` at the manifest, so it
 * measures Chromium's built-in HLS parser. That parser can read the playlist but
 * cannot demux MPEG-TS, which is why it reports
 * `MEDIA_ERR_SRC_NOT_SUPPORTED / DEMUXER_ERROR_COULD_NOT_PARSE` on valid streams.
 * Our player does not use that path in Chromium: it uses hls.js.
 *
 * This script loads the SAME hls.js build our app ships, points it at each URL,
 * and reports what actually happened: manifest parsed, levels, media time
 * advanced, dimensions. No proxying, no forged headers, no CORS tricks.
 *
 * Usage: node evidence/02e/hls-comparison.mjs <url> [<url>...]
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// evidence/02e → repo root is two levels up (this file lives at <root>/evidence/02e/).
const REPO_ROOT = resolve(HERE, '..', '..');
const HLS_JS = join(REPO_ROOT, 'apps', 'frontend', 'node_modules', 'hls.js', 'dist', 'hls.min.js');

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error('usage: node evidence/02e/hls-comparison.mjs <url> [<url>...]');
  process.exit(2);
}

/** Serve one page plus the hls.js bundle on loopback; nothing else. */
function startServer() {
  const hlsSource = readFileSync(HLS_JS, 'utf8');
  const page = `<!doctype html><meta charset="utf-8"><title>hls</title>
<video id="v" muted playsinline style="width:640px;background:#000"></video>
<script src="/hls.js"></script>
<script>
window.__result = { errors: [], levels: null, manifestMs: null, playingMs: null, samples: [] };
const v = document.getElementById('v');
const src = new URLSearchParams(location.search).get('src');
const started = performance.now();
if (!window.Hls || !Hls.isSupported()) {
  window.__result.fatal = 'Hls.isSupported() === false';
} else {
  const hls = new Hls({ enableWorker: false });
  window.__hls = hls;
  hls.on(Hls.Events.MANIFEST_PARSED, (_e, d) => {
    window.__result.manifestMs = Math.round(performance.now() - started);
    window.__result.levels = d.levels.map((l) => ({ height: l.height, bitrate: l.bitrate }));
    v.play().catch((e) => window.__result.errors.push('play(): ' + e.message));
  });
  hls.on(Hls.Events.LEVEL_SWITCHED, (_e, d) => { window.__result.level = d.level; });
  hls.on(Hls.Events.ERROR, (_e, d) => {
    window.__result.errors.push({ type: d.type, details: d.details, fatal: d.fatal });
  });
  hls.loadSource(src);
  hls.attachMedia(v);
  const sample = setInterval(() => {
    window.__result.samples.push({
      t: Math.round(performance.now() - started),
      currentTime: Number(v.currentTime.toFixed(2)),
      readyState: v.readyState,
      width: v.videoWidth,
      height: v.videoHeight,
      error: v.error ? v.error.code : null,
    });
    if (window.__result.playingMs === null && v.currentTime > 0 && !v.paused) {
      window.__result.playingMs = Math.round(performance.now() - started);
    }
  }, 1000);
  window.__stopSampling = () => clearInterval(sample);
}
</script>`;

  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      if (req.url === '/hls.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(hlsSource);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
    });
    server.listen(0, '127.0.0.1', () => resolvePromise({ server, port: server.address().port }));
  });
}

async function loadPlaywright() {
  const candidates = [
    join(REPO_ROOT, 'apps', 'frontend', 'node_modules', 'playwright', 'index.mjs'),
    join(REPO_ROOT, 'apps', 'frontend', 'node_modules', '@playwright', 'test', 'index.mjs'),
    join(REPO_ROOT, 'node_modules', 'playwright', 'index.mjs'),
  ];
  for (const candidate of candidates) {
    try {
      // A bare Windows path is treated as a package specifier, so it must be a file URL.
      return await import(pathToFileURL(candidate).href);
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('playwright not resolvable from any known location');
}

const { server, port } = await startServer();
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const results = [];

for (const url of urls) {
  const page = await browser.newPage();
  const hostile = new Set();
  page.on('requestfailed', (request) => {
    if (!request.url().startsWith(`http://127.0.0.1:${port}`)) hostile.add(request.failure()?.errorText ?? 'failed');
  });
  const target = `http://127.0.0.1:${port}/?src=${encodeURIComponent(url)}`;
  let result;
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    // Let the stream run long enough to show real progression.
    await page.waitForTimeout(9000);
    result = await page.evaluate(() => {
      if (typeof window.__stopSampling === 'function') window.__stopSampling();
      return window.__result;
    });
  } catch (error) {
    result = { fatal: String(error?.message ?? error).slice(0, 200) };
  }
  const samples = result.samples ?? [];
  const last = samples[samples.length - 1] ?? {};
  const first = samples[0] ?? {};
  /*
   * Progression is measured only over samples where media time was ALREADY
   * running. A live stream seeks to the DVR edge when playback starts, so the
   * first tick can sit at 0 (or anywhere) and the last tick at a DVR position:
   * subtracting them yields nonsense like "+3592 s" for a 9-second observation.
   * Taking the first and last samples with currentTime > 0 measures actual
   * playback progression, which is the claim being made.
   */
  const running = samples.filter(
    (s) => typeof s.currentTime === 'number' && s.currentTime > 0 && s.readyState >= 2,
  );
  const runFirst = running[0] ?? null;
  const runLast = running[running.length - 1] ?? null;
  results.push({
    url,
    host: new URL(url).host,
    manifestMs: result.manifestMs ?? null,
    playingMs: result.playingMs ?? null,
    levels: result.levels ?? null,
    level: result.level ?? null,
    currentTimeFirstSample: first.currentTime ?? null,
    currentTimeStart: runFirst?.currentTime ?? null,
    currentTimeEnd: runLast?.currentTime ?? null,
    samplesWhileRunning: running.length,
    advancedSeconds:
      runFirst !== null && runLast !== null && running.length > 1
        ? Number((runLast.currentTime - runFirst.currentTime).toFixed(2))
        : null,
    videoWidth: last.width ?? 0,
    videoHeight: last.height ?? 0,
    mediaErrorCode: last.error ?? null,
    fatal: result.fatal ?? null,
    errors: (result.errors ?? []).slice(0, 5),
    networkFailures: [...hostile].slice(0, 5),
    verdict:
      result.fatal != null
        ? 'not-observable'
        : runLast !== null && (runLast.currentTime ?? 0) > 0 && (last.width ?? 0) > 0
          ? 'played-via-hlsjs'
          : 'no-frames',
  });
  await page.close();
}

await browser.close();
server.close();

const played = results.filter((r) => r.verdict === 'played-via-hlsjs').length;

console.log(
  JSON.stringify(
    {
      tool: 'evidence/02e/hls-comparison.mjs',
      generatedAt: new Date().toISOString(),
      engine: 'hls.js (the build shipped in apps/frontend/node_modules)',
      note:
        'The path our app actually uses in Chromium. Chromium\'s own <video> cannot demux ' +
        'MPEG-TS, so the native check is reported separately and is not our path.',
      summary: {
        sources: results.length,
        played,
        notPlayed: results.length - played,
        verdicts: [...new Set(results.map((r) => r.verdict))],
      },
      results,
    },
    null,
    2,
  ),
);

/*
 * Exit non-zero when any source did not play. Previously this script exited 0
 * regardless, so a live stream that happened to yield no frames silently
 * produced a "successful" run — a review re-run saw `no-frames` on 1 of 2
 * attempts and the committed evidence still looked green. A measurement tool
 * that cannot fail is not a measurement. Live streams ARE variable; that is
 * exactly why a partial result must surface as a failure rather than vanish.
 */
if (played !== results.length) {
  console.error(`hls-comparison: ${played}/${results.length} played — not every source produced frames`);
  process.exit(1);
}
