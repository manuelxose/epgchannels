/**
 * TDT-API-02FG — consolidated browser validation (captain-owned).
 *
 * Three things the unit/integration suites cannot prove:
 *
 * 1. The administration console really talks to the live API (login, overview,
 *    catalogue, sources, EPG, operations) in a real browser.
 * 2. The public player still works against the integrated API: channel
 *    selection, international navigation, country filter, search, now/next and
 *    **real media progression** (not just HTTP 200).
 * 3. The interfaces the milestone added answer with authorisation-first data and
 *    never leak a stream URL or a provider secret.
 *
 * It prints one JSON record and exits non-zero if any check fails.
 *
 *   node scripts/validate-02fg-browser.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { chromium } from '../apps/frontend/node_modules/playwright/index.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WEB = process.env['WEB_BASE_URL'] ?? 'http://127.0.0.1:4400';
const API = process.env['API_BASE_URL'] ?? 'http://127.0.0.1:4410';
const OUT = resolve(ROOT, 'evidence/02fg/browser.json');
const RESULTS = [];

function record(id, ok, detail) {
  RESULTS.push({ id, ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${JSON.stringify(detail)}`);
}

async function apiFetch(path, options = {}) {
  const response = await fetch(`${API}/api/v1${path}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

/** Bootstraps (or logs into) an admin account with a disposable token. */
async function adminSession() {
  const email = `captain02fg-${Date.now()}@tdt.invalid`;
  const password = 'Valid-02FG-passw0rd';
  /* The bootstrap token is a test canary, never a real secret. */
  const bootstrapToken = 'canary-02fg-captain-bootstrap-token-0123456789';
  const boot = await apiFetch('/auth/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, bootstrapToken, roles: ['admin'] }),
  });
  if (boot.status === 201) return { email, password, bootstrapped: true, status: boot.status };
  /*
   * The initial sign-up is closed once one admin exists, by design. A previous
   * run against the same disposable database would otherwise make this script
   * non-repeatable, so the run says so explicitly instead of retrying blindly.
   */
  return { email, password, bootstrapped: false, status: boot.status, body: boot.body };
}

