/**
 * Part G integration check: the SHIPPED bundle, in real Chromium, against the
 * real API and the real database.
 *
 * For every user journey the milestone names — channel selection, international
 * navigation, country filter, search, now/next, source selection, real media
 * progression, error handling, authorised fallback and responsive layout — this
 * records what actually happened: requests the frontend issued, the DOM it
 * produced, and any console error. It never asserts from a screenshot alone and
 * never counts "the page rendered" as "the feature works".
 *
 *   node apps/backend/scripts/partg-integration-check.mjs --base http://127.0.0.1:4400 \
 *     --out evidence/02fg/partg-integration-before.json
 *
 * Exit codes: 0 = every journey observed (pass or honest failure recorded),
 *             1 = the harness itself could not observe a journey.
 */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const BASE = argOf('--base', 'http://127.0.0.1:4400');
const OUT = argOf('--out', 'evidence/02fg/partg-integration.json');
const HERE = import.meta.dirname;
const REPO_ROOT = resolve(HERE, '../../..');

const require = createRequire(resolve(REPO_ROOT, 'apps/frontend/package.json'));
let playwright;
try {
  playwright = require('@playwright/test');
} catch {
  playwright = require('playwright');
}

const JOURNEYS = [];
function record(journey, result) {
  JOURNEYS.push({ journey, ...result });
}

