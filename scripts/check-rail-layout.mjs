/**
 * Measures the catalogue rail as a person sees it: does anything overlap, is the
 * control box taller than its space, and is the pager reachable?
 */
import { chromium } from '../apps/frontend/node_modules/playwright/index.mjs';

const WEB = process.env.WEB_BASE_URL ?? 'http://127.0.0.1:4200';
const browser = await chromium.launch({ channel: 'chromium' });

for (const viewport of [
  { width: 397, height: 863, label: 'movil-captura' },
  { width: 1440, height: 900, label: 'escritorio' },
]) {
  const page = await (await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })).newPage();
  await page.goto(`${WEB}/television`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('ul.rail__grid:not([aria-busy])', { timeout: 240_000 }).catch(() => undefined);

  const report = await page.evaluate(() => {
    const box = (selector) => {
      const node = document.querySelector(selector);
      if (node === null) return null;
      const rect = node.getBoundingClientRect();
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height), width: Math.round(rect.width) };
    };
    /* Any two control boxes that overlap horizontally AND vertically are broken. */
    const selects = [...document.querySelectorAll('.rail__select')].map((node) => {
      const rect = node.getBoundingClientRect();
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) };
    });
    let overlaps = 0;
    for (let i = 0; i < selects.length; i += 1) {
      for (let j = i + 1; j < selects.length; j += 1) {
        const a = selects[i];
        const b = selects[j];
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps += 1;
      }
    }
    const pager = document.querySelector('.rail__pager');
    const pagerRect = pager === null ? null : pager.getBoundingClientRect();
    return {
      viewportHeight: window.innerHeight,
      controls: box('.rail__controls'),
      selects,
      overlappingPairs: overlaps,
      pager: pagerRect === null ? null : { top: Math.round(pagerRect.top), bottom: Math.round(pagerRect.bottom), visible: pagerRect.bottom <= window.innerHeight + 1 },
      pagerText: pager?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  console.log(viewport.label, JSON.stringify(report));
  await page.screenshot({ path: `C:/Users/Admin/Documents/workspace/streaming/tmp-rail-${viewport.label}.png`, fullPage: false });
  await page.close();
}
await browser.close();