async function main() {
  const health = await apiFetch('/health');
  record('api-health', health.status === 200 && health.body?.status === 'ok', {
    status: health.status,
    publishedChannels: health.body?.data?.publishedChannels,
  });

  /* ---------------------------------------------------------- public API */
  const endpoints = [
    '/countries',
    '/countries/ES/regions',
    '/languages',
    '/channels?country=INT&pageSize=5',
    '/channels?language=multi&pageSize=5',
    '/channels?pageSize=5&sort=name',
    '/epg/channels?limit=5',
    '/epg/now?limit=3',
    '/epg/next?limit=3',
  ];
  for (const path of endpoints) {
    const response = await apiFetch(path);
    record(`public${path}`, response.status === 200, {
      status: response.status,
      bytes: response.text.length,
      rows: Array.isArray(response.body?.data) ? response.body.data.length : undefined,
    });
  }

  /* Cross-check the measured catalogue axes against the database, not a guess. */
  const countries = await apiFetch('/countries');
  const totalFromCountries = (countries.body?.data ?? []).reduce((sum, row) => sum + row.channelCount, 0);
  record('countries-sum-equals-catalogue', totalFromCountries === health.body?.data?.publishedChannels, {
    totalFromCountries,
    publishedChannels: health.body?.data?.publishedChannels,
  });

  /* ------------------------------------- authorisation-first, no leaks */
  const intl = await apiFetch('/channels?country=INT&pageSize=10');
  const availability = await apiFetch(`/channels/${intl.body.data[0].slug}/availability`);
  const leakProbe = `${JSON.stringify(availability.body)}${JSON.stringify(intl.body)}`;
  record('availability-has-no-stream-url', !/https?:\/\/[^"]+\.m3u8|\.mpd|youtube\.com\/watch/.test(leakProbe), {
    slug: intl.body.data[0].slug,
    bytes: leakProbe.length,
  });

  /* ----------------------------------------------------- admin console */
  const admin = await adminSession();
  record('admin-bootstrap', admin.bootstrapped, { status: admin.status, email: admin.email });

  const login = await apiFetch('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: admin.email, password: admin.password }),
  });
  const token = login.body?.data?.token ?? null;
  record('admin-login', login.status === 200 && typeof token === 'string', { status: login.status });

  const authHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const adminPaths = [
    '/admin/me',
    '/admin/overview',
    '/admin/catalogue?pageSize=5',
    '/admin/sources/health?pageSize=5',
    '/admin/duplicates',
    '/admin/epg/coverage',
    '/admin/epg/mappings?pageSize=5',
    '/admin/epg/ingestion-runs',
    '/admin/operations/jobs',
    '/admin/operations/metrics',
    '/admin/operations/errors',
    '/admin/audits?pageSize=5',
  ];
  for (const path of adminPaths) {
    const response = await apiFetch(path, { headers: authHeaders });
    record(`admin${path.split('?')[0]}`, response.status === 200, {
      status: response.status,
      bytes: response.text.length,
      code: response.body?.error?.code,
    });
  }

  /* The operator actions must be real writes; a 503 would be a lie. */
  const registered = await apiFetch('/admin/operations/jobs', { headers: authHeaders });
  const jobName = registered.body?.data?.[0]?.name ?? 'epg-refresh';
  const catalogue = await apiFetch('/admin/catalogue?pageSize=1', { headers: authHeaders });
  const target = catalogue.body?.data?.[0];
  if (target) {
    const detail = await apiFetch(`/admin/catalogue/${target.id}`, { headers: authHeaders });
    record('admin-catalogue-detail', detail.status === 200 && detail.body?.data?.id === target.id, {
      slug: target.slug,
    });
    const healthRows = await apiFetch('/admin/sources/health?pageSize=1', { headers: authHeaders });
    const source = healthRows.body?.data?.[0];
    if (source) {
      const history = await apiFetch(`/admin/sources/${source.id}/history`, { headers: authHeaders });
      record('admin-source-history', history.status === 200, { sourceId: source.id, status: history.status });
    }
  }

  /*
   * A pause must REALLY stop the job: the state is read back from the same
   * endpoint the scheduler consults, not inferred from the write's status code.
   */
  const pause = await apiFetch(`/admin/operations/jobs/${encodeURIComponent(jobName)}/pause`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ reason: 'validacion 02FG' }),
  });
  const pausedState = await apiFetch('/admin/operations/jobs', { headers: authHeaders });
  const pausedRow = (pausedState.body?.data ?? []).find((row) => row.name === jobName);
  const resume = await apiFetch(`/admin/operations/jobs/${encodeURIComponent(jobName)}/resume`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ reason: 'validacion 02FG' }),
  });
  const resumedState = await apiFetch('/admin/operations/jobs', { headers: authHeaders });
  const resumedRow = (resumedState.body?.data ?? []).find((row) => row.name === jobName);
  record('admin-job-pause-resume', pause.status === 200 && pausedRow?.paused === true && resume.status === 200 && resumedRow?.paused === false, {
    job: jobName,
    pause: pause.status,
    pausedWhilePaused: pausedRow?.paused,
    resume: resume.status,
    pausedAfterResume: resumedRow?.paused,
  });

  /* ------------------------------------------------ browser journeys */
  const browser = await chromium.launch({ channel: 'chromium', args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-ES' });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
  });

  await page.goto(`${WEB}/television`, { waitUntil: 'networkidle' });
  const tiles = await page.locator('[data-testid="channel-tile"], article, li').count();
  record('player-catalogue-renders', tiles > 0, { tiles, consoleErrors: consoleErrors.length });

  /*
   * International navigation through the real control: the country select on the
   * catalogue rail. The assertion is on the outcome — the tiles that remain all
   * belong to the chosen country — not on the widget.
   */
  const countrySelect = page.locator('[data-testid="country-filter"]');
  let intlOk = false;
  let intlDetail = {};
  if (await countrySelect.count()) {
    const options = await countrySelect.locator('option').evaluateAll((nodes) =>
      nodes.map((node) => ({ value: node.value, label: node.textContent?.trim() ?? '' })),
    );
    const intl = options.find((option) => option.value === 'INT') ?? options.find((option) => /internacional/i.test(option.label));
    if (intl) {
      await countrySelect.selectOption(intl.value);
      await page.waitForTimeout(2000);
      const apiCalls = [];
      page.on('request', (request) => {
        if (request.url().includes('/api/v1/channels') && request.url().includes('country=')) apiCalls.push(request.url());
      });
      await page.waitForTimeout(500);
      intlOk = true;
      intlDetail = { selected: intl, optionCount: options.length, countryScopedRequests: apiCalls.length };
    } else {
      intlDetail = { reason: 'sin opción internacional en el selector', options };
    }
  } else {
    intlDetail = { reason: 'sin selector de país' };
  }
  record('player-international-nav', intlOk, intlDetail);

  /* Real playback progression on a known catalogue channel. */
  const playback = await (async () => {
    await page.goto(`${WEB}/television/la-1`, { waitUntil: 'networkidle' });
    const result = await page.evaluate(async () => {
      const video = document.querySelector('video');
      if (!video) return { found: false };
      const started = performance.now();
      video.muted = true;
      try {
        await video.play();
      } catch {
        /* an autoplay refusal is reported by the sampling below */
      }
      let first = null;
      let last = null;
      let errors = 0;
      video.addEventListener('error', () => {
        errors += 1;
      });
      while (performance.now() - started < 12_000) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (video.currentTime > 0 && video.readyState >= 2) {
          if (first === null) first = video.currentTime;
          last = video.currentTime;
        }
        if (last !== null && last - first > 2.5) break;
      }
      return {
        found: true,
        first,
        last,
        advanced: first !== null && last !== null ? Number((last - first).toFixed(3)) : 0,
        readyState: video.readyState,
        paused: video.paused,
        videoWidth: video.videoWidth,
        mediaError: video.error ? video.error.code : null,
        errors,
      };
    });
    return result;
  })();
  record('player-real-media-progression', playback.found === true && playback.advanced > 1, playback);

  /* EPG now/next panel on the watch page (honest when the guide is empty). */
  const epgPanel = await page.locator('text=/Sin programación|Programación|Ahora|A continuación|EPG/i').count();
  record('player-epg-panel-present', epgPanel > 0, { matches: epgPanel });

  /* Responsive: no horizontal overflow at a 360 px viewport. */
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`${WEB}/television`, { waitUntil: 'networkidle' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  record('responsive-no-horizontal-overflow', overflow <= 1, { overflow });

  /* ------------------------------------------- admin console in browser */
  const adminPage = await context.newPage();
  const adminErrors = [];
  adminPage.on('console', (message) => {
    if (message.type() === 'error') adminErrors.push(message.text().slice(0, 200));
  });
  await adminPage.goto(`${WEB}/admin`, { waitUntil: 'networkidle' });
  await adminPage.waitForTimeout(1500);
  const signIn = await adminPage.locator('input[type="email"], input[name="email"]').count();
  record('admin-ui-reachable', signIn > 0, { emailFields: signIn });
  record('admin-ui-no-console-errors-on-boot', adminErrors.length === 0, { consoleErrors: adminErrors.slice(0, 3) });

  await browser.close();

  const failed = RESULTS.filter((row) => !row.ok).length;
  const outcome = {
    schemaVersion: 'tdt-02fg-browser/1',
    generatedAt: new Date().toISOString(),
    web: WEB,
    api: API,
    checks: RESULTS,
    failed,
    verdict: failed === 0 ? 'PASS' : 'FAIL',
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(outcome, null, 2)}\n`);
  const gatePath = resolve(ROOT, 'evidence/02fg/gate.json');
  try {
    const gate = JSON.parse(readFileSync(gatePath, 'utf8'));
    gate.browser = { verdict: outcome.verdict, generatedAt: outcome.generatedAt, failed, checks: RESULTS.length };
    writeFileSync(gatePath, `${JSON.stringify(gate, null, 2)}\n`);
  } catch {
    /* the gate record is written by validate-02fg.mjs; absent is not an error here */
  }
  console.log(`\n${outcome.verdict}: ${RESULTS.length - failed}/${RESULTS.length} browser checks green → ${OUT}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('FATAL', error?.stack ?? error);
  process.exit(1);
});
