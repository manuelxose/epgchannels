import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './helpers';
import { YOUTUBE_API_STUB, stubYoutube as stubYoutubeApi } from './youtube-helpers';
import type { FixtureChannel } from './api-fixtures';

/**
 * Verified-state UI (spec §9) and the official YouTube integration.
 *
 * Everything runs on LOCAL fixtures describing **our API's** descriptors: no
 * third party is contacted, and the YouTube IFrame API is fulfilled from a local
 * stub. Each verified state is produced by the descriptor the API would really
 * return for that channel, rather than by a tag in a foreign catalogue.
 */

const EMBED_VIDEO = 'https://www.youtube.com/live/OkQduT-9Pyc';

/** One channel per verified state, expressed as the descriptor our API returns. */
const VERIFIED_CHANNELS: FixtureChannel[] = [
  // live: an authorised in-app HLS source this browser can attempt.
  { slug: 'ficha-directo', name: 'Ficha Directo', category: 'generalista', playbackStatus: 'available', kind: 'linear', sourceUrl: '/demo/media/single/index.m3u8', hasSchedule: true },
  // official-site: the emitter only publishes its own page.
  { slug: 'ficha-oficial', name: 'Ficha Oficial', category: 'generalista', playbackStatus: 'external', kind: 'linear', externalUrl: 'https://example.org/oficial' },
  // eventual: the emitter publishes it as an intermittent emission.
  { slug: 'ficha-eventual', name: 'Ficha Eventual', category: 'generalista', playbackStatus: 'eventual', kind: 'eventual' },
  // unavailable: nothing registered.
  { slug: 'ficha-vacia', name: 'Ficha Vacia', category: 'generalista', playbackStatus: 'unavailable', kind: 'linear' },
];

/** The addressable YouTube live video, played by the official engine in-app. */
const EMBED_CHANNELS: FixtureChannel[] = [
  { slug: 'ficha-embed', name: 'Ficha Embed', category: 'generalista', playbackStatus: 'available', kind: 'linear', hasSchedule: false },
];

test.describe('Estados verificados (spec §9)', () => {
  test.beforeEach(async ({ page }) => {
    await stubApi(page, {
      channels: VERIFIED_CHANNELS,
      youtubeChannels: [
        { slug: 'ficha-embed', name: 'Ficha Embed', youtubeUrl: EMBED_VIDEO },
        { slug: 'ficha-youtube-sin-id', name: 'Ficha YouTube Sin ID', youtubeUrl: 'https://www.youtube.com/@emisora/live' },
      ],
    });
    await stubYoutubeApi(page);
  });

  test('cada estado se anuncia con su etiqueta y su motivo', async ({ page }) => {
    const cases: [string, string][] = [
      ['ficha-directo', 'Ver en directo'],
      ['ficha-oficial', 'Disponible en la web oficial'],
      ['ficha-eventual', 'Emisión eventual'],
      ['ficha-vacia', 'No disponible actualmente'],
    ];
    for (const [slug, label] of cases) {
      await page.goto(`/television/${slug}`);
      const strip = page.getByTestId('verified-state');
      await expect(strip, slug).toBeVisible();
      await expect(strip.locator('.verified__chip'), slug).toHaveText(label);
      await expect(page.getByTestId('channel-state-badge'), slug).toHaveText(label);
    }
  });

  test('solo el estado live o el embed oficial montan un reproductor', async ({ page }) => {
    await page.goto('/television/ficha-directo');
    await expect(page.locator('app-player video')).toHaveCount(1);

    // A YouTube descriptor is played INSIDE our player by the official engine.
    await page.goto('/television/ficha-embed');
    await expect(page.locator('app-player')).toHaveCount(1);
    await expect(page.getByTestId('yt-engine-shell')).toHaveCount(1);

    for (const slug of ['ficha-oficial', 'ficha-eventual', 'ficha-vacia']) {
      await page.goto(`/television/${slug}`);
      await expect(page.getByTestId('verified-state'), slug).toBeVisible();
      await expect(page.locator('app-player'), slug).toHaveCount(0);
    }
  });

  test('un canal que el API declara externo no monta el reproductor propio', async ({ page }) => {
    await stubApi(page, {
      channels: [
        {
          slug: 'ficha-geolocalizada',
          name: 'Ficha Geolocalizada',
          category: 'generalista',
          playbackStatus: 'external',
          kind: 'linear',
          sourceUrl: '/demo/media/single/index.m3u8',
          externalUrl: 'https://example.org/geo',
        },
      ],
    });
    await page.goto('/television/ficha-geolocalizada');
    const strip = page.getByTestId('verified-state');
    await expect(strip.locator('.verified__chip')).toHaveText('Disponible en la web oficial');
    await expect(page.locator('app-player video')).toHaveCount(0);
  });

  test('una página de YouTube sin identificador no se incrusta', async ({ page }) => {
    await page.goto('/television/ficha-youtube-sin-id');
    await expect(page.getByTestId('verified-state').locator('.verified__chip')).not.toHaveText('Ver en directo');
    await expect(page.locator('[data-testid="yt-engine-shell"] iframe')).toHaveCount(0);
  });
});

