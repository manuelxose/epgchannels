import { expect, test, type Page } from '@playwright/test';
import { catalogFixture, stubData } from './helpers';

/**
 * T4 — official YouTube integration + verified-state UI (spec §9).
 *
 * Everything here runs on LOCAL fixtures: the catalog is intercepted, no third
 * party is contacted, and the YouTube IFrame API is fulfilled from a local stub
 * so the embed can be exercised without touching YouTube.
 */

/** One channel per verified state, each backed by an explicit published fact. */
function verifiedFixture(): Record<string, unknown> {
  const channels = [
    {
      // live: an in-app HLS source this browser can attempt.
      name: 'Ficha Directo',
      web: 'https://example.org/directo',
      options: [{ format: 'm3u8', url: '/demo/media/single/index.m3u8' }],
      extra_info: [],
    },
    {
      /*
       * official-embed: a specific YouTube LIVE video. Only a video is
       * addressable as one stream; a channel page (`/channel/<id>/live`) would
       * mean asking YouTube for the channel's live HLS stream, which the
       * embedding path must not do, so it is covered by its own test.
       */
      name: 'Ficha Embed',
      web: 'https://example.org/embed',
      options: [{ format: 'youtube', url: 'https://www.youtube.com/live/OkQduT-9Pyc' }],
      extra_info: ['EMB'],
    },
    {
      // official-site: the emitter only publishes its own page.
      name: 'Ficha Oficial',
      web: 'https://example.org/oficial',
      options: [],
      extra_info: ['EXTA'],
    },
    {
      // eventual: catalogued with an event hint and no continuous signal.
      name: 'Ficha Eventual',
      web: 'https://example.org/eventual',
      options: [],
      extra_info: ['EVT'],
    },
    {
      // requires-official: the emitter only authorises its own app.
      name: 'Ficha Restringida',
      web: 'https://example.org/restringida',
      options: [],
      extra_info: ['UAG'],
    },
    {
      // unavailable: nothing published at all.
      name: 'Ficha Vacia',
      options: [],
      extra_info: [],
    },
    {
      /*
       * Region-restricted HLS: the restriction belongs to the *source record*
       * (`geo2`), not to the channel. A channel-level GEO tag is only the
       * catalogue's warning and must not be what blocks playback here.
       */
      name: 'Ficha Geolocalizada',
      web: 'https://example.org/geo',
      options: [{ format: 'm3u8', url: 'https://cdn.example.org/geo.m3u8', geo2: 'ES' }],
      extra_info: ['GEO'],
    },
    {
      // YouTube page we cannot address: link out, never embed.
      name: 'Ficha YouTube Sin ID',
      web: 'https://example.org/yt',
      options: [{ format: 'youtube', url: 'https://www.youtube.com/@emisora/live' }],
      extra_info: ['EMB'],
    },
  ];

  return {
    ...catalogFixture(),
    epg: { json: 'https://upstream.invalid/epg.json' },
    countries: [{ name: 'Spain', ambits: [{ name: 'Generalistas', channels }] }],
  };
}

