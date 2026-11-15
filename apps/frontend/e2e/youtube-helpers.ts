import { expect, type Page, type Route } from '@playwright/test';

/**
 * Shared E2E helpers for in-app YouTube playback (TDT-CLONE-12).
 *
 * Everything here is deterministic and offline: the catalogue is intercepted and
 * `https://www.youtube.com/iframe_api` is fulfilled from a local stub that
 * behaves like the real API — it builds a player, creates an iframe, and lets
 * the test drive `onStateChange` / `onError` on demand. No request ever reaches
 * YouTube.
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
    // The real API assigns width/height inlines; the stub must too.
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
  // window.onYouTubeIframeAPIReady a moment later. The stub reproduces that
  // order, so a loader that settles on onload fails here as it would in
  // production.
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
  // The stub creates the frame element itself from a URL that is never fetched:
  // abort anything else so no test can accidentally depend on the network.
  await page.route(/https:\/\/(www\.)?(youtube|youtube-nocookie)\.com\/(?!iframe_api)/, async (route: Route) => {
    await route.abort('blockedbyclient');
  });
}

/** Reads the fake player's probe. */
export async function youtubeProbe(page: Page): Promise<YoutubeProbe> {
  return page.evaluate(() => {
    const yt = (window as unknown as { __yt?: Record<string, unknown> }).__yt;
    const probe = {
      players: Number(yt?.['players'] ?? 0),
      livePlayers: Number(yt?.['livePlayers'] ?? 0),
      destroyed: Number(yt?.['destroyed'] ?? 0),
      configs: (yt?.['configs'] as YoutubeProbe['configs']) ?? [],
      calls: (yt?.['calls'] as string[]) ?? [],
      iframes: document.querySelectorAll('[data-testid="yt-engine-shell"] iframe').length,
    };
    return probe;
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
 *
 * `live: false` answers "no active public live broadcast"; `live: true` answers
 * with one embeddable live video owned by the requested channel.
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
    // The owner of the live video is the channel the fixture published.
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

/**
 * Navigates INSIDE the running application (a real in-app link), so the
 * controller, the shell and the page script state survive the transition.
 * A full `page.goto()` would reload the document and reset every counter.
 */
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
}/** The player status probe rendered by our shell. */
export async function playerStatus(page: Page): Promise<string> {
  return ((await page.getByTestId('player-state').textContent()) ?? '').trim();
}

/** Waits until our own state machine reports `status`. */
export async function waitForStatus(page: Page, status: string, timeout = 15_000): Promise<void> {
  await expect.poll(() => playerStatus(page), { timeout }).toBe(status);
}

/**
 * A catalogue with one channel per YouTube shape, so each source kind is
 * exercised by its own page. All of them are published exactly as the real
 * catalogue publishes them (`format: youtube`, an official page URL).
 */
export function youtubeCatalogue(): Record<string, unknown> {
  const channels = [
    {
      // A specific live video: /live/VIDEO_ID.
      name: 'Youtube Directo',
      web: 'https://example.org/yt-directo',
      options: [{ format: 'youtube', url: 'https://www.youtube.com/live/OkQduT-9Pyc' }],
      extra_info: ['EMB'],
    },
    {
      // /watch?v=VIDEO_ID
      name: 'Youtube Watch',
      web: 'https://example.org/yt-watch',
      options: [{ format: 'youtube', url: 'https://www.youtube.com/watch?v=cN8S9e2pLxI' }],
      extra_info: ['EMB'],
    },
    {
      // /channel/CHANNEL_ID/live — the shape 205 of 215 published options use.
      name: 'Youtube Canal',
      web: 'https://example.org/yt-canal',
      options: [{ format: 'youtube', url: 'https://www.youtube.com/channel/UCOCGPFW1UqPP9zdol7vEK1A/live' }],
      extra_info: ['EMB'],
    },
    {
      // A channel page with no API key: we cannot know whether it is live.
      name: 'Youtube Sin Clave',
      web: 'https://example.org/yt-sin-clave',
      options: [{ format: 'youtube', url: 'https://www.youtube.com/channel/UC7QZIf0dta-XPXsp9Hv4dTw/live' }],
      extra_info: ['EMB'],
    },
    {
      // A live video whose owner forbids embedding (101/150).
      name: 'Youtube Prohibido',
      web: 'https://example.org/yt-prohibido',
      options: [{ format: 'youtube', url: 'https://www.youtube.com/live/Pz_yFcM45sc' }],
      extra_info: ['EMB'],
    },
    {
      // A live video that has ended (100).
      name: 'Youtube Terminado',
      web: 'https://example.org/yt-terminado',
      options: [{ format: 'youtube', url: 'https://www.youtube.com/live/499wgS85QKQ' }],
      extra_info: ['EMB'],
    },
    {
      // Two YouTube lives: switching between them must not stack players.
      name: 'Youtube Segundo',
      web: 'https://example.org/yt-segundo',
      options: [{ format: 'youtube', url: 'https://www.youtube.com/live/hJ5nR0FXhCA' }],
      extra_info: ['EMB'],
    },
    {
      // A YouTube live and a real HLS stream on the same channel.
      name: 'Youtube Y Hls',
      web: 'https://example.org/yt-y-hls',
      options: [
        { format: 'youtube', url: 'https://www.youtube.com/live/OkQduT-9Pyc' },
        { format: 'm3u8', url: '/demo/media/single/index.m3u8' },
      ],
      extra_info: ['EMB'],
    },
    {
      // HLS first, YouTube second: the other switching direction.
      name: 'Hls Y Youtube',
      web: 'https://example.org/hls-y-yt',
      options: [
        { format: 'm3u8', url: '/demo/media/single/index.m3u8' },
        { format: 'youtube', url: 'https://www.youtube.com/live/OkQduT-9Pyc' },
      ],
      extra_info: ['EMB'],
    },
    {
      // A handle: names a channel but carries no id we can verify.
      name: 'Youtube Handle',
      web: 'https://example.org/yt-handle',
      options: [{ format: 'youtube', url: 'https://www.youtube.com/@emisora/live' }],
      extra_info: ['EMB'],
    },
  ];

  return {
    license: { source: 'e2e fixture', url: 'https://example.org' },
    epg: { json: 'https://upstream.invalid/epg.json' },
    countries: [{ name: 'Spain', ambits: [{ name: 'Generalistas', channels }] }],
    updated: Math.floor(Date.now() / 1000),
  };
}
