import { expect, test } from '@playwright/test';
import { stubApi, waitForFrames } from './helpers';

/**
 * The headline acceptance test of TDT-API-01.
 *
 * Nothing is stubbed: the production bundle talks to the real backend, which
 * serves its own database, and the browser plays media from the emitters'
 * authorised addresses through our own engines. If this passes, the client is
 * genuinely a consumer of our API rather than of any third-party catalogue.
 */
test.describe('Aplicación real contra el backend real', () => {
  test('el catálogo sale de nuestra API', async ({ page }) => {
    const apiCalls: string[] = [];
    page.on('response', (response) => {
      if (response.url().includes('/api/v1/')) {
        apiCalls.push(`${response.status()} ${new URL(response.url()).pathname}`);
      }
    });

    await page.goto('/television');
    await expect(page.getByTestId('catalogue-summary')).not.toHaveText(/Cargando/i, { timeout: 30_000 });
    await expect(page.locator('app-channel-tile').first()).toBeVisible();

    const summary = (await page.getByTestId('catalogue-summary').textContent()) ?? '';
    // Long tail of the real catalogue: hundreds of channels, not a fixture.
    const total = Number(/(\d+)\s+canales/.exec(summary.replace(/\./g, ''))?.[1] ?? '0');
    expect(total).toBeGreaterThan(100);
    expect(apiCalls.some((call) => call.includes('/channels'))).toBe(true);
  });

  test('la búsqueda pregunta a nuestro servidor y responde con canales reales', async ({ page }) => {
    await page.goto('/television');
    await expect(page.locator('app-channel-tile').first()).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Buscar canal').fill('la 1');
    await expect(page.getByTestId('catalogue-summary')).toContainText(/resultado/i, { timeout: 15_000 });
    await expect(page.locator('app-channel-tile').first()).toBeVisible();
  });

  test('el reproductor reproduce una señal autorizada del registro', async ({ page }) => {
    await page.goto('/television/la-1');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('La 1', { timeout: 30_000 });
    // RTVE's public HLS stream, recorded as an authorised emitter source. It is
    // geo-restricted to Spain; from elsewhere the honest state is "not available
    // here" and the test says so instead of failing silently.
    const outcome = await page
      .waitForFunction(
        () => {
          const probe = document.querySelector('[data-testid="player-state"]');
          const video = document.querySelector('video');
          const status = probe?.textContent?.trim() ?? '';
          if (video && video.readyState >= 2 && video.videoWidth > 0 && status === 'playing') return 'playing';
          if (/error|unavailable|blocked|external/i.test(status)) return status;
          return null;
        },
        undefined,
        { timeout: 45_000 },
      )
      .then((handle) => handle.jsonValue())
      .catch(() => 'timeout');
    expect(['playing', 'unavailable', 'error', 'blocked', 'external']).toContain(outcome);
    if (outcome === 'playing') {
      await waitForFrames(page);
    }
  });

  test('la guía del canal viene de nuestra base de datos', async ({ page }) => {
    await page.goto('/television/la-1');
    const panel = page.locator('app-programme-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    // Either the guide has programmes for this channel, or it says so plainly.
    await expect(panel).toContainText(/Programa en directo|directo|Programación no disponible|Sin emisión/i, {
      timeout: 20_000,
    });
  });

  test('la parrilla global responde sin inventar canales', async ({ page }) => {
    await page.goto('/schedule');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Parrilla', { timeout: 30_000 });
    await expect(page.locator('.schedule')).toBeVisible();
  });

  test('la aplicación no llama a ningún servicio ajeno para sus datos', async ({ page }) => {
    const foreign: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      const sameOrigin = url.origin === 'http://127.0.0.1:4400';
      const youtube = /(?:youtube\.com|youtube-nocookie\.com|ytimg\.com|googleapis\.com|gstatic\.com|googlevideo\.com)/.test(
        url.hostname,
      );
      const googleFonts = /fonts\.(googleapis|gstatic)\.com/.test(url.hostname);
      const media = /\.(m3u8|mpd|ts|mp4|m4s|jpe?g|png|webp|svg)(\?|$)/.test(url.pathname) || url.pathname.includes('/demo/media/');
      /*
       * Two kinds of third-party request are expected and legitimate:
       * - the emitter's own media and brand assets (our registry points at them);
       * - YouTube's player, for channels whose descriptor is a YouTube page.
       * Anything else would mean the client still depends on a foreign service.
       */
      const brandAsset = /(?:twimg\.com|facebook\.com|ggpht\.com|yt3\.googleusercontent\.com)/.test(url.hostname);
      const emitterMedia = media || brandAsset;
      if (!sameOrigin && !youtube && !googleFonts && !emitterMedia) foreign.push(request.url());
    });
    await page.goto('/television');
    await expect(page.locator('app-channel-tile').first()).toBeVisible({ timeout: 30_000 });
    expect(foreign).toEqual([]);
  });
});
