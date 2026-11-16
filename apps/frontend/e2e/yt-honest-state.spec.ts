import { test, expect } from '@playwright/test';
import { stubApi } from './helpers';
import { stubYoutube, YOUTUBE_CHANNELS } from './youtube-helpers';

/**
 * Honest states for YouTube shapes we cannot drive as a video.
 *
 * A handle (`/@name`) names a channel but carries no identifier we can verify,
 * so the client must never pretend it is playing that channel's video: it either
 * offers the official page as a link or says nothing can be played here.
 */
test('un identificador no verificable nunca se declara en reproducción', async ({ page }) => {
  await stubApi(page, { youtubeChannels: YOUTUBE_CHANNELS });
  await stubYoutube(page);

  await page.goto('/television/yt-handle');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Youtube Handle');
  const heading = page.getByRole('heading', { level: 1 });

  // Either a player shell exists (and never claims playback) or an explicit
  // state explains what is available instead.
  const shell = page.getByTestId('yt-engine-shell');
  if ((await shell.count()) > 0) {
    const status = (await page.getByTestId('player-state').textContent())?.trim() ?? '';
    expect(status).not.toBe('playing');
  } else {
    await expect(heading).toHaveText('Youtube Handle');
    await expect(page.getByTestId('player-alert').or(page.getByRole('link', { name: /youtube|oficial|emisor/i })).first()).toBeVisible({
      timeout: 20_000,
    });
  }
});