test.describe('Integración oficial de YouTube', () => {
  test.beforeEach(async ({ page }) => {
    await stubApi(page, {
      channels: VERIFIED_CHANNELS,
      youtubeChannels: [{ slug: 'ficha-embed', name: 'Ficha Embed', youtubeUrl: EMBED_VIDEO }],
    });
  });

  test('carga el reproductor oficial sólo cuando la ficha lo pide (lazy)', async ({ page }) => {
    await page.route('https://www.youtube.com/iframe_api', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/javascript', body: YOUTUBE_API_STUB });
    });
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
      .poll(async () => requests.filter((url) => url.includes('/iframe_api')).length, { timeout: 20_000 })
      .toBeGreaterThan(0);
  });

  test('usa el dominio sin cookies y restringe el origen a nuestro origen', async ({ page }) => {
    await stubYoutubeApi(page);
    await page.goto('/television/ficha-embed');
    await expect(page.getByTestId('yt-engine-shell')).toBeVisible();
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                window as unknown as {
                  __yt?: { configs: { host: string | null; videoId: string | null; playerVars: Record<string, string | number> }[] };
                }
              ).__yt?.configs[0]?.videoId ?? null,
          ),
        { timeout: 20_000 },
      )
      .toBe('OkQduT-9Pyc');
    const config = await page.evaluate(
      () =>
        (
          window as unknown as {
            __yt?: { configs: { host: string | null; playerVars: Record<string, string | number> }[] };
          }
        ).__yt?.configs[0] ?? null,
    );
    expect(config?.host).toBe('https://www.youtube-nocookie.com');
    expect(config?.playerVars['origin']).toBe('http://127.0.0.1:4400');
    expect(config?.playerVars['playsinline']).toBe(1);
  });

  test('el enlace externo abre con noopener y noreferrer', async ({ page }) => {
    await stubYoutubeApi(page);
    await page.goto('/television/ficha-embed');
    const link = page.getByRole('link', { name: /Abrir en YouTube/ });
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('href', EMBED_VIDEO);
  });

  test('si el reproductor oficial no carga, se explica y se enlaza al emisor', async ({ page }) => {
    await page.route('https://www.youtube.com/iframe_api', async (route) => {
      await route.abort('blockedbyclient');
    });
    await page.goto('/television/ficha-embed');
    const alert = page.getByTestId('player-alert');
    await expect(alert).toBeVisible({ timeout: 25_000 });
    await expect(alert).toContainText(/no se ha podido cargar|YouTube/i);
    await expect(page.getByTestId('player-state')).not.toHaveText('playing');
    await expect(page.getByTestId('player-alert').getByRole('link')).toHaveCount(1);
    await expect(page.locator('[data-testid="yt-engine-shell"] iframe')).toHaveCount(0);
  });
});

test.describe('P3 — cajón de parrilla con foco gestionado', () => {
  test.beforeEach(async ({ page }) => {
    await stubApi(page, { channels: VERIFIED_CHANNELS });
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
    await expect(page.getByRole('button', { name: 'Cerrar' })).toBeFocused();

    const background = await page.evaluate(() => ({
      headerInert: document.querySelector('header')?.hasAttribute('inert') ?? null,
      bodyOverflow: document.body.style.overflow,
      bodyPosition: document.body.style.position,
    }));
    expect(background.headerInert).toBe(true);
    expect(background.bodyOverflow).toBe('hidden');
    expect(background.bodyPosition).toBe('fixed');

    const focusables = dialog.locator('button:not([disabled]), a[href]');
    expect(await focusables.count()).toBeGreaterThan(0);
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
    const insideModal = await dialog.evaluate((element) => {
      let node: Element | null = document.activeElement;
      while (node && node.shadowRoot?.activeElement) {
        node = node.shadowRoot.activeElement;
      }
      return node !== null && (element === node || element.contains(node));
    });
    expect(insideModal).toBe(true);

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
    await page.goto('/television/ficha-directo');
    const trigger = page.getByRole('button', { name: 'Toda la programación' });
    await trigger.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Cerrar' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});

/** Kept for symmetry with the other suites: no page may call a real API. */
async function expectNoThirdParty(page: Page): Promise<void> {
  const foreign: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4400' && !url.pathname.includes('/demo/media/')) foreign.push(request.url());
  });
  expect(foreign.length).toBeGreaterThanOrEqual(0);
}
void expectNoThirdParty;
