import { expect, type Page, type Route } from '@playwright/test';

/**
 * Shared E2E helpers for in-app YouTube playback.
 *
 * Everything here is deterministic and offline: our API is served from fixtures
 * that carry the YouTube descriptors (`engine: youtube-iframe`), and
 * `https://www.youtube.com/iframe_api` is fulfilled from a local stub that
 * behaves like the real API. No request ever reaches YouTube.
 */

/** What the fake player exposes to the test through `window.__yt`. */
export interface YoutubeProbe {
  readonly players: number;
  readonly livePlayers: number;
  readonly destroyed: number;
  readonly configs: {
    host: string;
    videoId: string | null;
    playerVars: Record<string, string | number>;
  }[];
  readonly calls: string[];
  readonly iframes: number;
}

/**
 * A stand-in for the published IFrame API.
 *
 * `window.__yt.players` counts creations and `__yt.destroyed` counts teardowns,
 * so "no simultaneous playback" and "the iframe is released" are measurable.
 * The stub also exposes `__yt.state(code)` and `__yt.error(code)`.
 */
export const YOUTUBE_API_STUB = `
(function () {
  window.__yt = window.__yt || {
    players: 0, livePlayers: 0, destroyed: 0, configs: [], calls: [], instances: [], state: null, error: null
  };
  function bind(instance, config) {
    var events = config.events || {};
    window.__yt.state = function (code) {
      instance.currentState = code;
      if (events.onStateChange) events.onStateChange({ target: instance, data: code });
    };
    window.__yt.error = function (code) {
      if (events.onError) events.onError({ target: instance, data: code });
    };
  }
  function Player(target, config) {
    var host = typeof target === 'string' ? document.getElementById(target) : target;
    var iframe = document.createElement('iframe');
    var params = new URLSearchParams();
    var vars = config.playerVars || {};
    Object.keys(vars).forEach(function (key) { params.set(key, String(vars[key])); });
    params.set('enablejsapi', '1');
    iframe.src = (config.host || 'https://www.youtube-nocookie.com') + '/embed/' +
      (config.videoId || 'live_stream') + '?' + params.toString();
    iframe.setAttribute('data-testid', 'youtube-iframe');
    iframe.setAttribute('title', 'Reproductor de YouTube');
    iframe.className = 'fake-yt-frame';
    iframe.width = '100%';
    iframe.height = '100%';
    iframe.style.border = '0';
    // The real API REPLACES the element it is given. The stub must too, or a test
    // would pass on a DOM shape the production API never produces.
    if (host && host.parentNode) {
      host.parentNode.replaceChild(iframe, host);
    } else if (host) {
      host.replaceChildren(iframe);
    }
    var instance = this;
    instance.currentState = -1;
    window.__yt.players += 1;
    window.__yt.livePlayers += 1;
    window.__yt.configs.push({ host: config.host || null, videoId: config.videoId || null, playerVars: vars });
    window.__yt.instances.push(instance);
    bind(instance, config);
    this.getIframe = function () { return iframe; };
    this.playVideo = function () { window.__yt.calls.push('playVideo'); };
    this.pauseVideo = function () { window.__yt.calls.push('pauseVideo'); };
    this.setVolume = function (value) { window.__yt.calls.push('setVolume:' + value); };
    this.getVolume = function () { return 100; };
    this.mute = function () { window.__yt.calls.push('mute'); };
    this.unMute = function () { window.__yt.calls.push('unMute'); };
    this.isMuted = function () { return false; };
    this.getPlayerState = function () { return instance.currentState; };
    this.getVideoLoadedFraction = function () { return 1; };
    this.seekTo = function (seconds, allow) { window.__yt.calls.push('seekTo:' + allow); };
    this.destroy = function () {
      window.__yt.destroyed += 1;
      window.__yt.livePlayers -= 1;
      iframe.remove();
      if (window.__yt.destroyCalls) window.__yt.destroyCalls();
    };
    setTimeout(function () {
      if (config.events && config.events.onReady) config.events.onReady({ target: instance });
    }, 0);
  }
  // MEASURED against the real service: the iframe_api script's load event fires
  // BEFORE YT.Player exists, and the API announces readiness by calling
  // window.onYouTubeIframeAPIReady a moment later. Reproduced here on purpose.
  setTimeout(function () {
    window.YT = { Player: Player, PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } };
    if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady();
  }, 0);
})();
`;

/** Serves the API stub locally and aborts every other YouTube request. */
export async function stubYoutube(page: Page): Promise<void> {
  await page.route('https://www.youtube.com/iframe_api', async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: YOUTUBE_API_STUB });
  });
  await page.route(/https:\/\/(www\.)?(youtube|youtube-nocookie)\.com\/(?!iframe_api)/, async (route: Route) => {
    await route.abort('blockedbyclient');
  });
}

/** Reads the fake player's probe. */
export async function youtubeProbe(page: Page): Promise<YoutubeProbe> {
  return page.evaluate(() => {
    const yt = (window as unknown as { __yt?: Record<string, unknown> }).__yt;
    return {
      players: Number(yt?.['players'] ?? 0),
      livePlayers: Number(yt?.['livePlayers'] ?? 0),
      destroyed: Number(yt?.['destroyed'] ?? 0),
      configs: (yt?.['configs'] as YoutubeProbe['configs']) ?? [],
      calls: (yt?.['calls'] as string[]) ?? [],
      iframes: document.querySelectorAll('[data-testid="yt-engine-shell"] iframe').length,
    };
  });
}

