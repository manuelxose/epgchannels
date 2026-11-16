import { test, expect } from '@playwright/test';
import { stubApi } from './helpers';
import { stubYoutube, YOUTUBE_CHANNELS } from './youtube-helpers';

/**
 * The YouTube engine must be LAZY: opening the catalogue or an HLS channel may
 * not download the engine's code; opening a YouTube channel must.
 *
 * The build's chunk composition is asserted by the build itself (the engine is a
 * separate lazy chunk); this test asserts the runtime behaviour, which is what a
 * user experiences.
 */
test('abrir una fuente de YouTube descarga código que el catálogo no descarga', async ({ page }) => {
  await stubApi(page, { youtubeChannels: YOUTUBE_CHANNELS });
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
  // The IFrame API itself is not fetched by the catalogue.
  expect([...requested].some((name) => name.includes('iframe_api'))).toBe(false);

  await page.goto('/television/yt-directo');
  await page.getByTestId('yt-engine-shell').waitFor({ state: 'visible', timeout: 25_000 });
  await page.waitForTimeout(800);

  const newChunks = [...requested].filter((name) => !atCatalogue.has(name));
  // Opening a YouTube channel must pull additional code (the engine and the page).
  expect(newChunks.length, 'el motor debe llegar con la ficha, no con la app').toBeGreaterThan(0);
});
