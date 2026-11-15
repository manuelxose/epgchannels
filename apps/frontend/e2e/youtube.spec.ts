import { expect, test, type Page } from '@playwright/test';
import { stubData } from './helpers';
import {
  emitPlayerError,
  emitPlayerState,
  enableDataApi,
  navigateInApp,
  playerStatus,
  stubYoutube,
  waitForStatus,
  youtubeCatalogue,
  youtubeProbe,
} from './youtube-helpers';

/**
 * TDT-CLONE-12 §6 — in-app YouTube playback, end to end.
 *
 * The IFrame API is a local stub that behaves like the real one (it creates a
 * player and an iframe, and the test drives `onStateChange`/`onError`), so every
 * assertion here is deterministic and offline. "PASS" is never "the iframe
 * loaded": the assertions are on OUR state machine reacting to the player's real
 * state transitions.
 */

test.describe('TDT-CLONE-12 · reproducción integrada de YouTube', () => {
  test.beforeEach(async ({ page }) => {
    await stubData(page, { catalog: youtubeCatalogue() });
    await stubYoutube(page);
  });

  /**
   * Waits for the YouTube player to be created.
   *
   * A YouTube source starts on its own: the engine creates the official player
   * when the watch page mounts (the page itself is the user's click on the
   * channel), which is also why there is no transport button to press — our
   * controls are not rendered over the official player.
   */
  async function start(page: Page): Promise<void> {
    await page.getByTestId('yt-engine-shell').waitFor({ state: 'visible' });
    await expect.poll(async () => (await youtubeProbe(page)).players, { timeout: 20_000 }).toBe(1);
  }

  test('1 · una URL con VIDEO_ID se reproduce dentro de nuestra página', async ({ page }) => {
    await page.goto('/television/youtube-directo');
    // The official frame appears only after the engine starts (click-to-play).
    await start(page);
    await expect.poll(async () => (await youtubeProbe(page)).players, { timeout: 20_000 }).toBe(1);

    const probe = await youtubeProbe(page);
    expect(probe.configs[0].videoId).toBe('OkQduT-9Pyc');
    expect(probe.configs[0].host).toBe('https://www.youtube-nocookie.com');
    // Playback starts muted-neutral: the config keeps our origin.
    expect(probe.configs[0].playerVars['origin']).toBe('http://127.0.0.1:4400');

    // The iframe alone proves NOTHING. Only PLAYING does.
    expect(await playerStatus(page)).not.toBe('playing');
    await emitPlayerState(page, 1);
    await waitForStatus(page, 'playing');

    // Still on our page, still our navigation.
    expect(new URL(page.url()).pathname).toBe('/television/youtube-directo');
    expect((await youtubeProbe(page)).iframes).toBe(1);
  });

  test('2 · una URL /live/VIDEO_ID se reproduce integrada', async ({ page }) => {
    await page.goto('/television/youtube-directo');
    await start(page);
    await expect.poll(async () => (await youtubeProbe(page)).players, { timeout: 20_000 }).toBe(1);
    await emitPlayerState(page, 1);
    await waitForStatus(page, 'playing');

    // The frame points at the privacy-enhanced embed of that very video.
    const src = await page.getByTestId('yt-engine-shell').locator('iframe').getAttribute('src');
    expect(src).toContain('youtube-nocookie.com/embed/OkQduT-9Pyc');
  });

  test('3 · una URL de canal con emisión activa se resuelve y se reproduce', async ({ page }) => {
    await enableDataApi(page, { live: true });
    await page.goto('/television/youtube-canal');
    await start(page);
    await expect.poll(async () => (await youtubeProbe(page)).players, { timeout: 20_000 }).toBe(1);

    // The resolved VIDEO is what the official player is given — not the channel page.
    const probe = await youtubeProbe(page);
    expect(probe.configs[0].videoId).toBe('cN8S9e2pLxI');

    await emitPlayerState(page, 1);
    await waitForStatus(page, 'playing');
  });

  test('4 · un canal sin emisión activa lo dice y no monta un reproductor', async ({ page }) => {
    await enableDataApi(page, { live: false });
    await page.goto('/television/youtube-canal');

    /*
     * The reason is shown to the user, in OUR player panel. The channel's page is
     * still offered as an action (its `web` link makes the terminal state
     * `external-official`, whose message comes from the recorded failure).
     */
    const alert = page.getByTestId('player-alert');
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(alert).toContainText('El canal no está emitiendo ahora.');
    // Nothing was mounted: no dead player claiming to be live.
    expect((await youtubeProbe(page)).players).toBe(0);
    expect(await playerStatus(page)).not.toBe('playing');
  });

  test('5 · un vídeo que no permite incrustación se explica y no se reproduce', async ({ page }) => {
    await page.goto('/television/youtube-prohibido');
    await start(page);

    // YouTube's documented refusal for the owner forbidding embedding.
    await emitPlayerError(page, 150);
    const alert = page.getByTestId('player-alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/no permite incrustar/i);
    // Never claimed as playing.
    expect(await playerStatus(page)).not.toBe('playing');
    expect(await playerStatus(page)).toBe('blocked');
    // A way out that stays on YouTube: the official page of THAT video, offered
    // next to the player (not buried in a generic link to the emitter's site).
    await expect(page.getByTestId('yt-official-link').getByRole('link')).toHaveAttribute(
      'href',
      'https://www.youtube.com/watch?v=Pz_yFcM45sc',
    );
  });

  test('5b · 101, 153 y 100 se distinguen entre sí', async ({ page }) => {
    for (const [code, pattern, playbackState] of [
      [101, /no permite incrustar/i, 'unauthorised'],
      [153, /identifica/i, 'unauthorised'],
      [100, /ya no está disponible/i, 'source-unavailable'],
    ] as const) {
      await page.goto('/television/youtube-directo');
      await start(page);
      await emitPlayerError(page, code);
      // The reason is the answer: its own explanation, not a generic redirect.
      const alert = page.getByTestId('player-alert');
      await expect(alert, `código ${code}`).toContainText(pattern);
      await expect(page.getByTestId('player-state'), `código ${code}`).toHaveAttribute(
        'data-playback-state',
        playbackState,
      );
      expect(await playerStatus(page), `código ${code}`).not.toBe('playing');
    }
  });

  test('6 · cambio YouTube → HLS: se libera el reproductor de YouTube', async ({ page }) => {
    // A channel publishing both: start on YouTube, then switch to the HLS source
    // with the real source picker. Exactly one engine must survive.
    await page.goto('/television/youtube-y-hls');
    await page.getByTestId('yt-engine-shell').waitFor({ state: 'visible' });
    await start(page);
    await expect.poll(async () => (await youtubeProbe(page)).players, { timeout: 20_000 }).toBe(1);
    await emitPlayerState(page, 1);
    await waitForStatus(page, 'playing');
    expect((await youtubeProbe(page)).livePlayers).toBe(1);

    const picker = page.locator('app-channel-header select');
    await expect(picker).toBeVisible();
    // The HLS source is the second option of this fixture.
    await picker.selectOption({ index: 1 });

    // The YouTube player is released and the media element takes over.
    await expect.poll(async () => (await youtubeProbe(page)).destroyed, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    expect((await youtubeProbe(page)).livePlayers).toBe(0);
    await expect
      .poll(() => page.getByTestId('player-state').getAttribute('data-engine'), { timeout: 20_000 })
      .toBe('hls');
    expect(new URL(page.url()).pathname).toBe('/television/youtube-y-hls');
  });

  test('7 · cambio HLS → YouTube: sólo queda un reproductor vivo', async ({ page }) => {
    await page.goto('/television/hls-y-youtube');
    // This channel publishes HLS first: it starts on HLS with no YouTube player.
    await page.locator('.ctl--play').click();
    await expect
      .poll(() => page.getByTestId('player-state').getAttribute('data-engine'), { timeout: 20_000 })
      .toBe('hls');
    expect((await youtubeProbe(page)).livePlayers).toBe(0);

    // Switch to the YouTube source through the picker.
    const picker = page.locator('app-channel-header select');
    await expect(picker).toBeVisible();
    await picker.selectOption({ index: 1 });

    await expect.poll(async () => (await youtubeProbe(page)).players, { timeout: 20_000 }).toBe(1);
    await emitPlayerState(page, 1);
    await waitForStatus(page, 'playing');
    expect((await youtubeProbe(page)).iframes).toBe(1);
    expect((await youtubeProbe(page)).livePlayers).toBe(1);
    expect(new URL(page.url()).pathname).toBe('/television/hls-y-youtube');
  });

  test('8 · cambio entre dos emisiones de YouTube: una sola activa', async ({ page }) => {
    // Same document, same shell: navigate in-app from one YouTube live to another.
    await page.goto('/television/youtube-directo');
    await start(page);
    await expect.poll(async () => (await youtubeProbe(page)).players, { timeout: 20_000 }).toBe(1);
    await emitPlayerState(page, 1);
    await waitForStatus(page, 'playing');

    await navigateInApp(page, 'youtube-segundo');
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe('/television/youtube-segundo');
    await expect.poll(async () => (await youtubeProbe(page)).players, { timeout: 20_000 }).toBe(2);
    const probe = await youtubeProbe(page);
    // The previous player was destroyed and the new one is alive: exactly one
    // frame exists, so the two emissions never play at the same time.
    expect(probe.configs[1].videoId).toBe('hJ5nR0FXhCA');
    expect(probe.destroyed).toBe(1);
    expect(probe.iframes).toBe(1);
    await emitPlayerState(page, 1);
    await waitForStatus(page, 'playing');
  });

  test('9 · silencio y volumen no recrean el reproductor', async ({ page }) => {
    await page.goto('/television/youtube-directo');
    await start(page);
    await expect.poll(async () => (await youtubeProbe(page)).players, { timeout: 20_000 }).toBe(1);
    await emitPlayerState(page, 1);
    await waitForStatus(page, 'playing');

    /*
     * The official player renders its own mandatory controls, so our transport
     * bar (and its volume slider) is not shown over it: two control sets would
     * compete for the same clicks and ours could not drive YouTube's quality
     * menu.
     */
    await expect(page.locator('input[type="range"][aria-label="Volumen"]')).toHaveCount(0);
    await expect(page.locator('.controls')).toHaveCount(0);

    // The volume the user chose is handed to the LIVE official player, and only
    // once: `setVolume` is our controller talking to YouTube, not a rebuild.
    const first = await youtubeProbe(page);
    expect(first.calls.filter((call) => call === 'setVolume:80')).toHaveLength(1);
    expect(first.players).toBe(1);
    expect(first.destroyed).toBe(0);

    // Reloading with a different stored volume applies it to a NEW player
    // (expected: a reload is a new player), still exactly once and never twice.
    await page.evaluate(() => localStorage.setItem('tdtpref.volume', '0.35'));
    await page.reload();
    await start(page);
    await expect.poll(async () => (await youtubeProbe(page)).players, { timeout: 20_000 }).toBe(1);
    const second = await youtubeProbe(page);
    expect(second.calls.filter((call) => call === 'setVolume:35')).toHaveLength(1);
    expect(second.destroyed).toBe(0);
  });

  test('10 · destrucción: al salir de la ficha se elimina el iframe', async ({ page }) => {
    await page.goto('/television/youtube-directo');
    await start(page);
    await expect.poll(async () => (await youtubeProbe(page)).players, { timeout: 20_000 }).toBe(1);
    await emitPlayerState(page, 1);
    await waitForStatus(page, 'playing');
    expect((await youtubeProbe(page)).iframes).toBe(1);

    // Leaving the channel must release the official player in the same document.
    await navigateInApp(page, 'youtube-segundo');
    await expect.poll(async () => (await youtubeProbe(page)).destroyed, { timeout: 20_000 }).toBe(1);
    // No orphan frame survives anywhere in the document.
    expect(await page.locator('iframe.fake-yt-frame').count()).toBe(1);
    expect((await youtubeProbe(page)).livePlayers).toBe(1);
  });

  test('11 · los estados del reproductor se corresponden con la API de YouTube', async ({ page }) => {
    await page.goto('/television/youtube-directo');
    await start(page);

    /*
     * A mounted, ready player is NOT "playing": the engine reported `can-play`
     * and the shell settles on `paused` until the official API says PLAYING.
     * This is the core honesty rule of the milestone.
     */
    expect(await playerStatus(page)).toBe('paused');

    // -1 (unstarted) and 3 (buffering) are not "playing" either.
    await emitPlayerState(page, -1);
    expect(await playerStatus(page)).not.toBe('playing');
    // Buffering only means buffering once playback has begun; before that the
    // player is simply still starting, which is `paused` (not a new claim).
    await emitPlayerState(page, 3);
    expect(await playerStatus(page)).not.toBe('playing');

    await emitPlayerState(page, 1);
    await waitForStatus(page, 'playing');
    await emitPlayerState(page, 3);
    await waitForStatus(page, 'buffering');
    await emitPlayerState(page, 1);
    await waitForStatus(page, 'playing');
    await emitPlayerState(page, 2);
    await waitForStatus(page, 'paused');
    await emitPlayerState(page, 1);
    await waitForStatus(page, 'playing');
    // A finished live is off air, never a healthy player.
    await emitPlayerState(page, 0);
    await expect.poll(() => playerStatus(page), { timeout: 10_000 }).not.toBe('playing');
  });

  test('12 · reproducción en móvil: el reproductor oficial ocupa el escenario', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.includes('mobile'), 'Se ejecuta en el proyecto móvil');
    await page.goto('/television/youtube-directo');
    await start(page);
    await expect.poll(async () => (await youtubeProbe(page)).players, { timeout: 20_000 }).toBe(1);
    await emitPlayerState(page, 1);
    await waitForStatus(page, 'playing');

    const box = await page.getByTestId('yt-engine-shell').locator('iframe').boundingBox();
    expect(box).not.toBeNull();
    // The published minimum is 200×200; ours fills a 16:9 stage on a phone.
    expect(box!.width).toBeGreaterThanOrEqual(200);
    expect(box!.height).toBeGreaterThanOrEqual(200);
    // Inline playback: the frame asks YouTube not to take over the screen.
    const probe = await youtubeProbe(page);
    expect(probe.configs[0].playerVars['playsinline']).toBe(1);
  });
});

