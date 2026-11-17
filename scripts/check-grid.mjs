/** Waits for the real grid (not the skeletons) and counts what a person sees. */
import { chromium } from '../apps/frontend/node_modules/playwright/index.mjs';

const WEB = process.env.WEB_BASE_URL ?? 'http://127.0.0.1:4200';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const t0 = Date.now();
await page.goto(`${WEB}/television`, { waitUntil: 'domcontentloaded' });
/* Skeleton list carries aria-busy; the real grid does not. */
await page.waitForSelector('ul.rail__grid:not([aria-busy])', { timeout: 240_000 }).catch(() => undefined);
const readyMs = Date.now() - t0;
const snapshot = async (label) =>
  page.evaluate((tag) => ({
    label: tag,
    tiles: document.querySelectorAll('ul.rail__grid:not([aria-busy]) li').length,
    links: document.querySelectorAll('a[href^="/television/"]').length,
    counter: (document.body.innerText.match(/Mostrando[^\n]*|[\d.]+ resultados/i) ?? [''])[0],
    hints: [...document.querySelectorAll('.rail__select-hint')].map((node) => node.textContent?.trim() ?? ''),
  }), label);

console.log(JSON.stringify({ readyMs, first: await snapshot('sin filtros') }));

const country = page.locator('[data-testid="country-filter"]');
await country.selectOption(['ES', 'FR']);
await page.waitForTimeout(1500);
console.log(JSON.stringify(await snapshot('ES+FR')));

const categories = page.locator('[data-testid="category-filter"]');
await categories.selectOption(['generalista', 'deportes']);
await page.waitForTimeout(1500);
console.log(JSON.stringify(await snapshot('ES+FR & generalista+deportes')));

await page.locator('[data-testid="country-filter"]').selectOption([]);
await page.waitForTimeout(1000);
console.log(JSON.stringify(await snapshot('solo categorías')));
await page.screenshot({ path: 'C:/Users/Admin/Documents/workspace/streaming/tmp-catalog3.png' });
await browser.close();
