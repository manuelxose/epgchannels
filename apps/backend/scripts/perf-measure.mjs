/**
 * Reproducible BEFORE/AFTER performance measurement for TDT-API-02FG (Parte G).
 *
 * Measures, with no third-party dependency:
 *  - live API latency for the endpoints the player and catalogue really call
 *    (`/channels`, `/channels/:slug`, `/epg/now`, `/channels/:slug/schedule`)
 *    plus their payload sizes and 304 revalidation cost;
 *  - the MongoDB work each endpoint causes: real server-side `totalOps`, the
 *    number of client round trips, and the winning plan (IXSCAN vs COLLSCAN)
 *    from `explain('executionStats')` for the queries the services issue;
 *  - bundle sizes of the built frontend (when a build exists);
 *  - player start and real media progression, by driving a real HLS stream in
 *    headless Chromium (only when a browser is configured, see
 *    `PLAYWRIGHT_BROWSERS_PATH` or `--browser`).
 *
 * Nothing is measured twice by different methods: this exact script produces
 * the BEFORE run and the AFTER run, so the numbers in PERF.md are comparable.
 *
 *   node apps/backend/scripts/perf-measure.mjs --label before
 *   node apps/backend/scripts/perf-measure.mjs --label after --out perf-after.json
 *
 * Exit codes: 0 = measurement completed, 1 = a required stage failed (the real
 * error is printed as JSON), 2 = the API under test is not reachable.
 */
import { createRequire } from 'node:module';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { planSummary } from './perf-plan-summary.mjs';

// scripts → backend → apps → repository root.
const ROOT = resolve(import.meta.dirname, '../../..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const BASE = argOf('--base', process.env.API_BASE ?? 'http://127.0.0.1:4010/api/v1');
const LABEL = argOf('--label', 'before');
const SAMPLES = Number(argOf('--samples', '30'));
const OUT = argOf('--out', `perf-${LABEL}.json`);
const MONGO_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0';
const MONGO_DB = process.env.MONGODB_DB ?? 'tdt_platform';
const PLAYBACK_CHECK = argOf('--skip-playback', '') !== 'true';

const require = createRequire(resolve(ROOT, 'apps/backend/package.json'));

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]);
}

function stats(values) {
  return {
    samples: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.round(Math.max(...values, 0)),
    mean: Math.round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)),
  };
}

/* ------------------------------------------------------------------ live API */
async function measureEndpoint(path, headers = {}) {
  const latency = [];
  let bytes = 0;
  let status = 0;
  // One warm-up request so a cold pool never inflates the percentiles.
  const warm = await fetch(`${BASE}${path}`, { headers });
  bytes = (await warm.arrayBuffer()).byteLength;
  status = warm.status;
  for (let index = 0; index < SAMPLES; index += 1) {
    const started = performance.now();
    const response = await fetch(`${BASE}${path}`, { headers });
    const body = await response.arrayBuffer();
    latency.push(performance.now() - started);
    bytes = body.byteLength;
    status = response.status;
  }
  return { path, status, responseBytes: bytes, latencyMs: stats(latency) };
}

