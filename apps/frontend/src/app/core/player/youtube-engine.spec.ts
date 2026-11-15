import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { YoutubePlaybackEngine, YoutubeEngineRefusal, YOUTUBE_API_LOAD, YOUTUBE_UNRESOLVED } from './youtube-engine';
import type { EngineEvent, EngineOptions } from './engine';
import type { YoutubeApi } from '../integrations/youtube-embed';

/**
 * The official YouTube player as a `PlayerEngine`, driven by a fake `YT.Player`
 * that records every call it receives. These tests pin the contract the
 * controller depends on: exactly which events are emitted for which
 * `YT.PlayerState`, that `ready` is never reported as `playing`, and that
 * teardown really removes the frame.
 */

interface FakePlayer {
  destroyed: boolean;
  calls: string[];
  iframe: HTMLIFrameElement;
  handlers: { ready?: () => void; state?: (event: { data: number }) => void; error?: (event: { data: number }) => void };
  volume?: number;
  muted?: boolean;
  state: number;
  /** `getVideoLoadedFraction()` answer; 0 unless a test says otherwise. */
  loadedFraction: number;
}

function fakeApi(): { api: YoutubeApi; players: FakePlayer[]; configs: Record<string, unknown>[] } {  const players: FakePlayer[] = [];
  const configs: Record<string, unknown>[] = [];
  class Player implements Record<string, unknown> {
    [key: string]: unknown;
    private readonly record: FakePlayer;
    private readonly owner: HTMLElement;
    constructor(owner: HTMLElement, config: Record<string, unknown>) {
      this.owner = owner;
      configs.push(config);
      const iframe = document.createElement('iframe');
      iframe.setAttribute('src', 'https://www.youtube-nocookie.com/embed/x');
      /*
       * MEASURED against the real API: the player REPLACES the element it is
       * given, putting its iframe where that element was. Reproducing it here is
       * what makes these tests meaningful — a fake that merely appends would
       * pass on a DOM shape production never produces.
       */
      if (owner.parentNode) {
        owner.parentNode.replaceChild(iframe, owner);
      } else {
        owner.replaceChildren(iframe);
      }
      this.record = {
        destroyed: false,
        calls: [],
        iframe,
        handlers: {},
        state: -1,
        loadedFraction: 0,
      };
      const events = (config['events'] ?? {}) as Record<string, (event?: { data?: unknown }) => void>;
      this.record.handlers.ready = () => events['onReady']?.();
      this.record.handlers.state = (event) => events['onStateChange']?.(event);
      this.record.handlers.error = (event) => events['onError']?.(event);
      players.push(this.record);
    }
    playVideo() {
      this.record.calls.push('playVideo');
    }
    pauseVideo() {
      this.record.calls.push('pauseVideo');
    }
    setVolume(volume: number) {
      this.record.calls.push(`setVolume:${volume}`);
      this.record.volume = volume;
    }
    mute() {
      this.record.calls.push('mute');
      this.record.muted = true;
    }
    unMute() {
      this.record.calls.push('unMute');
      this.record.muted = false;
    }
    getPlayerState() {
      this.record.calls.push('getPlayerState');
      return this.record.state;
    }
    getVideoLoadedFraction() {
      return this.record.loadedFraction;
    }
    seekTo(seconds: number, allow: boolean) {
      this.record.calls.push(`seekTo:${seconds}:${allow}`);
    }
    destroy() {
      this.record.destroyed = true;
      this.record.calls.push('destroy');
      // The published player removes its frame; mirror that.
      this.record.iframe.remove();
      void this.owner;
    }
    getIframe() {
      return this.record.iframe;
    }
  }
  return { api: { Player: Player as unknown as YoutubeApi['Player'] }, players, configs };
}