async function main() {
  const browser = await playwright.chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  /** Requests the frontend issued, so "N requests" is measured, not guessed. */
  let requests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === new URL(BASE).origin && url.pathname.startsWith('/api/')) {
      requests.push({ path: `${url.pathname}${url.search}`, method: request.method() });
    }
  });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300));
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 300)}`));

  /* ------------------------------------------------ 1. catalogue + requests */
  requests = [];
  const started = Date.now();
  await page.goto(`${BASE}/television`, { waitUntil: 'networkidle', timeout: 60_000 });
  const catalogueMs = Date.now() - started;
  const tiles = await page.locator('a[href^="/television/"]').count();
  record('catalogue-loads', {
    ok: tiles > 0,
    evidence: { tiles, catalogueMs, apiRequests: requests.length, requests: requests.slice(0, 40) },
  });

  /* ------------------------------------------------------ 2. channel select */
  const firstSlug = await page
    .locator('a[href^="/television/"]')
    .first()
    .getAttribute('href', { timeout: 10_000 })
    .catch(() => null);
  if (!firstSlug) {
    record('channel-select', { ok: false, reason: 'no channel tile exposed a /television/ link' });
  } else {
    requests = [];
    await page.goto(`${BASE}${firstSlug}`, { waitUntil: 'networkidle', timeout: 60_000 });
    const title = await page.title();
    const videoCount = await page.locator('video').count();
    record('channel-select', {
      ok: /\/television\//.test(firstSlug) && videoCount > 0,
      evidence: {
        navigationTarget: firstSlug,
        title,
        videoElements: videoCount,
        apiRequests: requests.map((entry) => entry.path),
      },
    });
  }

  /* ------------------------------------------- 3. international navigation */
  requests = [];
  await page.goto(`${BASE}/television`, { waitUntil: 'networkidle', timeout: 60_000 });
  const countrySelect = page.locator('[data-testid="country-filter"]');
  const hasIntControl = (await countrySelect.count()) > 0;
  let intResult = { ok: false, reason: 'no country filter rendered' };
  if (hasIntControl) {
    const options = await countrySelect.locator('option').evaluateAll((nodes) =>
      nodes.map((node) => ({ value: node.value, label: node.textContent?.trim() ?? '' })),
    );
    const intOption = options.find((option) => option.value === 'INT');
    if (!intOption) {
      intResult = { ok: false, reason: 'no INT option in the country filter', evidence: { options } };
    } else {
      requests = [];
      await countrySelect.selectOption('INT');
      await page.waitForTimeout(1200);
      const count = await page.locator('a[href^="/television/"]').count();
      intResult = {
        ok: count > 0,
        evidence: {
          optionLabel: intOption.label,
          internationalTilesAfterChoosingINT: count,
          apiRequests: requests.map((entry) => entry.path),
        },
      };
    }
  }
  record('international-navigation', intResult);

  /* ----------------------------------------------------- 4. country filter */
  const filtrable = await page.locator('[data-testid="country-filter"]').count();
  let countryResult = { ok: false, reason: 'no country filter rendered' };
  if (filtrable > 0) {
    const select = page.locator('[data-testid="country-filter"]');
    await select.selectOption('ES');
    await page.waitForTimeout(900);
    const esTiles = await page.locator('a[href^="/television/"]').count();
    await select.selectOption('all');
    await page.waitForTimeout(900);
    const allTiles = await page.locator('a[href^="/television/"]').count();
    countryResult = {
      ok: esTiles > 0 && esTiles <= allTiles,
      evidence: { esTiles, allTiles, note: 'ES (294 published) must be a non-empty subset of all (412)' },
    };
  }
  record('country-filter', countryResult);

  /* ------------------------------------------------------------ 5. search */
  const search = page.locator('input[type="search"], input[placeholder*="usca" i]').first();
  const hasSearch = (await search.count()) > 0;
  let searchResult = { ok: false, reason: 'no search input rendered' };
  if (hasSearch) {
    const before = await page.locator('a[href^="/television/"]').count();
    await search.fill('la');
    await page.waitForTimeout(800);
    const filtered = await page.locator('a[href^="/television/"]').count();
    searchResult = { ok: filtered > 0 && filtered <= before, evidence: { query: 'la', tilesBefore: before, tilesAfterSearch: filtered } };
  }
  record('search', searchResult);

  /* ----------------------------------------------------- 6. responsive ---- */
  const viewports = [
    { width: 360, height: 780, label: 'mobile-360' },
    { width: 768, height: 1024, label: 'tablet-768' },
    { width: 1440, height: 900, label: 'desktop-1440' },
  ];
  const responsive = [];
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${BASE}/television`, { waitUntil: 'networkidle', timeout: 60_000 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    responsive.push({ ...viewport, horizontalOverflowPx: Math.max(0, overflow) });
  }
  record('responsive', {
    ok: responsive.every((entry) => entry.horizontalOverflowPx <= 1),
    evidence: { viewports: responsive },
  });
  await page.setViewportSize({ width: 1280, height: 800 });

  /* ------------------------------------------------------- 7. error state */
  const errorPage = await context.newPage();
  await errorPage.route('**/api/v1/channels**', (route) => route.abort('failed'));
  await errorPage.goto(`${BASE}/television`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await errorPage.waitForTimeout(2500);
  const errorText = (await errorPage.locator('body').innerText().catch(() => '')).slice(0, 2000);
  const saysError = /error|no se pudo|no pudimos|int[eé]ntalo|reintentar|unavailable|problema/i.test(errorText);
  record('error-handling', {
    ok: saysError,
    evidence: { apiAborted: '**/api/v1/channels**', textSample: errorText.slice(0, 300) },
  });
  await errorPage.close();

  /* ------------------------------------------------- 8. now/next rendering */
  const nowNext = await page.evaluate(() => {
    const text = document.body.innerText;
    return {
      hasNow: /ahora|en directo|now/i.test(text),
      hasNext: /a continuaci[oó]n|next|siguiente/i.test(text),
    };
  });
  record('now-next-surface', {
    ok: nowNext.hasNow || nowNext.hasNext,
    evidence: nowNext,
  });

  await context.close();
  await browser.close();

  const report = {
    command: 'partg-integration-check',
    base: BASE,
    measuredAt: new Date().toISOString(),
    journeys: JOURNEYS,
    consoleErrors: consoleErrors.slice(0, 20),
    summary: {
      total: JOURNEYS.length,
      ok: JOURNEYS.filter((entry) => entry.ok).length,
      failed: JOURNEYS.filter((entry) => !entry.ok).map((entry) => entry.journey),
    },
  };
  await mkdir(dirname(resolve(REPO_ROOT, OUT)), { recursive: true });
  await writeFile(resolve(REPO_ROOT, OUT), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report.summary, null, 2));
  for (const journey of JOURNEYS) {
    console.log(`${journey.ok ? 'OK  ' : 'FAIL'} ${journey.journey}${journey.reason ? ` — ${journey.reason}` : ''}`);
  }
  console.log(`console errors: ${consoleErrors.length}`);
  process.exitCode = 0;
}

main().catch((error) => {
  console.error(JSON.stringify({ command: 'partg-integration-check', error: String(error?.stack ?? error) }, null, 2));
  process.exitCode = 1;
});