test.describe('TDT-CLONE-12 · sin clave de API y sin identificador', () => {
  test.beforeEach(async ({ page }) => {
    await stubData(page, { catalog: youtubeCatalogue() });
    await stubYoutube(page);
  });

  /*
   * Reported bug (La Septima, written without its accent): with no Data API key
   * the app said "ninguna fuente disponible". That was wrong - YouTube's
   * documented channel embed is public and needs no key. Now the channel is
   * mounted in our player and the app states honestly that the emission status is
   * YouTube's to show.
   */
  test('sin clave se muestra el canal con el reproductor oficial (no "ninguna fuente")', async ({ page }) => {
    let apiCalls = 0;
    await page.route('https://www.googleapis.com/**', async (route) => {
      apiCalls += 1;
      await route.abort('failed');
    });
    await page.goto('/television/youtube-sin-clave');

    // The player is mounted, inside our page, with the documented channel embed
    // and the published autoplay parameters that make it start on its own.
    await expect(page.getByTestId('yt-engine-shell')).toBeVisible();
    const src = (await page.getByTestId('yt-engine-shell').locator('iframe').getAttribute('src')) ?? '';
    const parsed = new URL(src);
    expect(parsed.origin).toBe('https://www.youtube-nocookie.com');
    expect(parsed.pathname).toBe('/embed/live_stream');
    expect(parsed.searchParams.get('channel')).toBe('UC7QZIf0dta-XPXsp9Hv4dTw');
    expect(parsed.searchParams.get('autoplay')).toBe('1');
    expect(parsed.searchParams.get('playsinline')).toBe('1');
    // The frame is allowed to play without a user gesture.
    await expect(page.getByTestId('yt-engine-shell').locator('iframe')).toHaveAttribute('allow', /autoplay/);
    // No "no source available" dead end.
    await expect(page.getByTestId('player-alert')).toHaveCount(0);
    // Not observable => never claimed as playing.
    expect(await playerStatus(page)).not.toBe('playing');
    // No Data API call was made.
    expect(apiCalls).toBe(0);
  });

  test('un handle no se incrusta ni se trata como vídeo', async ({ page }) => {
    await page.goto('/television/youtube-handle');
    // A handle names a channel but carries no id we could verify: the page keeps
    // its official link and no player is created anywhere.
    await expect(page.getByTestId('state-official-site')).toBeVisible();
    await expect(page.getByRole('link', { name: /página del emisor|Sitio oficial/i }).first()).toBeVisible();
    expect((await youtubeProbe(page)).players).toBe(0);
  });
});
