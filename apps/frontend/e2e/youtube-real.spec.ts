import { expect, test } from '@playwright/test';

/**
 * The report that started this change: a channel that emits through YouTube was
 * mounted as an opaque channel frame and stayed "paused" even while
 * broadcasting.
 *
 * The fix is server-side (the resolution job stores the live video id) and the
 * descriptor now carries that video, so our own player observes real playback.
 * This suite runs against the LIVE backend and database: no stubs, no fixtures —
 * if the resolution has not run, it says so instead of passing for the wrong
 * reason.
 */
test.describe('Emisión por YouTube, contra el backend real', () => {
  test('un canal con página de canal entrega el vídeo en vivo, no la página', async ({ request }) => {
    const response = await request.get('/api/v1/channels/abc-news-usa/playback');
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      data: { playback: { type: string | null; url: string | null; options: { url: string }[] } };
    };

    expect(body.data.playback.type).toBe('youtube');
    // Once the resolution job has run, the address is a video the official
    // player can drive. A channel page (`/channel/<id>/live`) is not.
    const url = body.data.playback.url ?? '';
    if (url.includes('/channel/')) {
      test.skip(true, 'El canal aún no está resuelto: ejecuta el job de resolución.');
    }
    expect(url).toMatch(/youtube\.com\/watch\?v=[\w-]{11}/);
  });

  test('la app reproduce el vídeo resuelto y lo declara', async ({ page }) => {
    await page.goto('/television/abc-news-usa');
    await expect(page.getByTestId('yt-engine-shell')).toBeVisible({ timeout: 30_000 });

    // The frame must address a video, not a channel, for playback to be observable.
    const src = await page.locator('[data-testid="yt-engine-shell"] iframe').getAttribute('src');
    if (!src || src.includes('live_stream')) {
      test.skip(true, 'El canal aún no está resuelto: ejecuta el job de resolución.');
    }
    expect(src).toMatch(/embed\/[\w-]{11}/);

    // And our own state machine must see it playing, not a permanent "paused".
    await expect
      .poll(async () => (await page.getByTestId('player-state').textContent())?.trim(), { timeout: 45_000 })
      .toBe('playing');
  });

  test('un canal de YouTube no resuelto no finge estar reproduciendo', async ({ page }) => {
    // Any channel whose descriptor still points at a channel page must not claim
    // playback: the state we cannot observe is never reported as playing.
    const catalogue = await page.request.get('/api/v1/channels?pageSize=100');
    const body = (await catalogue.json()) as { data: { slug: string }[] };
    for (const channel of body.data.slice(0, 6)) {
      const playback = await page.request.get(`/api/v1/channels/${channel.slug}/playback`);
      const descriptor = (await playback.json()) as { data: { playback: { url: string | null } } };
      const url = descriptor.data.playback.url ?? '';
      if (!url.includes('/channel/')) continue;

      await page.goto(`/television/${channel.slug}`);
      await expect(page.getByTestId('yt-engine-shell')).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(4000);
      const status = (await page.getByTestId('player-state').textContent())?.trim();
      expect(status, `${channel.slug} no puede declarar reproducción sin poder observarla`).not.toBe('playing');
      return;
    }
    test.skip(true, 'Todos los canales de la muestra ya están resueltos.');
  });
});
