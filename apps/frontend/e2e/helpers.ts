import { expect, type Page, type Route } from '@playwright/test';

/**
 * Shared E2E helpers.
 *
 * Catalog and EPG calls are intercepted with deterministic fixtures so failures
 * are attributable to our code, not to a third party. Media is NOT intercepted:
 * playback is exercised against the real bundled HLS files served over HTTP.
 */

const HOUR = 3600;

function hourFromNow(offset: number): number {
  const base = new Date();
  base.setMinutes(0, 0, 0);
  return Math.floor(base.getTime() / 1000) + offset * HOUR;
}

export function catalogFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const channels = [
    {
      name: 'La Uno',
      web: 'https://example.org/uno',
      epg_id: 'LaUno.TV',
      options: [{ format: 'm3u8', url: '/demo/media/high/index.m3u8' }],
      extra_info: [],
    },
    {
      name: 'La Dos',
      web: 'https://example.org/dos',
      epg_id: 'LaDos.TV',
      options: [{ format: 'm3u8', url: '/demo/media/single/index.m3u8' }],
      extra_info: [],
    },
    {
      name: 'Canal Alternativo',
      web: 'https://example.org/alt',
      epg_id: 'Alt.TV',
      options: [{ format: 'm3u8', url: '/demo/media/master.m3u8' }],
      extra_info: [],
    },
    {
      /*
       * A dead source with NO official route: the emitter's `web` link is
       * deliberately absent, because a published route of any kind turns an
       * exhausted channel into the honest `external-official` state (see
       * `terminalNoFallbackStatus`). "Solo Externo" covers the routed case.
       */
      name: 'Señal Rota',
      options: [{ format: 'm3u8', url: '/demo/media/broken/index.m3u8' }],
      extra_info: [],
    },
    {
      name: 'Solo Externo',
      web: 'https://example.org/externo',
      epg_id: 'Ext.TV',
      options: [],
      extra_info: ['EXTA', 'GEO'],
    },
    {
      name: 'Sin Emisión',
      web: 'https://example.org/noem',
      options: [],
      extra_info: ['NOEM'],
    },
    {
      name: 'Sin Guía',
      web: 'https://example.org/singuia',
      options: [{ format: 'm3u8', url: '/demo/media/low/index.m3u8' }],
      extra_info: [],
    },
  ];

  return {
    license: { source: 'e2e fixture', url: 'https://example.org' },
    epg: { json: 'https://upstream.invalid/epg.json' },
    countries: [
      {
        name: 'Spain',
        ambits: [{ name: 'Generalistas', channels }],
      },
      {
        name: 'International',
        ambits: [
          {
            name: 'Int. Europa',
            channels: [
              {
                name: 'Europe News',
                web: 'https://example.org/eu',
                epg_id: 'EUNews.TV',
                options: [{ format: 'm3u8', url: '/demo/media/single/index.m3u8' }],
                extra_info: [],
              },
            ],
          },
        ],
      },
    ],
    updated: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

export function epgFixture(): Record<string, unknown> {
  const events = [
    { hi: hourFromNow(-3), hf: hourFromNow(-1), t: 'Programa anterior', d: 'Antes', g: 'NEWS' },
    { hi: hourFromNow(-1), hf: hourFromNow(1), t: 'Programa en directo', d: 'Ahora mismo', g: 'NEWS' },
    { hi: hourFromNow(1), hf: hourFromNow(3), t: 'Siguiente programa', d: 'Después', g: 'FILM' },
    { hi: hourFromNow(3), hf: hourFromNow(5), t: 'Programa tardío', d: 'Al final', g: 'CULTURE' },
  ];
  return {
    0: { name: 'LaUno.TV', events },
    1: { name: 'LaDos.TV', events },
    2: { name: 'Alt.TV', events },
    3: { name: 'Ext.TV', events },
    4: { name: 'EUNews.TV', events },
    // 'Sin Guía' has no entry on purpose.
  };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });
}

export async function stubData(
  page: Page,
  options: { catalog?: unknown; epg?: unknown; failCatalog?: boolean; failEpg?: boolean } = {},
): Promise<void> {
  const catalog = options.catalog ?? catalogFixture();
  const epg = options.epg ?? epgFixture();

  await page.route('**/lists/tv.json*', async (route) => {
    if (options.failCatalog) {
      await route.abort('failed');
      return;
    }
    await fulfillJson(route, catalog);
  });

  await page.route('**/epg/TV.json*', async (route) => {
    if (options.failEpg) {
      await route.abort('failed');
      return;
    }
    await fulfillJson(route, epg);
  });
}

/** Waits until the catalogue has rendered and reports its count. */
export async function waitForCatalogue(page: Page): Promise<void> {
  await expect(page.getByTestId('catalogue-summary')).not.toHaveText(/Cargando/i);
  await expect(page.locator('app-channel-tile').first()).toBeVisible();
}

export async function searchFor(page: Page, text: string): Promise<void> {
  const input = page.getByLabel('Buscar canal');
  await input.fill(text);
}

/** Reads the player state probe exposed by the player component. */
export async function playerState(page: Page): Promise<{ status: string; engine: string | null }> {
  const probe = page.getByTestId('player-state');
  return {
    status: (await probe.textContent())?.trim() ?? '',
    engine: await probe.getAttribute('data-engine'),
  };
}

/** Waits until the video element is actually decoding frames. */
export async function waitForFrames(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const video = document.querySelector('video');
      return !!video && video.readyState >= 2 && video.videoWidth > 0;
    },
    undefined,
    { timeout },
  );
}