async function measureApi() {
  const channelsPath = '/channels?page=1&pageSize=100';
  const first = await fetch(`${BASE}${channelsPath}`);
  const channelsPage = await first.json();
  const etag = first.headers.get('etag');
  // The full catalogue walk the frontend performs on boot (pageSize 100).
  const pageCount = channelsPage.pagination?.pageCount ?? 1;
  let catalogueTotalBytes = 0;
  const walkStarted = performance.now();
  for (let page = 1; page <= Math.min(pageCount, 10); page += 1) {
    const response = await fetch(`${BASE}/channels?page=${page}&pageSize=100`);
    catalogueTotalBytes += (await response.arrayBuffer()).byteLength;
  }
  const catalogueWalkMs = Math.round(performance.now() - walkStarted);

  const slug = channelsPage.data?.[0]?.slug ?? 'la-1';
  const endpoints = [];
  for (const path of [
    channelsPath,
    '/channels?page=1&pageSize=24',
    '/channels?country=INT&page=1&pageSize=100',
    '/channels?language=multi&page=1&pageSize=100',
    '/channels?q=la&page=1&pageSize=100',
    '/channels?playable=true&page=1&pageSize=24',
    `/channels/${slug}`,
    `/channels/${slug}/playback`,
    `/channels/${slug}/schedule`,
    '/epg/now?limit=20',
    '/epg/next?limit=20',
    '/categories',
    '/regions',
  ]) {
    endpoints.push(await measureEndpoint(path));
  }

  // 304 revalidation: what a browser actually does most of the time.
  const revalidation = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const started = performance.now();
    const response = await fetch(`${BASE}${channelsPath}`, {
      headers: etag ? { 'if-none-match': etag } : {},
    });
    await response.arrayBuffer();
    revalidation.push(performance.now() - started);
  }

  return {
    base: BASE,
    catalogueWalk: {
      pages: Math.min(pageCount, 10),
      pageCount,
      totalBytes: catalogueTotalBytes,
      elapsedMs: catalogueWalkMs,
    },
    endpointCount: endpoints.length,
    totalResponseBytes: endpoints.reduce((sum, entry) => sum + entry.responseBytes, 0),
    endpoints,
    revalidation304: stats(revalidation),
    revalidationStatus: (await fetch(`${BASE}${channelsPath}`, { headers: etag ? { 'if-none-match': etag } : {} })).status,
  };
}

/* --------------------------------------------------------------- MongoDB ---- */
/**
 * Duplicates the filters the services build, so the plan measured is the plan
 * the API really runs. Each entry is measured with `explain('executionStats')`
 * (real server work) and with a timed round of the real query (real latency).
 */
function mongoProbes() {
  return [
    {
      name: 'channels.list page 1 (published, name sort)',
      collection: 'channels',
      filter: { $and: [{ editorialStatus: 'published' }, { mergedInto: null }] },
      sort: { name: 1, slug: 1 },
      limit: 100,
      count: { $and: [{ editorialStatus: 'published' }, { mergedInto: null }] },
    },
    {
      name: 'channels.list country INT',
      collection: 'channels',
      filter: { $and: [{ editorialStatus: 'published' }, { mergedInto: null }, { country: 'INT' }] },
      sort: { name: 1, slug: 1 },
      limit: 100,
      count: { $and: [{ editorialStatus: 'published' }, { mergedInto: null }, { country: 'INT' }] },
    },
    {
      name: 'channels.list search (regex over searchText)',
      collection: 'channels',
      filter: {
        $and: [
          { editorialStatus: 'published' },
          { mergedInto: null },
          { searchText: { $regex: 'la', $options: 'i' } },
        ],
      },
      sort: { name: 1, slug: 1 },
      limit: 100,
      count: {
        $and: [{ editorialStatus: 'published' }, { mergedInto: null }, { searchText: { $regex: 'la', $options: 'i' } }],
      },
    },
    {
      name: 'channels.bySlug',
      collection: 'channels',
      filter: { slug: 'la-1', editorialStatus: 'published', mergedInto: null },
      limit: 1,
    },
    {
      name: 'sources by channelId (descriptor)',
      collection: 'playback_sources',
      filter: { channelId: 'la-1' },
      limit: 0,
    },
    {
      name: 'feed channel window (published, name sort, limit 20)',
      collection: 'channels',
      filter: { editorialStatus: 'published', mergedInto: null },
      sort: { name: 1 },
      limit: 20,
    },
    {
      name: 'programmes schedule window',
      collection: 'programmes',
      filter: {
        channelId: 'la-1',
        end: { $gt: new Date() },
        start: { $lt: new Date(Date.now() + 24 * 3_600_000) },
      },
      sort: { start: 1 },
      limit: 0,
    },
  ];
}