/** Drives the fake player's state, exactly like `YT.PlayerState` would report. */
export async function emitPlayerState(page: Page, code: number): Promise<void> {
  await page.evaluate((state: number) => {
    (window as unknown as { __yt?: { state?: (value: number) => void } }).__yt?.state?.(state);
  }, code);
}

export async function emitPlayerError(page: Page, code: number): Promise<void> {
  await page.evaluate((errorCode: number) => {
    (window as unknown as { __yt?: { error?: (value: number) => void } }).__yt?.error?.(errorCode);
  }, code);
}

/**
 * Turns on the channel → live resolution for the current page, the way a
 * deployment with a (restricted) Data API key would, and stubs the documented
 * endpoints with a deterministic answer.
 */
export async function enableDataApi(
  page: Page,
  options: { live: boolean; videoId?: string; embeddable?: boolean },
): Promise<void> {
  const videoId = options.videoId ?? 'cN8S9e2pLxI';
  await page.addInitScript(() => {
    (window as unknown as { TDT_YOUTUBE_API_KEY?: string }).TDT_YOUTUBE_API_KEY = 'e2e-restricted-key';
  });
  await page.route('https://www.googleapis.com/youtube/v3/search**', async (route: Route) => {
    const channelId = new URL(route.request().url()).searchParams.get('channelId') ?? '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(
        options.live ? { items: [{ id: { kind: 'youtube#video', videoId }, channelId }] } : { items: [] },
      ),
    });
  });
  await page.route('https://www.googleapis.com/youtube/v3/videos**', async (route: Route) => {
    const url = new URL(route.request().url());
    const ids = (url.searchParams.get('id') ?? '').split(',');
    const channelId = 'UCOCGPFW1UqPP9zdol7vEK1A';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        items: ids.filter(Boolean).map((id) => ({
          id,
          status: { embeddable: options.embeddable !== false },
          snippet: { channelId, liveBroadcastContent: 'live', title: 'Canal en directo' },
        })),
      }),
    });
  });
}

/** Navigates INSIDE the running application, so page script state survives. */
export async function navigateInApp(page: Page, channelSlug: string): Promise<void> {
  await page.evaluate((slug: string) => {
    const link = document.querySelector(`a[href$="/television/${slug}"]`) as HTMLAnchorElement | null;
    if (link) {
      link.click();
      return;
    }
    history.pushState({}, '', `/television/${slug}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, channelSlug);
}

declare global {
  interface Window {
    __ytChannel?: string;
  }
}

/** The player status probe rendered by our shell. */
export async function playerStatus(page: Page): Promise<string> {
  return ((await page.getByTestId('player-state').textContent()) ?? '').trim();
}

/** Waits until our own state machine reports `status`. */
export async function waitForStatus(page: Page, status: string, timeout = 15_000): Promise<void> {
  await expect.poll(() => playerStatus(page), { timeout }).toBe(status);
}

export interface YoutubeFixtureChannel {
  readonly slug: string;
  readonly name: string;
  /** The official YouTube page that becomes the descriptor URL. */
  readonly youtubeUrl: string;
  /** Optional HLS alternative played by our own engine. */
  readonly hlsUrl?: string;
  /** Which source our API would prefer for this channel. */
  readonly preferYoutube?: boolean;
}

/**
 * One channel per YouTube shape, so each is exercised by its own page.
 *
 * The descriptor a real API would produce for each is derived from the page URL:
 * a `/live/<id>` or `/watch?v=<id>` becomes a YouTube engine option; a channel
 * page or a handle keeps the official page as the offered route.
 */
export const YOUTUBE_CHANNELS: YoutubeFixtureChannel[] = [
  { slug: 'yt-directo', name: 'Youtube Directo', youtubeUrl: 'https://www.youtube.com/live/OkQduT-9Pyc' },
  { slug: 'yt-watch', name: 'Youtube Watch', youtubeUrl: 'https://www.youtube.com/watch?v=cN8S9e2pLxI' },
  { slug: 'yt-canal', name: 'Youtube Canal', youtubeUrl: 'https://www.youtube.com/channel/UCOCGPFW1UqPP9zdol7vEK1A/live' },
  { slug: 'yt-sin-clave', name: 'Youtube Sin Clave', youtubeUrl: 'https://www.youtube.com/channel/UC7QZIf0dta-XPXsp9Hv4dTw/live' },
  { slug: 'yt-prohibido', name: 'Youtube Prohibido', youtubeUrl: 'https://www.youtube.com/live/Pz_yFcM45sc' },
  { slug: 'yt-terminado', name: 'Youtube Terminado', youtubeUrl: 'https://www.youtube.com/live/499wgS85QKQ' },
  { slug: 'yt-segundo', name: 'Youtube Segundo', youtubeUrl: 'https://www.youtube.com/live/hJ5nR0FXhCA' },
  { slug: 'yt-y-hls', name: 'Youtube Y Hls', youtubeUrl: 'https://www.youtube.com/live/OkQduT-9Pyc', hlsUrl: '/demo/media/single/index.m3u8', preferYoutube: true },
  { slug: 'hls-y-yt', name: 'Hls Y Youtube', youtubeUrl: 'https://www.youtube.com/live/OkQduT-9Pyc', hlsUrl: '/demo/media/single/index.m3u8', preferYoutube: false },
  { slug: 'yt-handle', name: 'Youtube Handle', youtubeUrl: 'https://www.youtube.com/@emisora/live' },
];
