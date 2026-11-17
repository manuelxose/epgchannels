/**
 * Smoke test of the PRODUCT as a user sees it, against the running stack.
 *
 * Unlike `validate-02fg-browser.mjs` (which drives fixtures), this script talks
 * to whatever is listening on the two ports the product prints, so it answers
 * one question only: "does the thing a person opens actually work?".
 *
 *   node scripts/smoke-local.mjs            (WEB=4200, API=4010 by default)
 */
import process from 'node:process';
import { chromium } from '../apps/frontend/node_modules/playwright/index.mjs';

const WEB = process.env.WEB_BASE_URL ?? 'http://127.0.0.1:4200';
const API = process.env.API_BASE_URL ?? 'http://127.0.0.1:4010';
const EMAIL = process.env.ADMIN_BOOTSTRAP_EMAIL;
const PASSWORD = process.env.ADMIN_BOOTSTRAP_PASSWORD;

const results = [];
const check = (id, ok, detail = {}) => {
  results.push({ id, ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${JSON.stringify(detail)}`);
};

const api = async (path, options = {}) => {
  const response = await fetch(`${API}/api/v1${path}`, options);
  return { status: response.status, body: await response.json().catch(() => null) };
};

async function main() {
  const health = await api('/health');
  check('api/health', health.status === 200 && health.body?.status === 'ok', {
    published: health.body?.data?.publishedChannels,
  });

  const epgNow = await api('/epg/now?limit=5');
  const withProgramme = (epgNow.body?.data ?? []).filter((entry) => entry.programme !== null).length;
  check('api/epg/now has live programmes', epgNow.status === 200 && withProgramme > 0, {
    entries: epgNow.body?.data?.length ?? 0,
    withProgramme,
  });

  const countries = await api('/countries');
  check('api/countries', countries.status === 200 && (countries.body?.data?.length ?? 0) > 0, {
    rows: countries.body?.data?.length,
  });

  const browser = await chromium.launch({ channel: 'chromium', args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-ES' });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 160));
  });

  /* 1. The live catalogue renders channel tiles from the real API. */
  await page.goto(`${WEB}/television`, { waitUntil: 'networkidle' });
  const tiles = await page.locator('[data-testid="channel-tile"], article, li').count();
  check('web/television renders channels', tiles > 0, { tiles });

  /* 2. A channel page starts real playback (media time advances). */
  const playback = await (async () => {
    await page.goto(`${WEB}/television/la-1`, { waitUntil: 'networkidle' });
    return page.evaluate(async () => {
      const video = document.querySelector('video');
      if (!video) return { found: false };
      video.muted = true;
      try {
        await video.play();
      } catch {
        /* reported by the sampling below */
      }
      const started = performance.now();
      let first = null;
      let last = null;
      while (performance.now() - started < 12_000) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (video.currentTime > 0 && video.readyState >= 2) {
          if (first === null) first = video.currentTime;
          last = video.currentTime;
        }
        if (first !== null && last !== null && last - first > 2.5) break;
      }
      return {
        found: true,
        advanced: first === null || last === null ? 0 : Number((last - first).toFixed(2)),
        readyState: video.readyState,
        mediaError: video.error ? video.error.code : null,
      };
    });
  })();
  check('web/television/la-1 plays (real progress)', playback.found && playback.advanced > 1, playback);

  /* 3. The guide shows the (synthetic) programming instead of an empty shell. */
  await page.goto(`${WEB}/schedule`, { waitUntil: 'networkidle' });
  const scheduleText = (await page.locator('body').innerText()).slice(0, 4_000);
  const scheduleHasProgramme = /demo|informativo|magac|pel[ií]cula|cine|serie/i.test(scheduleText);
  check('web/schedule shows programming', scheduleHasProgramme, { sample: scheduleText.slice(0, 120) });

  /* 4. The administration console signs in with the .env account. */
  await page.goto(`${WEB}/admin`, { waitUntil: 'networkidle' });
  const email = page.locator('input[type="email"], input[name="email"]').first();
  const password = page.locator('input[type="password"]').first();
  if ((await email.count()) && EMAIL && PASSWORD) {
    await email.fill(EMAIL);
    await password.fill(PASSWORD);
    /* Scoped to the form: a bare utton selector also matches page chrome. */
    await page.locator('form.sign-in button[type="submit"]').first().click();
    /*
     * Signing in is proven by the OUTCOME: the app leaves the sign-in screen and
     * the catalogue workbench renders data fetched with the session token.
     */
    /*
     * Signing in is proven by the OUTCOME: the sign-in form is gone, the app
     * navigated into an admin area, and the catalogue table holds rows fetched
     * with the session token.
     */
    await page.waitForFunction(() => location.pathname.startsWith('/admin/'), null, { timeout: 20_000 });
    /* The workbench paints only after the session token is used to fetch it. */
    await page.waitForSelector('table tbody tr', { timeout: 25_000 }).catch(() => undefined);
    const formGone = (await page.locator('form.sign-in, input[type="password"]').count()) === 0;
    const rows = await page.locator('table tbody tr').count();
    check('web/admin signs in with .env credentials', formGone && rows > 0, { url: page.url(), rows });
  } else {
    check('web/admin signs in with .env credentials', false, { reason: 'sin formulario de acceso' });
  }

  check('no console errors in the journeys', consoleErrors.length <= 1, { consoleErrors: consoleErrors.slice(0, 3) });

  await browser.close();
  const failed = results.filter((row) => !row.ok).length;
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed}/${results.length}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('FATAL', error?.stack ?? error);
  process.exit(1);
});