function harness(startVolume = 0.8, muted = false) {
  const events: EngineEvent[] = [];
  const media = document.createElement('video');
  const container = document.createElement('div');
  // The host must be IN the document, exactly as the player component renders it:
  // otherwise "is the frame still connected?" cannot mean anything.
  document.body.appendChild(container);
  const fake = fakeApi();
  const options: EngineOptions = {
    url: 'https://www.youtube.com/live/OkQduT-9Pyc',
    media,
    container,
    autoplay: true,
    startVolume,
    muted,
    onEvent: (event) => events.push(event),
  };
  const deps = {
    loadApi: async () => fake.api,
    now: () => 0,
    // Long by default so unrelated tests never trip the stall watchdog; the
    // stall test narrows it explicitly.
    playingTimeoutMs: 60_000,
  };
  return { events, media, container, options, deps, ...fake };
}

describe('YoutubePlaybackEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('mounts the official player on the privacy-enhanced host with our origin', async () => {
    const h = harness();
    const engine = await YoutubePlaybackEngine.create(h.options, h.deps);
    expect(h.configs[0]).toMatchObject({
      host: 'https://www.youtube-nocookie.com',
      videoId: 'OkQduT-9Pyc',
      width: '100%',
      height: '100%',
    });
    const playerVars = (h.configs[0] as { playerVars: Record<string, string | number> }).playerVars;
    expect(playerVars['origin']).toBe('http://localhost:3000');
    expect(playerVars['playsinline']).toBe(1);
    // The official player owns its controls: we never ask it to hide them.
    expect(playerVars['controls']).toBeUndefined();
    expect(engine.kind).toBe('youtube');
    engine.destroy();
  });

  it('mounts inside the container, never touching the media element', async () => {
    const h = harness();
    const engine = await YoutubePlaybackEngine.create(h.options, h.deps);
    expect(h.container.querySelector('iframe')).not.toBeNull();
    expect(h.media.childNodes).toHaveLength(0);
    engine.destroy();
  });

  it('reports ready as can-play, never as playing', async () => {
    const h = harness();
    const engine = await YoutubePlaybackEngine.create(h.options, h.deps);
    h.players[0].handlers.ready?.();
    expect(h.events.map((event) => event.type)).toEqual(['can-play']);
    expect(h.events.some((event) => event.type === 'playing')).toBe(false);
    engine.destroy();
  });

  it('maps every player state onto the normalised event stream', async () => {
    const h = harness();
    const engine = await YoutubePlaybackEngine.create(h.options, h.deps);
    h.players[0].handlers.ready?.();
    for (const state of [1, 3, 2, 1, 0]) {
      h.players[0].handlers.state?.({ data: state });
    }
    expect(h.events.map((event) => event.type)).toEqual([
      'can-play',
      'playing', // 1
      'waiting', // 3 buffering
      'pause', // 2
      'playing', // 1
      'ended', // 0 live off air
    ]);
    engine.destroy();
  });

  it('emits playing only for PLAYING (1), not for cued or unstarted', async () => {
    const h = harness();
    const engine = await YoutubePlaybackEngine.create(h.options, h.deps);
    for (const state of [-1, 5, -1]) {
      h.players[0].handlers.state?.({ data: state });
    }
    expect(h.events.filter((event) => event.type === 'playing')).toHaveLength(0);
    expect(h.events.filter((event) => event.type === 'can-play')).toHaveLength(1);
    engine.destroy();
  });

  it('applies volume and mute to the live player without recreating it', async () => {
    const h = harness(0.5, false);
    const engine = await YoutubePlaybackEngine.create(h.options, h.deps);
    h.players[0].handlers.ready?.();
    engine.setVolume(0.25);
    engine.setMuted(true);
    engine.setMuted(false);
    engine.setVolume(1);
    // One player existed throughout: no recreation for a volume change.
    expect(h.players).toHaveLength(1);
    expect(h.players[0].calls.filter((call) => call === 'destroy')).toHaveLength(0);
    expect(h.players[0].calls).toContain('setVolume:25');
    expect(h.players[0].calls).toContain('mute');
    expect(h.players[0].calls).toContain('unMute');
    expect(h.players[0].calls).toContain('setVolume:100');
    engine.destroy();
  });

  it('keeps the requested volume and mute when they change before ready', async () => {
    const h = harness(0.8, false);
    const engine = await YoutubePlaybackEngine.create(h.options, h.deps);
    engine.setVolume(0.3);
    engine.setMuted(true);
    h.players[0].handlers.ready?.();
    // The latest intent is applied on ready, once.
    expect(h.players[0].calls).toContain('setVolume:30');
    expect(h.players[0].calls).toContain('mute');
    engine.destroy();
  });

  it('starts playback on ready when autoplay is requested', async () => {
    const h = harness();
    const engine = await YoutubePlaybackEngine.create(h.options, h.deps);
    h.players[0].handlers.ready?.();
    expect(h.players[0].calls).toContain('playVideo');
    engine.destroy();
  });

  it('does not start playback when the caller has not asked for it', async () => {
    const h = harness();
    const engine = await YoutubePlaybackEngine.create({ ...h.options, autoplay: false }, h.deps);
    h.players[0].handlers.ready?.();
    expect(h.players[0].calls).not.toContain('playVideo');
    engine.destroy();
  });

  it('pauses and jumps to the live edge through the official functions', async () => {
    const h = harness();
    const engine = await YoutubePlaybackEngine.create(h.options, h.deps);
    h.players[0].handlers.ready?.();
    engine.pause();
    engine.seekToLive();
    expect(h.players[0].calls).toContain('pauseVideo');
    expect(h.players[0].calls.some((call) => call.startsWith('seekTo:'))).toBe(true);
    engine.destroy();
  });

  it('classifies the documented error codes', async () => {
    const cases: [number, string, boolean][] = [
      [100, 'YOUTUBE_100', false],
      [101, 'YOUTUBE_101', false],
      [150, 'YOUTUBE_150', false],
      [153, 'YOUTUBE_153', false],
      [5, 'YOUTUBE_5', true],
    ];
    for (const [code, expectedCode, recoverable] of cases) {
      const h = harness();
      const engine = await YoutubePlaybackEngine.create(h.options, h.deps);
      h.players[0].handlers.ready?.();
      h.players[0].handlers.error?.({ data: code });
      const error = h.events.find((event) => event.type === 'error');
      expect(error, String(code)).toMatchObject({ code: expectedCode, recoverable });
      engine.destroy();
    }
  });

  it('explains a refusal to embed and a missing client identity distinctly', async () => {
    const embed = harness();
    const a = await YoutubePlaybackEngine.create(embed.options, embed.deps);
    embed.players[0].handlers.error?.({ data: 150 });
    expect(embed.events.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/no permite incrustar/i) });
    a.destroy();

    const identity = harness();
    const b = await YoutubePlaybackEngine.create(identity.options, identity.deps);
    identity.players[0].handlers.error?.({ data: 153 });
    expect(identity.events.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/identifica/i) });
    b.destroy();
  });

  it('reports a stream that never reaches PLAYING as stalled, not as playing', async () => {
    const h = harness();
    let clock = 0;
    const engine = await YoutubePlaybackEngine.create(h.options, {
      ...h.deps,
      now: () => clock,
      playingTimeoutMs: 5_000,
    });
    h.players[0].handlers.ready?.();
    // The player says it is buffering and nothing ever arrives.
    h.players[0].handlers.state?.({ data: 3 });
    h.players[0].state = 3;
    clock = 5_100;
    await vi.advanceTimersByTimeAsync(5_100);
    expect(h.events.some((event) => event.type === 'playing')).toBe(false);
    expect(h.events.at(-1)).toMatchObject({ type: 'error', code: 'SOURCE_STALLED' });
    engine.destroy();
  });

  /*
   * A player waiting for the VIEWER is not stalled. Destroying it would remove a
   * player the user could still start — the exact opposite of what this engine
   * exists for.
   */
  it('does not report a stall while the player waits for the viewer to press play', async () => {
    for (const state of [-1, 5, 2]) {
      const h = harness();
      let clock = 0;
      const engine = await YoutubePlaybackEngine.create(h.options, {
        ...h.deps,
        now: () => clock,
        playingTimeoutMs: 5_000,
      });
      h.players[0].handlers.ready?.();
      h.players[0].state = state;
      clock = 5_100;
      await vi.advanceTimersByTimeAsync(5_100);
      expect(h.events.some((event) => event.type === 'error'), `estado ${state}`).toBe(false);
      expect(h.events.at(-1)).toMatchObject({ type: 'can-play' });
      engine.destroy();
    }
  });

  it('reports data-but-no-playback as can-play instead of a stall', async () => {
    const h = harness();
    let clock = 0;
    const engine = await YoutubePlaybackEngine.create(h.options, {
      ...h.deps,
      now: () => clock,
      playingTimeoutMs: 5_000,
    });
    h.players[0].handlers.ready?.();
    // Loaded data the viewer must start themselves.
    h.players[0].loadedFraction = 0.4;
    clock = 5_100;
    await vi.advanceTimersByTimeAsync(5_100);
    expect(h.events.at(-1)).toMatchObject({ type: 'can-play' });
    expect(h.events.some((event) => event.type === 'error')).toBe(false);
    engine.destroy();
  });

  it('does not report a stall when the player did reach PLAYING', async () => {
    const h = harness();
    const engine = await YoutubePlaybackEngine.create(h.options, { ...h.deps, playingTimeoutMs: 5_000 });
    h.players[0].handlers.ready?.();
    h.players[0].handlers.state?.({ data: 1 });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.events.filter((event) => event.type === 'playing')).toHaveLength(1);
    expect(h.events.some((event) => event.type === 'error')).toBe(false);
    engine.destroy();
  });

  it('destroys the player and removes the frame', async () => {
    const h = harness();
    const engine = await YoutubePlaybackEngine.create(h.options, h.deps);
    expect(h.container.querySelector('iframe')).not.toBeNull();
    engine.destroy();
    expect(h.players[0].destroyed).toBe(true);
    expect(h.container.querySelector('iframe')).toBeNull();
    // A second destroy is harmless.
    engine.destroy();
    expect(h.players).toHaveLength(1);
  });

  it('emits nothing after destroy', async () => {
    const h = harness();
    const engine = await YoutubePlaybackEngine.create(h.options, h.deps);
    h.players[0].handlers.ready?.();
    const seen = h.events.length;
    engine.destroy();
    h.players[0].handlers.state?.({ data: 1 });
    h.players[0].handlers.error?.({ data: 150 });
    expect(h.events).toHaveLength(seen);
  });

  it('refuses a page without any usable YouTube identifier, before creating a frame', async () => {
    const h = harness();
    for (const url of ['https://www.youtube.com/@emisora/live', 'https://www.youtube.com/playlist?list=PL1']) {
      await expect(YoutubePlaybackEngine.create({ ...h.options, url }, h.deps), url).rejects.toBeInstanceOf(
        YoutubeEngineRefusal,
      );
    }
    expect(h.players).toHaveLength(0);
    expect(h.container.querySelector('iframe')).toBeNull();
  });

  it('also accepts a bare channel page: YouTube itself decides what to show', async () => {
    const h = harness();
    const engine = await YoutubePlaybackEngine.create(
      { ...h.options, url: 'https://www.youtube.com/channel/UCOCGPFW1UqPP9zdol7vEK1A' },
      h.deps,
    );
    expect(h.container.querySelector('iframe')?.getAttribute('src')).toContain(
      '/embed/live_stream?channel=UCOCGPFW1UqPP9zdol7vEK1A',
    );
    expect(h.events.some((event) => event.type === 'playing')).toBe(false);
    engine.destroy();
  });

  /*
   * A channel page used to be a dead end. It is not: YouTube's documented channel
   * embed (`/embed/live_stream?channel=…`) is public, needs no API key, and lets
   * YouTube itself decide whether the channel is live. Our app cannot observe
   * that player, so it must never claim `playing` for it.
   */
  it('mounts the documented channel embed without claiming playback', async () => {
    const h = harness();
    const engine = await YoutubePlaybackEngine.create(
      { ...h.options, url: 'https://www.youtube.com/embed/live_stream?channel=UCOCGPFW1UqPP9zdol7vEK1A' },
      h.deps,
    );
    const frame = h.container.querySelector('iframe');
    expect(frame?.getAttribute('src')).toContain('/embed/live_stream?channel=UCOCGPFW1UqPP9zdol7vEK1A');
    // Mounted and clickable ⇒ can-play; never playing, never a fabricated state.
    expect(h.events.map((event) => event.type)).toEqual(['can-play']);
    expect(h.events.some((event) => event.type === 'playing')).toBe(false);
    engine.destroy();
    expect(h.container.querySelector('iframe')).toBeNull();
  });

  /*
   * The reported defect: "al seleccionar el canal no se autorreproduce".
   * Measured against YouTube's real player, the bare channel embed mounts paused
   * and only starts with the published `autoplay`/`playsinline` parameters and
   * our own `origin`. This pins that contract so it cannot silently regress.
   */
  /*
   * The reported defect: "a veces le das al canal y funciona y otras no". When the
   * user is on the channel and the player is not showing, the engine must put it
   * back — a bounded number of times, never forever.
   */
  it('re-mounts the channel embed when it is not showing, within a bounded budget', async () => {
    const h = harness();
    const engine = await YoutubePlaybackEngine.create(
      { ...h.options, url: 'https://www.youtube.com/embed/live_stream?channel=UCOCGPFW1UqPP9zdol7vEK1A' },
      h.deps,
    );
    engine.reportEmbedVisibility(false);
    expect(engine.recoverIfStuck()).toBe(true);
    expect(engine.recoverIfStuck()).toBe(true);
    // Finite budget: further attempts are refused, so this can never loop.
    expect(engine.recoverIfStuck()).toBe(false);
    expect(h.container.querySelector('iframe')).not.toBeNull();
    engine.destroy();
  });

  it('does not re-mount a showing channel embed, nor a video player', async () => {
    const h = harness();
    const embed = await YoutubePlaybackEngine.create(
      { ...h.options, url: 'https://www.youtube.com/embed/live_stream?channel=UCOCGPFW1UqPP9zdol7vEK1A' },
      h.deps,
    );
    embed.reportEmbedVisibility(true);
    expect(embed.isUnobservable).toBe(true);
    expect(embed.recoverIfStuck()).toBe(false);
    embed.destroy();

    // A video-backed engine IS observable: no heuristic recovery on it.
    const video = await YoutubePlaybackEngine.create(h.options, h.deps);
    expect(video.isUnobservable).toBe(false);
    expect(video.recoverIfStuck()).toBe(false);
    video.destroy();
  });

  it('re-mounts on a route/view return without spending the recovery budget', async () => {
    const h = harness();
    const engine = await YoutubePlaybackEngine.create(
      { ...h.options, url: 'https://www.youtube.com/embed/live_stream?channel=UCOCGPFW1UqPP9zdol7vEK1A' },
      h.deps,
    );
    engine.reportEmbedVisibility(false);
    engine.remount();
    expect(h.container.querySelectorAll('iframe')).toHaveLength(1);
    expect(engine.recoverIfStuck()).toBe(true);
    engine.destroy();
  });

  it('hands YouTube the documented autoplay parameters for the channel embed', async () => {
    const h = harness();
    const engine = await YoutubePlaybackEngine.create(
      { ...h.options, url: 'https://www.youtube.com/embed/live_stream?channel=UCOCGPFW1UqPP9zdol7vEK1A' },
      h.deps,
    );
    const src = h.container.querySelector('iframe')?.getAttribute('src') ?? '';
    const parsed = new URL(src);
    expect(parsed.origin).toBe('https://www.youtube-nocookie.com');
    expect(parsed.searchParams.get('autoplay')).toBe('1');
    expect(parsed.searchParams.get('playsinline')).toBe('1');
    expect(parsed.searchParams.get('origin')).toBe('http://localhost:3000');
    // The frame is allowed to autoplay and to be controlled by the user.
    const allow = h.container.querySelector('iframe')?.getAttribute('allow') ?? '';
    expect(allow).toMatch(/autoplay/);
    engine.destroy();
  });

  it('reports the API failing to load as a loadable-again refusal', async () => {
    const h = harness();
    await expect(
      YoutubePlaybackEngine.create(h.options, {
        ...h.deps,
        loadApi: async () => {
          throw new Error('No se ha podido cargar el reproductor oficial de YouTube.');
        },
      }),
    ).rejects.toMatchObject({ code: 'YOUTUBE_API_LOAD' });
  });

  /*
   * The engine boundary must enforce the same host rule as the resolver: a
   * lookalike domain carrying a perfectly valid id is still not YouTube.
   */
  it('refuses a valid id served from a foreign host', async () => {
    const h = harness();
    for (const url of [
      'https://evil.test/live/OkQduT-9Pyc',
      'https://youtube.com.evil.test/live/OkQduT-9Pyc',
      'https://notyoutube.com/watch?v=OkQduT-9Pyc',
    ]) {
      await expect(YoutubePlaybackEngine.create({ ...h.options, url }, h.deps), url).rejects.toMatchObject({
        code: YOUTUBE_UNRESOLVED,
      });
    }
    expect(h.players).toHaveLength(0);
    expect(h.container.querySelector('iframe')).toBeNull();
  });

  it('keeps its own mount isolated when the API replaces the element', async () => {
    const h = harness();
    const engine = await YoutubePlaybackEngine.create(h.options, h.deps);
    h.players[0].handlers.ready?.();
    /*
     * The official API replaced the element it was given. Our host must therefore
     * still own exactly one frame, and a SECOND engine on the same host must own
     * its own, without either one reaching into the other's.
     */
    expect(h.players[0].iframe.isConnected).toBe(true);
    expect(h.players[0].iframe.parentElement).toBe(h.container);
    expect(h.container.querySelectorAll('iframe')).toHaveLength(1);

    const other = await YoutubePlaybackEngine.create(h.options, h.deps);
    // Two engines, two players, but each host holds only its own framework.
    expect(h.players).toHaveLength(2);
    expect(h.container.querySelectorAll('iframe').length).toBeLessThanOrEqual(2);

    // Destroying the FIRST engine must not remove the second one's frame.
    engine.destroy();
    expect(h.players[1].iframe.isConnected).toBe(true);
    expect(h.players[1].destroyed).toBe(false);
    other.destroy();
    expect(h.container.querySelectorAll('iframe')).toHaveLength(0);
  });

  it('two concurrent creations never wipe each other', async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      YoutubePlaybackEngine.create(h.options, h.deps),
      YoutubePlaybackEngine.create(h.options, h.deps),
    ]);
    expect(h.players).toHaveLength(2);
    // Destroying the engine that settles first must leave the other intact.
    a.destroy();
    expect(h.players[1].iframe.isConnected).toBe(true);
    expect(h.players[1].destroyed).toBe(false);
    // And the survivor still reports its real state.
    h.players[1].handlers.state?.({ data: 1 });
    expect(h.events.some((event) => event.type === 'playing')).toBe(true);
    b.destroy();
    expect(h.players.every((player) => player.destroyed)).toBe(true);
    expect(h.container.querySelectorAll('iframe')).toHaveLength(0);
  });

  it('refuses to build without a DOM (SSR/prerender) instead of throwing randomly', async () => {    const h = harness();
    const original = globalThis.document;
    // Simulate a server: no `document` at all.
    Reflect.deleteProperty(globalThis, 'document');
    try {
      await expect(YoutubePlaybackEngine.create(h.options, h.deps)).rejects.toMatchObject({
        code: YOUTUBE_API_LOAD,
      });
    } finally {
      Object.defineProperty(globalThis, 'document', { value: original, configurable: true, writable: true });
    }
    expect(h.players).toHaveLength(0);
  });

  it('refuses without creating a frame when the host container is missing', async () => {
    const h = harness();
    await expect(
      YoutubePlaybackEngine.create({ ...h.options, container: undefined }, h.deps),
    ).rejects.toMatchObject({ code: YOUTUBE_UNRESOLVED });
    expect(h.players).toHaveLength(0);
  });
});
