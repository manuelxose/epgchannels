import { test, expect } from '@playwright/test';
import { stubData } from './helpers';
import { stubYoutube, youtubeCatalogue } from './youtube-helpers';

/**
 * The YouTube engine must be LAZY: opening the catalogue or an HLS channel may
 * not download the engine's code; opening a YouTube channel must.
 *
 * `dist` chunk composition is asserted once by a script (see docs): this test
 * asserts the runtime behaviour, which is what a user experiences.
 */
test('abrir una fuente de YouTube descarga código que el catálogo no descarga', async ({ page }) => {
  await stubData(page, { catalog: youtubeCatalogue() });
  await stubYoutube(page);

  const requested = new Set<string>();
  page.on('request', (request) => {
    const url = request.url();
    if (url.endsWith('.js')) requested.add(url.split('/').pop() ?? '');
  });

  await page.goto('/television');
  await expect(page.locator('app-channel-tile').first()).toBeVisible();
  await page.waitForTimeout(800);
  const atCatalogue = new Set(requested);

  await page.goto('/television/youtube-directo');
  await page.getByTestId('yt-engine-shell').waitFor({ state: 'visible' });
  await page.waitForTimeout(800);

  const newChunks = [...requested].filter((name) => !atCatalogue.has(name));
  // Opening YouTube must pull additional code (the engine + the watch feature).
  expect(newChunks.length, 'el motor debe llegar con la ficha, no con la app').toBeGreaterThan(0);
});