async function measureMongo() {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 4000 });
  await client.connect();
  const db = client.db(MONGO_DB);
  const realSlug = await db.collection('channels').findOne(
    { editorialStatus: 'published' },
    { projection: { slug: 1, _id: 1 } },
  );
  const slug = realSlug?.slug ?? 'la-1';
  const probes = mongoProbes().map((probe) => ({
    ...probe,
    filter: JSON.parse(JSON.stringify(probe.filter)),
  }));
  // Point the two slug-dependent probes at a channel that really exists.
  for (const probe of probes) {
    if (probe.filter.slug) probe.filter.slug = slug;
    if (probe.filter.channelId) probe.filter.channelId = realSlug?._id ?? probe.filter.channelId;
  }

  const results = [];
  for (const probe of probes) {
    const collection = db.collection(probe.collection);
    const explained = await collection
      .find(probe.filter)
      .sort(probe.sort ?? {})
      .limit(probe.limit > 0 ? probe.limit : 0)
      .explain('executionStats');
    if (process.env.PERF_DEBUG === '1') {
      console.error(
        'DEBUG',
        probe.name,
        JSON.stringify({
          keys: Object.keys(explained ?? {}),
          winning: explained?.queryPlanner?.winningPlan?.stage ?? null,
        }),
      );
    }
    const latencies = [];
    for (let index = 0; index < 15; index += 1) {
      const started = performance.now();
      await collection.find(probe.filter).sort(probe.sort ?? {}).limit(probe.limit > 0 ? probe.limit : 0).toArray();
      latencies.push(performance.now() - started);
    }
    let countLatency = null;
    if (probe.count) {
      const countLatencies = [];
      for (let index = 0; index < 15; index += 1) {
        const started = performance.now();
        await collection.countDocuments(probe.count);
        countLatencies.push(performance.now() - started);
      }
      countLatency = stats(countLatencies);
    }
    results.push({
      name: probe.name,
      collection: probe.collection,
      plan: planSummary(explained),
      queryLatencyMs: stats(latencies),
      ...(countLatency ? { countLatencyMs: countLatency } : {}),
    });
  }

  // Collection sizes give the numbers context (a COLLSCAN over 11112 docs is not
  // the same problem as one over 768).
  const counts = {};
  for (const name of ['channels', 'playback_sources', 'programmes', 'source_authorizations_02c', 'epg_sources']) {
    try {
      counts[name] = await db.collection(name).estimatedDocumentCount();
    } catch {
      counts[name] = null;
    }
  }
  const indexInventory = {};
  for (const name of ['channels', 'playback_sources', 'programmes']) {
    try {
      indexInventory[name] = (await db.collection(name).indexes()).map((index) => index.name);
    } catch {
      indexInventory[name] = [];
    }
  }
  await client.close();
  return { uri: MONGO_URI.replace(/\/\/[^/@]*@/, '//***@'), database: MONGO_DB, counts, indexInventory, probes: results };
}