/** A specific official YouTube video: addressable by the IFrame API. */
function videoFixture(): Record<string, unknown> {
  return {
    ...catalogFixture(),
    epg: { json: 'https://upstream.invalid/epg.json' },
    countries: [
      {
        name: 'Spain',
        ambits: [
          {
            name: 'Generalistas',
            channels: [
              {
                name: 'Ficha Video',
                web: 'https://example.org/video',
                options: [{ format: 'youtube', url: 'https://www.youtube.com/live/OkQduT-9Pyc' }],
                extra_info: ['EMB'],
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Local stand-in for `https://www.youtube.com/iframe_api`: records that it was
 * loaded and builds a fake player, so nothing leaves the machine.
 */
const YOUTUBE_API_STUB = `
  (function () {
    window.__ytApiRequests = (window.__ytApiRequests || 0) + 1;
    function Player(el, config) {
      window.__ytPlayer = {
        host: config.host,
        videoId: config.videoId || null,
        playerVars: config.playerVars || {},
        destroyed: false,
      };
      var iframe = document.createElement('iframe');
      var target = typeof el === 'string' ? document.getElementById(el) : el;
      target.appendChild(iframe);
      var self = this;
      this.iframe = iframe;
      this.getIframe = function () { return iframe; };
      this.playVideo = function () {
        window.__ytPlayCalls = (window.__ytPlayCalls || 0) + 1;
      };
      this.pauseVideo = function () {};
      this.mute = function () { window.__ytMuted = true; };
      this.unMute = function () { window.__ytMuted = false; };
      this.setVolume = function () {};
      this.destroy = function () { window.__ytPlayer.destroyed = true; };
      setTimeout(function () {
        if (config.events && config.events.onReady) config.events.onReady();
      }, 0);
    }
    window.YT = { Player: Player };
    window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady();
  })();
`;

async function stubYoutube(page: Page): Promise<void> {
  // The API script itself is served locally (registered first, so it wins over
  // the catch-all below). Nothing else is ever fetched from YouTube.
  await page.route('https://www.youtube.com/iframe_api', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: YOUTUBE_API_STUB });
  });
  await page.route('https://www.youtube.com/**', async (route) => {
    await route.abort('blockedbyclient');
  });
  await page.route('https://www.youtube-nocookie.com/**', async (route) => {
    await route.abort('blockedbyclient');
  });
}

test.describe('Estados verificados (spec §9)', () => {
  test.beforeEach(async ({ page }) => {
    await stubData(page, { catalog: verifiedFixture() });
    await stubYoutube(page);
  });

  /**
   * "Ver en directo" is a claim about THIS app playing the signal. The fixture
   * source is synthetic demo media that this browser cannot decode, so the honest
   * outcome is: the state stops claiming in-app playback and no dead player is
   * mounted. A decodable source (a real build) keeps the in-app claim.
   */
  test('solo se afirma "Ver en directo" cuando el reproductor propio se monta', async ({ page }) => {
    await page.goto('/television/ficha-directo');
    const playerMounted = await expect
      .poll(async () => (await page.locator('app-player video').count()) > 0, { timeout: 20_000 })
      .toBe(true)
      .then(() => true)
      .catch(() => false);
    // If the player mounted, the claim must be there; if not, it must not be.
    await expect(page.getByTestId('verified-state').locator('.verified__chip')).toHaveText(
      playerMounted ? 'Ver en directo' : /^(?!Ver en directo$).+/,
    );
  });

  test('cada estado se anuncia con su etiqueta y su motivo', async ({ page }) => {
    const cases: [string, string][] = [
      ['ficha-directo', 'Ver en directo'],
      ['ficha-embed', 'Ver en directo (oficial)'],
      ['ficha-oficial', 'Disponible en la web oficial'],
      ['ficha-eventual', 'Emisión eventual'],
      ['ficha-restringida', 'Requiere acceso oficial'],
      ['ficha-vacia', 'No disponible actualmente'],
    ];
    for (const [slug, label] of cases) {
      await page.goto(`/television/${slug}`);
      const strip = page.getByTestId('verified-state');
      await expect(strip, slug).toBeVisible();
      await expect(strip.locator('.verified__chip'), slug).toHaveText(label);
      // The badge in the channel header must agree with the strip.
      await expect(page.getByTestId('channel-state-badge'), slug).toHaveText(label);
    }
  });

  test('solo el estado live o el embed oficial montan un reproductor', async ({ page }) => {
    await page.goto('/television/ficha-directo');
    await expect(page.locator('app-player video')).toHaveCount(1);

    /*
     * Since TDT-CLONE-12 an addressable YouTube page is played INSIDE our player
     * by the official engine, so `app-player` mounts for `official-embed` too —
     * as a YouTube surface, never as a media element. The channel's own `<video>`
     * stays hidden because the official player owns the stage.
     */
    await page.goto('/television/ficha-embed');
    await expect(page.locator('app-player')).toHaveCount(1);
    await expect(page.getByTestId('yt-engine-shell')).toHaveCount(1);

    for (const slug of ['ficha-oficial', 'ficha-eventual', 'ficha-restringida', 'ficha-vacia']) {
      await page.goto(`/television/${slug}`);
      await expect(page.getByTestId('verified-state'), slug).toBeVisible();
      await expect(page.locator('app-player'), slug).toHaveCount(0);
    }
  });

  test('una fuente geobloqueada nunca ofrece "Ver en directo"', async ({ page }) => {
    await page.goto('/television/ficha-geolocalizada');
    const strip = page.getByTestId('verified-state');
    await expect(strip.locator('.verified__chip')).toHaveText('Disponible en la web oficial');
    // The reason is evidence-backed, not a generic message.
    await expect(strip).toContainText('bloqueadas por región');
    await expect(page.locator('app-player video')).toHaveCount(0);
    await page.getByTestId('blocked-sources').locator('summary').click();
    await expect(page.getByTestId('blocked-sources')).toContainText('Bloqueo regional');
  });

  test('una página de YouTube sin identificador se enlaza, no se incrusta', async ({ page }) => {
    await page.goto('/television/ficha-youtube-sin-id');
    await expect(page.getByTestId('verified-state').locator('.verified__chip')).toHaveText(
      'Disponible en la web oficial',
    );
    await expect(page.getByTestId('youtube-shell')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Abrir el reproductor|Abrir la página/ })).toHaveAttribute(
      'href',
      'https://www.youtube.com/@emisora/live',
    );
  });
});

test.describe('Integración oficial de YouTube', () => {
  /*
   * These tests are about the privacy-enhanced IFrame the app creates. They
   * stub the official `iframe_api` script and assert on the frame the app
   * built. Since TDT-CLONE-12 the official player is mounted INSIDE our player
   * (`app-player` → `[data-testid="yt-engine-shell"]`), driven by
   * `YouTubePlaybackEngine`; the former `app-youtube-player` link-out shell no
   * longer exists and its behaviour is covered by `e2e/youtube.spec.ts`.
   */
  test.beforeEach(async ({ page }) => {
    await stubData(page, { catalog: verifiedFixture() });
    await page.route('https://www.youtube.com/iframe_api', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/javascript', body: YOUTUBE_API_STUB });
    });
  });

  test('carga el reproductor oficial sólo cuando la ficha lo pide (lazy)', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('youtube')) requests.push(request.url());
    });
    // A channel with no in-app playback must never touch YouTube.
    await page.goto('/television/ficha-oficial');
    await expect(page.getByTestId('verified-state')).toBeVisible();
    expect(requests.filter((url) => !url.includes('iframe_api'))).toEqual([]);
    await expect(page.locator('[data-testid="yt-engine-shell"] iframe')).toHaveCount(0);

    // The channel that IS a YouTube live mounts the official player in-app.
    await page.goto('/television/ficha-embed');
    await expect(page.getByTestId('yt-engine-shell')).toBeVisible();
    await expect
      .poll(async () => requests.filter((url) => url.includes('/iframe_api')).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
  });

  test('usa el dominio sin cookies y restringe el origen a nuestro origen', async ({ page }) => {
    await page.goto('/television/ficha-embed');
    // The in-app official player is created for this channel's video.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __ytPlayer?: { videoId?: string | null } }).__ytPlayer?.videoId ?? null,
          ),
        { timeout: 15_000 },
      )
      .toBe('OkQduT-9Pyc');
    const config = await page.evaluate(
      () =>
        (
          window as unknown as {
            __ytPlayer?: { host?: string; playerVars?: Record<string, string | number> };
          }
        ).__ytPlayer ?? null,
    );
    expect(config?.host).toBe('https://www.youtube-nocookie.com');
    expect(config?.playerVars?.['origin']).toBe('http://127.0.0.1:4400');
    // Inline playback: the player must not take over the screen on a phone.
    expect(config?.playerVars?.['playsinline']).toBe(1);
  });

  test('la configuración del reproductor de vídeo usa el dominio sin cookies y nuestro origen', async ({ page }) => {
    await page.goto('/television/ficha-embed');
    await expect(page.getByTestId('yt-engine-shell')).toBeVisible();
    /*
     * The same-page API stub is installed before Angular boots and the bundle
     * captures the global, so the video id and the privacy posture are asserted
     * through the config the app handed to the published API. The full
     * configuration contract (id, host, origin, playsinline) is pinned in the
     * unit suite (`youtube-engine.spec.ts`, `youtube-embed.spec.ts`).
     */
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as unknown as { __ytPlayer?: { videoId?: string | null } }).__ytPlayer?.videoId ?? null,
          ),
        { timeout: 15_000 },
      )
      .toBe('OkQduT-9Pyc');
    const host = await page.evaluate(
      () => (window as unknown as { __ytPlayer?: { host?: string } }).__ytPlayer?.host ?? null,
    );
    expect(host).toBe('https://www.youtube-nocookie.com');
  });
  test('el enlace externo abre con noopener y noreferrer', async ({ page }) => {
    await page.goto('/television/ficha-embed');
    // The official page is still offered next to the in-app player, safely.
    const link = page.getByRole('link', { name: /Abrir en YouTube/ });
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('href', 'https://www.youtube.com/live/OkQduT-9Pyc');
  });

  test('si el reproductor oficial no carga, se explica y se enlaza al emisor', async ({ page }) => {
    await page.route('https://www.youtube.com/iframe_api', async (route) => {
      await route.abort('blockedbyclient');
    });
    await page.goto('/television/ficha-embed');
    // No playback is claimed: the failure is reported with the official page.
    const alert = page.getByTestId('player-alert');
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(alert).toContainText(/no se ha podido cargar|YouTube/i);
    await expect(page.getByTestId('player-state')).not.toHaveText('playing');
    // The official route is offered as an action (the emitter's own page).
    await expect(page.getByTestId('player-alert').getByRole('link')).toHaveCount(1);
    await expect(page.locator('[data-testid="yt-engine-shell"] iframe')).toHaveCount(0);
  });
});

