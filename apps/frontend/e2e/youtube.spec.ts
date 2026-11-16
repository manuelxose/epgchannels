import { expect, test } from '@playwright/test';
import { stubApi } from './helpers';
import {
  emitPlayerError,
  emitPlayerState,
  enableDataApi,
  navigateInApp,
  playerStatus,
  stubYoutube,
  waitForStatus,
  youtubeProbe,
  YOUTUBE_CHANNELS,
} from './youtube-helpers';

/**
 * In-app YouTube playback through the descriptors our API produces.
 *
 * Every assertion is about *our* behaviour on top of the official player: which
 * descriptor the API offers, which engine the client selects, whether the iframe
 * is released, and whether we claim "playing" only when YouTube says so. The
 * IFrame API is a local stub that behaves like the real one, so the suite is
 * deterministic and offline.
 */
test.describe('YouTube en el reproductor propio', () => {
  test.beforeEach(async ({ page }) => {
    await stubApi(page, {
      youtubeChannels: YOUTUBE_CHANNELS,
    });
    await stubYoutube(page);
  });

  test('un vídeo directo se reproduce con el motor oficial dentro de nuestra interfaz', async ({ page }) => {
    await page.goto('/television/yt-directo');
    await expect.poll(async () => (await youtubeProbe(page)).players, { timeout: 20_000 }).toBeGreaterThan(0);
    const probe = await youtubeProbe(page);
    expect(probe.configs[0]?.videoId).toBe('OkQduT-9Pyc');
    expect(probe.iframes).toBe(1);
    await emitPlayerState(page, 1);
    await waitForStatus(page, 'playing');
  });

  test('«reproduciendo» solo se declara cuando YouTube lo dice', async ({ page }) => {
    await page.goto('/television/yt-watch');
    await expect.poll(async () => (await youtubeProbe(page)).players, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(() => playerStatus(page)).not.toBe('playing');
    await emitPlayerState(page, 2);
    await expect.poll(() => playerStatus(page)).not.toBe('playing');
    await emitPlayerState(page, 1);
    await waitForStatus(page, 'playing');
  });

  test('un canal de YouTube se resuelve a su vídeo con la API de datos', async ({ page }) => {
    await enableDataApi(page, { live: true });
    await page.goto('/television/yt-canal');
    await expect.poll(async () => (await youtubeProbe(page)).players, { timeout: 25_000 }).toBeGreaterThan(0);
    const probe = await youtubeProbe(page);
    expect(probe.configs[0]?.videoId).toBe('cN8S9e2pLxI');
  });

  test('sin clave de API no se afirma que el canal esté en directo', async ({ page }) => {
    await page.goto('/television/yt-sin-clave');
    await expect.poll(() => playerStatus(page), { timeout: 25_000 }).not.toBe('playing');
  });

  test('el propietario prohíbe la incrustación: se explica y no se afirma reproducción', async ({ page }) => {
    await page.goto('/television/yt-prohibido');
    await expect.poll(async () => (await youtubeProbe(page)).players, { timeout: 20_000 }).toBeGreaterThan(0);
    await emitPlayerError(page, 150);
    await expect
      .poll(() => playerStatus(page), { timeout: 20_000 })
      .not.toBe('playing');
  });

  test('un directo terminado queda como no disponible, no como reproduciendo', async ({ page }) => {
    await page.goto('/television/yt-terminado');
    await expect.poll(async () => (await youtubeProbe(page)).players, { timeout: 20_000 }).toBeGreaterThan(0);
    await emitPlayerError(page, 100);
    await expect.poll(() => playerStatus(page), { timeout: 20_000 }).not.toBe('playing');
  });

  test('cambiar de un directo de YouTube a otro no acumula reproductores', async ({ page }) => {
    await page.goto('/television/yt-directo');
    await expect.poll(async () => (await youtubeProbe(page)).players, { timeout: 20_000 }).toBeGreaterThan(0);
    await emitPlayerState(page, 1);
    await waitForStatus(page, 'playing');

    await navigateInApp(page, 'yt-segundo');
    await expect.poll(async () => (await youtubeProbe(page)).configs.length, { timeout: 25_000 }).toBeGreaterThan(1);
    const probe = await youtubeProbe(page);
    expect(probe.livePlayers).toBe(1);
    expect(probe.configs.at(-1)?.videoId).toBe('hJ5nR0FXhCA');
  });

  test('un canal con HLS y YouTube elige el descriptor que ofrece la API', async ({ page }) => {
    await page.goto('/television/hls-y-yt');
    // The API prefers HLS for this channel: our own engine plays it, no iframe.
    await expect.poll(async () => playerStatus(page), { timeout: 30_000 }).toBe('playing');
    expect((await youtubeProbe(page)).players).toBe(0);
  });

});
