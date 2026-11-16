import { expect, test } from '@playwright/test';
import { stubApi } from './helpers';
import { stubYoutube, youtubeProbe, YOUTUBE_CHANNELS } from './youtube-helpers';

/**
 * The API descriptor decides which engine plays. This suite pins the mapping:
 * HLS descriptors go to our own engine, YouTube descriptors to the official
 * IFrame player, and a channel that offers both plays what the API prefers.
 */
test.describe('Selección de motor según el descriptor', () => {
  test.beforeEach(async ({ page }) => {
    await stubApi(page, { youtubeChannels: YOUTUBE_CHANNELS });
    await stubYoutube(page);
  });

  test('un descriptor HLS nunca monta el reproductor de YouTube', async ({ page }) => {
    await page.goto('/television/la-uno');
    await expect(page.getByTestId('player-state')).toHaveText(/./, { timeout: 30_000 });
    expect((await youtubeProbe(page)).players).toBe(0);
  });

  test('un descriptor de YouTube monta exactamente un reproductor oficial', async ({ page }) => {
    await page.goto('/television/yt-directo');
    await expect.poll(async () => (await youtubeProbe(page)).players, { timeout: 25_000 }).toBe(1);
    await expect(page.getByTestId('yt-engine-shell')).toBeVisible();
  });

  test('un canal con ambas opciones prefiere HLS cuando la API lo indica', async ({ page }) => {
    await page.goto('/television/hls-y-yt');
    await expect(page.getByTestId('player-state')).toHaveText(/./, { timeout: 30_000 });
    expect((await youtubeProbe(page)).players).toBe(0);
  });
});
