import { expect, test } from '@playwright/test';
import { stubData } from './helpers';

/**
 * Sending a channel to another screen on the network, end to end:
 *  - the player offers the link for a channel (falling back to the clipboard when
 *    the browser has no share sheet);
 *  - the OTHER device opens that link and arrives at the same channel;
 *  - a malformed link is ignored instead of trusted.
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

/** Makes the page behave like a browser without a share sheet but with a clipboard. */
const stubNoShareSheet = () => {
  (window as unknown as { __copied: string | null }).__copied = null;
  Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        (window as unknown as { __copied: string | null }).__copied = text;
        return Promise.resolve();
      },
    },
  });
};

test.describe('Enviar este canal a otra pantalla', () => {
  test('el reproductor ofrece el enlace del canal y lo copia si no hay hoja de compartir', async ({ page }) => {
    await stubData(page);
    await page.addInitScript(stubNoShareSheet);
    await page.goto('/television/la-uno');
    const share = page.getByTestId('share-button');
    await expect(share).toBeVisible({ timeout: 20_000 });
    await share.click();
    const copied = await page.evaluate(() => (window as unknown as { __copied: string | null }).__copied);
    expect(copied).toContain('#/cast/');
    await expect(page.getByTestId('cast-notice')).toContainText(/Enlace copiado/i);
  });

  test('el otro dispositivo abre el enlace y llega al mismo canal', async ({ page, browser }) => {
    await stubData(page);
    await page.addInitScript(stubNoShareSheet);
    await page.goto('/television/la-uno');
    await page.getByTestId('share-button').click({ timeout: 20_000 });
    const link = await page.evaluate(() => (window as unknown as { __copied: string | null }).__copied);
    expect(link).toContain('#/cast/');

    // Another "device": its own browser context, its own page.
    const receiver = await browser.newContext();
    const receiving = await receiver.newPage();
    await stubData(receiving);
    await receiving.goto(link ?? '');
    const incoming = receiving.getByTestId('incoming-cast');
    await expect(incoming).toBeVisible({ timeout: 20_000 });
    await expect(incoming).toContainText('La Uno');
    await expect(incoming.getByRole('link')).toHaveAttribute('href', /\/television\/la-uno$/);
    await receiver.close();
  });

  test('un enlace manipulado no se acepta', async ({ page }) => {
    await stubData(page);
    await page.goto('/television#/cast/esto-no-es-un-enlace');
    await expect(page.getByTestId('incoming-cast')).toHaveCount(0);
  });

  test('en un canal de YouTube se comparte el canal, nunca la emisión ajena', async ({ page }) => {
    await stubData(page, { catalog: youtubeOnlyCatalogue });
    await page.goto('/television/youtube-directo');
    await expect(page.getByTestId('yt-engine-shell')).toBeVisible({ timeout: 20_000 });
    // Sharing the channel exists; handing YouTube's player to a device does not.
    await expect(page.getByTestId('share-button')).toBeVisible();
    await expect(page.getByTestId('cast-button')).toHaveCount(0);
  });
});