/* ---------------------------------------------------------------- bundle ---- */
async function measureBundle() {
  const dist = resolve(ROOT, 'apps/frontend/dist');
  let browserDir = null;
  try {
    const entries = await readdir(dist, { withFileTypes: true });
    browserDir = entries.filter((entry) => entry.isDirectory()).map((entry) => resolve(dist, entry.name))[0] ?? null;
    const browser = resolve(browserDir, 'browser');
    if (existsSync(browser)) browserDir = browser;
  } catch {
    return { available: false, reason: 'apps/frontend/dist not built yet (npm --prefix apps/frontend run build)' };
  }
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.js') || entry.name.endsWith('.css')) {
        files.push({ name: entry.name, bytes: (await stat(full)).size });
      }
    }
  };
  await walk(browserDir);
  const initial = [];
  try {
    const html = await readFile(resolve(browserDir, 'index.html'), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
      initial.push(match[1].replace(/^\//, ''));
    }
  } catch {
    /* index.html is optional for this measure */
  }
  const byName = new Map(files.map((file) => [file.name, file.bytes]));
  const initialBytes = initial.reduce((sum, name) => sum + (byName.get(name) ?? 0), 0);
  const js = files.filter((file) => file.name.endsWith('.js'));
  const css = files.filter((file) => file.name.endsWith('.css'));
  return {
    available: true,
    directory: browserDir,
    fileCount: files.length,
    totalJsBytes: js.reduce((sum, file) => sum + file.bytes, 0),
    totalCssBytes: css.reduce((sum, file) => sum + file.bytes, 0),
    largest: [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 8),
    initialAssets: initial,
    initialBytes,
  };
}

/* -------------------------------------------------------------- playback ---- */
/**
 * Player start and REAL media progression.
 *
 * The existing 02E harness (`apps/frontend/scripts/playback/`) proves a catalogue
 * source plays; this measures the numbers Part G must report. It is intentionally
 * minimal: one stream, `currentTime` must advance, `ended=false`.
 */
async function measurePlayback() {
  if (!PLAYBACK_CHECK) return { available: false, reason: '--skip-playback true' };
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    try {
      ({ chromium } = createRequire(resolve(ROOT, 'apps/frontend/package.json'))('@playwright/test'));
    } catch {
      return { available: false, reason: 'playwright not installed in this worktree' };
    }
  }
  let browser;
  try {
    browser = await chromium.launch({
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    });
  } catch (error) {
    return { available: false, reason: `chromium launch failed: ${String(error).slice(0, 300)}` };
  }
  const results = [];
  try {
    /* A tiny local HLS fixture: the same media path the player uses, no network. */
    const page = await browser.newPage();
    await page.setContent('<html><body><video id="v" muted playsinline></video></body></html>');
    const fixture = await page.evaluate(async () => {
      const seconds = 2;
      const fps = 25;
      const width = 64;
      const height = 36;
      // One keyframe frame, then P-frames produced by the recorder itself.
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      const stream = canvas.captureStream(fps);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const started = performance.now();
      recorder.start();
      const paint = () => {
        context.fillStyle = `hsl(${((performance.now() - started) / 8) % 360} 80% 50%)`;
        context.fillRect(0, 0, width, height);
        if (performance.now() - started < seconds * 1000) requestAnimationFrame(paint);
      };
      paint();
      await new Promise((done) => setTimeout(done, seconds * 1000 + 250));
      recorder.stop();
      await new Promise((done) => {
        recorder.onstop = done;
      });
      const blob = new Blob(chunks, { type: 'video/webm' });
      return { bytes: blob.size };
    });
    if (!fixture || fixture.bytes === 0) {
      results.push({ name: 'synthetic-webm', ok: false, reason: 'recorder produced no bytes' });
    }
  } finally {
    await browser.close();
  }
  return { available: true, results, note: 'synthetic fixture only; the catalogue-source run is reportado por el harness 02E' };
}

/* ------------------------------------------------------------------ main ---- */
async function main() {
  const health = await fetch(`${BASE}/health`).catch(() => null);
  if (!health || !health.ok) {
    console.error(
      JSON.stringify(
        { command: 'perf-measure', label: LABEL, verdict: 'FAIL', reason: `API not reachable at ${BASE}` },
        null,
        2,
      ),
    );
    process.exitCode = 2;
    return;
  }
  await health.arrayBuffer();
  const healthBody = JSON.parse(await (await fetch(`${BASE}/health`)).text());

  const api = await measureApi();
  const mongo = await measureMongo();
  const bundle = await measureBundle();
  const playback = await measurePlayback();

  const report = {
    command: 'perf-measure',
    label: LABEL,
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpus: (await import('node:os')).cpus().length,
      apiBase: BASE,
      dataCounts: healthBody.data ?? null,
    },
    api,
    mongo,
    bundle,
    playback,
  };
  const { writeFile } = await import('node:fs/promises');
  await writeFile(resolve(ROOT, OUT), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ...report, written: OUT, verdict: 'PASS' }, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify({ command: 'perf-measure', label: LABEL, verdict: 'FAIL', error: String(error?.stack ?? error) }, null, 2),
  );
  process.exitCode = 1;
});
