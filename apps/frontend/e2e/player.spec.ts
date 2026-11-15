import { expect, test } from '@playwright/test';
import { playerState, stubData, waitForCatalogue, waitForFrames } from './helpers';

test.describe('Reproductor', () => {
  test.beforeEach(async ({ page }) => {
    await stubData(page);
  });

  test('reproduce una señal HLS real con hls.js', async ({ page }) => {
    await page.goto('/television/la-uno');
    await waitForFrames(page);

    const video = page.locator('video');
    const dimensions = await video.evaluate((element) => {
      const media = element as HTMLVideoElement;
      return { width: media.videoWidth, height: media.videoHeight, readyState: media.readyState };
    });
    expect(dimensions.readyState).toBeGreaterThanOrEqual(2);
    expect(dimensions.width).toBeGreaterThan(0);
    expect(dimensions.height).toBeGreaterThan(0);

    const state = await playerState(page);
    expect(['playing', 'paused', 'buffering']).toContain(state.status);
    expect(state.engine).toBe('hls');
  });

  test('play y pausa controlan el elemento multimedia', async ({ page }) => {
    await page.goto('/television/la-uno');
    await waitForFrames(page);

    const playButton = page.getByRole('button', { name: 'Reproducir', exact: true });
    const pauseButton = page.getByRole('button', { name: 'Pausar' });

    if (await playButton.isVisible().catch(() => false)) {
      await playButton.click();
    }
    await expect(pauseButton).toBeVisible();
    await page.waitForFunction(() => !(document.querySelector('video') as HTMLVideoElement | null)?.paused);

    await pauseButton.click();
    await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement | null)?.paused === true);
    await expect(page.getByRole('button', { name: 'Reproducir', exact: true })).toBeVisible();
  });

  test('el silencio alterna sin reiniciar la emisión', async ({ page }) => {
    await page.goto('/television/la-uno');
    await waitForFrames(page);
    await page.getByRole('button', { name: 'Reproducir', exact: true }).click().catch(() => undefined);
    await page.waitForFunction(() => !(document.querySelector('video') as HTMLVideoElement | null)?.paused);

    // Count media load cycles: a reload is exactly what must NOT happen here.
    await page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement;
      (window as unknown as { __loadstarts: number; __src: string }).__loadstarts = 0;
      (window as unknown as { __loadstarts: number; __src: string }).__src = video.currentSrc || video.src;
      video.addEventListener('loadstart', () => {
        (window as unknown as { __loadstarts: number }).__loadstarts += 1;
      });
    });

    const before = await page.locator('video').evaluate((element) => {
      const media = element as HTMLVideoElement;
      return { currentTime: media.currentTime, src: media.currentSrc || media.src };
    });

    await page.getByRole('button', { name: 'Silenciar' }).click();
    await expect(page.getByRole('button', { name: 'Activar sonido' })).toBeVisible();
    await page.waitForTimeout(1200);

    const after = await page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement;
      const state = window as unknown as { __loadstarts: number; __src: string };
      return {
        muted: video.muted,
        currentTime: video.currentTime,
        paused: video.paused,
        src: video.currentSrc || video.src,
        loadstarts: state.__loadstarts,
        srcBefore: state.__src,
      };
    });

    expect(after.muted).toBe(true);
    // Muting must not tear the stream down: same source, no reload, still moving.
    expect(after.loadstarts).toBe(0);
    expect(after.src).toBe(after.srcBefore);
    expect(after.paused).toBe(false);
    expect(after.currentTime).toBeGreaterThan(before.currentTime);
  });

  test('cambiar de canal reemplaza el reproductor sin acumular elementos', async ({ page }) => {
    await page.goto('/television/la-uno');
    await waitForFrames(page);

    for (const slug of ['la-dos', 'canal-alternativo', 'la-uno']) {
      await page.evaluate((target) => {
        history.pushState({}, '', `/television/${target}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, slug);
      await expect(page.locator('video')).toHaveCount(1);
      await waitForFrames(page);
    }
    await expect(page.locator('video')).toHaveCount(1);
  });

  test('una fuente caída muestra error con acción de reintento', async ({ page }) => {
    await page.goto('/television/senal-rota');
    const alert = page.getByTestId('player-alert');
    await expect(alert).toBeVisible({ timeout: 45_000 });
    /*
     * The fixture publishes a single source whose only segment is missing, so
     * every eligible source is exhausted: the precise user-facing state is
     * "source unavailable", not a recoverable failure of one source.
     */
    await expect(alert).toContainText('Ninguna fuente de este canal está disponible');
    await expect(alert).toHaveAttribute('data-playback-state', 'source-unavailable');
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
    await expect(alert).toContainText('Fuente: Emisión 1');
  });

  test('un canal sin reproducción permitida muestra la explicación, no un reproductor', async ({ page }) => {
    await page.goto('/television/solo-externo');
    await expect(page.getByRole('heading', { name: 'Solo Externo no emite su vídeo aquí' })).toBeVisible();
    await expect(page.locator('video')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Abrir la página del emisor/ })).toHaveAttribute(
      'href',
      'https://example.org/externo',
    );
    // The guide is still shown for a channel that cannot be played here.
    await expect(page.locator('app-programme-panel')).toContainText('Programa en directo');
  });

  test('un canal sin emisión por internet lo indica y conserva la guía', async ({ page }) => {
    await page.goto('/television/sin-emision');
    await expect(page.getByRole('heading', { name: 'De Sin Emisión solo tenemos la guía' })).toBeVisible();
    await expect(page.locator('video')).toHaveCount(0);
    await expect(page.locator('app-programme-panel')).toBeVisible();
  });

  test('un canal inexistente ofrece volver al catálogo', async ({ page }) => {
    await page.goto('/television/canal-que-no-existe');
    await waitForCatalogue(page);
    await expect(page.getByTestId('channel-not-found')).toBeVisible();
    await page.getByRole('link', { name: 'Volver al catálogo' }).click();
    await expect(page).toHaveURL(/\/television$/);
  });

  test('pantalla completa se ofrece solo cuando el navegador lo soporta', async ({ page }) => {
    await page.goto('/television/la-uno');
    await waitForFrames(page);
    const fullscreen = page.getByRole('button', { name: 'Pantalla completa' });
    const supported = await page.evaluate(() => typeof document.documentElement.requestFullscreen === 'function');
    if (supported) {
      await expect(fullscreen).toBeVisible();
    } else {
      await expect(fullscreen).toHaveCount(0);
    }
  });
});
