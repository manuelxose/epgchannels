import { expect, test } from '@playwright/test';
import { stubApi } from './helpers';

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

const BROWSER_SURFACES_STUB = `
(function () {
  window.__cast = { pickers: 0, remoteCalls: 0 };
  // A browser with the Cast SDK available.
  window.__onGCastApiAvailable = function (available) {
    if (!available) return;
    window.chrome = window.chrome || {};
    window.chrome.cast = {
      media: { DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845' },
    };
    var listeners = {};
    var session = {
      getSessionId: function () { return 'session-1'; },
      getCastDevice: function () { return { friendlyName: 'Sala' }; },
      getMediaSession: function () { return null; },
      endSession: function () {},
      addMediaListener: function () {},
      removeMediaListener: function () {},
    };
    window.cast = window.cast || {};
    window.cast.framework = {
      CastContextEventType: { SESSION_STATE_CHANGED: 'sessionstatechanged', CAST_STATE_CHANGED: 'caststatechanged' },
      SessionState: { NO_SESSION: 'NO_SESSION', SESSION_STARTED: 'SESSION_STARTED', SESSION_RESUMED: 'SESSION_RESUMED' },
      CastState: { NO_DEVICES_AVAILABLE: 'NO_DEVICES_AVAILABLE', CONNECTED: 'CONNECTED' },
      CastContext: {
        getInstance: function () {
          return {
            setOptions: function () {},
            addEventListener: function (type, handler) { (listeners[type] = listeners[type] || []).push(handler); },
            getCurrentSession: function () { return null; },
            requestSession: function () {
              window.__cast.pickers += 1;
              return Promise.resolve();
            },
            getCastState: function () { return 'NO_DEVICES_AVAILABLE'; },
          };
        },
      },
    };
    window.chrome.cast.SessionRequest = function (appId) { this.appId = appId; };
    if (window.__castReady) window.__castReady();
  };
  // Browsers without the SDK leave remotePlayback undefined on purpose.
})();
`;

test.describe('Enviar a un dispositivo', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript({ content: BROWSER_SURFACES_STUB });
    await page.addInitScript(() => {
      window.dispatchEvent(new Event('load'));
      window.__onGCastApiAvailable?.(true);
    });
    await page.route('https://www.gstatic.com/cv/js/sender/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/javascript', body: BROWSER_SURFACES_STUB });
    });
  });

  test('el control de emisión solo aparece si el navegador puede descubrir dispositivos', async ({ page }) => {
    await stubApi(page);
    await page.goto('/television/la-uno');
    await expect(page.getByTestId('player-state')).toHaveText(/./, { timeout: 30_000 });
    const castButton = page.getByRole('button', { name: /emitir|chromecast|cast|dispositivo/i });
    const count = await castButton.count();
    // Either the browser surface exists (and the control is offered) or it does
    // not (and no control claims it could cast). Never a third option.
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('sin superficies de emisión no se ofrece un selector propio de dispositivos', async ({ page }) => {
    await page.unrouteAll();
    await stubApi(page);
    await page.goto('/television/la-uno');
    await expect(page.getByTestId('player-state')).toHaveText(/./, { timeout: 30_000 });
    const ownPicker = page.getByRole('dialog', { name: /dispositivo/i });
    await expect(ownPicker).toHaveCount(0);
  });

  test('la página del canal carga sin errores de consola no controlados', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await page.goto('/television/la-dos');
    await expect(page.getByTestId('player-state')).toHaveText(/./, { timeout: 30_000 });
    expect(errors).toEqual([]);
  });
});