test.describe('P3 — cajón de parrilla con foco gestionado', () => {
  test.beforeEach(async ({ page }) => {
    await stubData(page, { catalog: verifiedFixture() });
  });

  /** The trigger only exists when the channel has a published guide. */
  const guided = 'ficha-directo';

  test('abre, atrapa el foco y lo devuelve al abridor al cerrar', async ({ page }) => {
    await page.goto(`/television/${guided}`);
    const trigger = page.getByRole('button', { name: 'Toda la programación' });
    await expect(trigger).toBeVisible();
    await trigger.focus();
    await trigger.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Focus starts inside the dialog (the close control).
    await expect(page.getByRole('button', { name: 'Cerrar' })).toBeFocused();

    // The background is inert and the page cannot scroll behind the drawer.
    const background = await page.evaluate(() => ({
      headerInert: document.querySelector('header')?.hasAttribute('inert') ?? null,
      bodyOverflow: document.body.style.overflow,
      bodyPosition: document.body.style.position,
    }));
    expect(background.headerInert).toBe(true);
    expect(background.bodyOverflow).toBe('hidden');
    expect(background.bodyPosition).toBe('fixed');

    /*
     * Tab cannot leave the dialog. The observed cycle is:
     *   close ⇄ guide scroll region
     * and focus never reaches the background. Focus is seeded with explicit
     * `.focus()` calls because Playwright's synthetic Tab does not walk the
     * shadow root the same way a real Tab does.
     */
    const focusables = dialog.locator('button:not([disabled]), a[href]');
    const count = await focusables.count();
    expect(count).toBeGreaterThan(0);
    const guide = dialog.locator('.drawer__body');
    const close = focusables.first();

    await guide.focus();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(guide).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(guide).toBeFocused();
    await close.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(guide).toBeFocused();
    // Whatever the position, focus is still inside the modal: the active element
    // is the dialog itself, its guide region, or one of its controls.
    const insideModal = await dialog.evaluate((element) => {
      let node: Element | null = document.activeElement;
      while (node && node.shadowRoot?.activeElement) {
        node = node.shadowRoot.activeElement;
      }
      return node !== null && (node === element || element.contains(node));
    });
    expect(insideModal).toBe(true);

    // Escape closes and restores focus to the trigger.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    const restored = await page.evaluate(() => ({
      headerInert: document.querySelector('header')?.hasAttribute('inert') ?? null,
      bodyPosition: document.body.style.position,
    }));
    expect(restored.headerInert).toBe(false);
    expect(restored.bodyPosition).toBe('');
  });

  test('cerrar con el botón también devuelve el foco', async ({ page }) => {
    // The drawer lives on a channel that has a guide; any playable channel works.
    await page.goto('/television/ficha-directo');
    const trigger = page.getByRole('button', { name: 'Toda la programación' });
    await trigger.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Cerrar' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
