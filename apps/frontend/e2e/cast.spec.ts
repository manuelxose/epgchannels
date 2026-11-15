import { expect, test } from '@playwright/test';
import { stubData } from './helpers';

/**
 * "Enviar a un dispositivo" (device casting).
 *
 * Measured: browsers expose device discovery only on their own surfaces
 * (`chrome.cast`, `remotePlayback`, AirPlay), and none lets a page list devices
 * itself. These tests simulate those surfaces to pin the app contract:
 *  - the button appears ONLY when the browser can discover devices;
 *  - pressing it opens the BROWSER's picker (never a list of our own);
 *  - for a YouTube source the app never claims it can send YouTube's player.
 */

const youtubeOnlyCatalogue = {
  license: { source: 'e2e', url: 'https://example.org' },
  epg: { json: 'https://upstream.invalid/epg.json' },
  countries: [
    {
      name: 'Spain',
      ambits: [
        {
          name: 'Generalistas',
          channels: [
            {
              name: 'Youtube Directo',
              web: 'https://example.org/yt',
              options: [{ format: 'youtube', url: 'https://www.youtube.com/live/OkQduT-9Pyc' }],
              extra_info: ['EMB'],
            },
          ],
        },
      ],
    },
  ],
  updated: Math.floor(Date.now() / 1000),
};

test.describe('Enviar a un dispositivo', () => {
  test.beforeEach(async ({ page }) => {
    await stubData(page);
  });

  /*
   * The button is offered for every source the engine OWNS, even before the
   * browser has been probed: the Cast SDK can add its bridge at any time, so
   * hiding the button until then hid the feature. Pressing it is what reports the
   * real capabilities.
   */
  test('el botón se ofrece para una fuente propia aunque el navegador no anuncie nada', async ({ page }) => {
    await page.goto('/television/la-uno');
    await expect(page.getByTestId('player-state')).not.toHaveText('', { timeout: 20_000 });
    const button = page.getByTestId('cast-button');
    await expect(button).toBeVisible({ timeout: 20_000 });
    await button.click();
    // And pressing it tells the truth about what is missing.
    await expect(page.getByTestId('cast-notice')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('cast-notice')).toHaveText(/Google Cast|dispositivo|pantalla/i);
  });

  /*
   * The browser's own surface is used when Google Cast is not available. The SDK
   * request is blocked here on purpose, so this measures the fallback path rather
   * than the Cast path that normally wins.
   */
  test('sin Cast del navegador usa la API Remote Playback cuando existe', async ({ page }) => {
    await page.route('https://www.gstatic.com/cv/js/sender/**', (route) => route.abort());
    await page.addInitScript(() => {
      const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
      (window as unknown as { __prompts: number }).__prompts = 0;
      Object.defineProperty(proto, 'remotePlayback', {
        configurable: true,
        get() {
          return {
            prompt: () => {
              (window as unknown as { __prompts: number }).__prompts += 1;
              return Promise.resolve();
            },
          };
        },
      });
    });
    await page.goto('/television/la-uno');
    await expect(page.getByTestId('player-state')).not.toHaveText('', { timeout: 20_000 });
    const button = page.getByTestId('cast-button');
    await expect(button).toBeVisible({ timeout: 20_000 });
    await expect(button).toHaveAttribute('aria-label', 'Enviar a un dispositivo');
    await button.click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __prompts: number }).__prompts))
      .toBeGreaterThan(0);
    // No device list of our own, ever.
    await expect(page.getByRole('listbox')).toHaveCount(0);
  });

  test('con el puente Cast el botón usa el selector de Chrome', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __sessions: number }).__sessions = 0;
      (window as unknown as { chrome: unknown }).chrome = {
        cast: {
          isAvailable: true,
          initialize: (_config: unknown, onSuccess?: () => void) => onSuccess?.(),
          requestSession: () => {
            (window as unknown as { __sessions: number }).__sessions += 1;
          },
          SessionRequest: class {},
        },
      };
    });
    await page.goto('/television/la-uno');
    await expect(page.getByTestId('player-state')).not.toHaveText('', { timeout: 20_000 });
    const button = page.getByTestId('cast-button');
    await expect(button).toBeVisible({ timeout: 20_000 });
    await button.click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __sessions: number }).__sessions))
      .toBeGreaterThan(0);
  });

  /*
   * The real integration: pressing the button loads Google's Cast sender SDK on
   * demand and reports what happened. Measured: the SDK installs `chrome.cast`
   * even though the browser did not have it on load.
   */
  test('el SDK oficial de Cast se carga al pulsar y responde', async ({ page }) => {
    const sdkLoaded: string[] = [];
    page.on('request', (request) => {
      if (/gstatic\.com\/cv\/js\/sender/.test(request.url())) {
        sdkLoaded.push(request.url());
      }
    });
    await page.goto('/television/la-uno');
    const button = page.getByTestId('cast-button');
    await expect(button).toBeVisible({ timeout: 20_000 });
    await button.click();
    await expect(page.getByTestId('cast-notice')).toBeVisible({ timeout: 20_000 });
    // The official SDK was fetched, and the page now exposes the Cast bridge.
    expect(sdkLoaded.length).toBeGreaterThan(0);
    await expect
      .poll(() => page.evaluate(() => typeof (window as unknown as { chrome?: { cast?: unknown } }).chrome?.cast))
      .toBe('object');
  });

  test('en una fuente de YouTube no se ofrece enviar el reproductor ajeno', async ({ page }) => {
    await stubData(page, { catalog: youtubeOnlyCatalogue });
    await page.goto('/television/youtube-directo');
    await expect(page.getByTestId('yt-engine-shell')).toBeVisible();
    await expect(page.locator('.controls')).toHaveCount(0);
    await expect(page.getByTestId('cast-button')).toHaveCount(0);
    await expect(page.getByTestId('yt-official-link')).toContainText(/YouTube/i);
  });
});
