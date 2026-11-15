import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAYER_ENGINE_FACTORY, PlayerController, YOUTUBE_LIVE_RESOLVER, type YoutubeLiveResolver } from './player.controller';
import { createYoutubeLiveResolver, resetChannelEmbedAttempts } from '../integrations/youtube-runtime';
import { YoutubeDataApi } from '../integrations/youtube-data-api';
import type { EngineEvent, EngineOptions, EngineRequestKind, PlayerEngine } from '../player/engine';
import type { Channel, MediaSource } from '../models/catalog.model';

/**
 * YouTube playback integrated with `PlayerController` (TDT-CLONE-12 §4).
 *
 * The engine is faked so the controller's own decisions are what is measured:
 * which backend is selected, which state is claimed, how a channel is resolved,
 * and that switching leaves exactly one engine alive.
 */

function fakeMedia() {
  return {
    paused: true,
    muted: false,
    volume: 1,
    currentTime: 0,
    videoWidth: 0,
    readyState: 0,
    play: vi.fn(async function (this: { paused: boolean }) {
      this.paused = false;
    }),
    pause: vi.fn(function (this: { paused: boolean }) {
      this.paused = true;
    }),
    removeAttribute: vi.fn(),
    load: vi.fn(),
  } as unknown as HTMLVideoElement;
}

/** Records the engine lifecycle so "no simultaneous playback" is measurable. */
class EngineHarness {
  readonly requested: EngineRequestKind[] = [];
  readonly created: { kind: EngineRequestKind; options: EngineOptions; emit: (event: EngineEvent) => void; engine: FakeEngine }[] = [];
  live = 0;
  maxLive = 0;

  readonly factory = async (options: EngineOptions, kind: EngineRequestKind): Promise<PlayerEngine> => {
    this.requested.push(kind);
    const engine = new FakeEngine(kind, options, this);
    this.created.push({ kind, options, emit: options.onEvent, engine });
    this.live += 1;
    this.maxLive = Math.max(this.maxLive, this.live);
    return engine;
  };

  last(): FakeEngine {
    return this.created[this.created.length - 1].engine;
  }

  lastEvent(): ((event: EngineEvent) => void) | undefined {
    return this.created[this.created.length - 1]?.emit;
  }
}

class FakeEngine implements PlayerEngine {
  calls: string[] = [];
  destroyed = false;
  readonly kind: PlayerEngine['kind'];
  constructor(
    requestKind: EngineRequestKind,
    private readonly options: EngineOptions,
    private readonly harness: EngineHarness,
  ) {
    // The fake mirrors what the real factory reports for each request kind.
    this.kind = requestKind === 'progressive' ? 'native' : requestKind;
  }

  async play(): Promise<void> {
    this.calls.push('play');
  }
  pause(): void {
    this.calls.push('pause');
  }
  setVolume(volume: number): void {
    this.calls.push(`setVolume:${volume}`);
  }
  setMuted(muted: boolean): void {
    this.calls.push(`setMuted:${muted}`);
  }
  setQuality(index: number | 'auto'): void {
    this.calls.push(`setQuality:${index}`);
  }
  setAudioTrack(): void {}
  setSubtitleTrack(): void {}
  seekToLive(): void {
    this.calls.push('seekToLive');
  }
  destroy(): void {
    this.destroyed = true;
    this.calls.push('destroy');
    if (!this.released) {
      this.released = true;
      this.harness.live -= 1;
    }
  }
  private released = false;
  get options_(): EngineOptions {
    return this.options;
  }
}

const youtubeLive: MediaSource = {
  id: 'yt#0',
  label: 'Emisión en YouTube',
  format: 'youtube',
  url: 'https://www.youtube.com/live/OkQduT-9Pyc',
  geoRestricted: false,
};

const youtubeChannel: MediaSource = {
  id: 'ytc#0',
  label: 'Emisión en YouTube',
  format: 'youtube',
  url: 'https://www.youtube.com/channel/UCOCGPFW1UqPP9zdol7vEK1A/live',
  geoRestricted: false,
};

const hls: MediaSource = {
  id: 'hls#0',
  label: 'Emisión HLS',
  format: 'hls',
  url: 'https://cdn.example.org/stream.m3u8',
  geoRestricted: false,
};

function channelOf(sources: MediaSource[], id = 'canal'): Channel {
  return {
    id,
    name: 'Canal',
    categoryId: 'es:generalistas',
    categoryName: 'Generalistas',
    country: 'España',
    sources,
    tags: [],
    availability: 'playable',
  };
}

function setup(resolver?: YoutubeLiveResolver) {
  const harness = new EngineHarness();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLAYER_ENGINE_FACTORY, useValue: harness.factory },
      ...(resolver ? [{ provide: YOUTUBE_LIVE_RESOLVER, useValue: resolver }] : []),
    ],
  });
  const controller = TestBed.inject(PlayerController);
  const media = fakeMedia();
  const host = document.createElement('div');
  controller.attachMedia(media);
  controller.attachHost(host);
  return { controller, harness, media, host };
}

describe('PlayerController — YouTube engine selection', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('selects the byte-for-byte backend for each format', async () => {
    const { controller, harness, host } = setup();
    await controller.load(channelOf([hls]), hls, { volume: 0.5, muted: false });
    expect(harness.requested).toEqual(['hls']);

    await controller.load(channelOf([youtubeLive], 'canal2'), youtubeLive, { volume: 0.5, muted: false });
    expect(harness.requested).toEqual(['hls', 'youtube']);
    // The engine is handed the official page and our mount point, not the <video>.
    expect(harness.created[1].options.url).toBe('https://www.youtube.com/live/OkQduT-9Pyc');
    expect(harness.created[1].options.container).toBe(host);
  });

  it('does not claim "playing" when the iframe is merely ready', async () => {
    const { controller, harness } = setup();
    await controller.load(channelOf([youtubeLive]), youtubeLive, { volume: 0.5, muted: false });
    expect(controller.snapshot().engine).toBe('youtube');
    expect(controller.status()).toBe('loading');

    // The official player's onReady equivalent: mounted, accepting calls.
    harness.lastEvent()?.({ type: 'can-play' });
    expect(controller.status()).toBe('paused');
    expect(controller.status()).not.toBe('playing');

    // Only PLAYING (1) turns into our `playing`.
    harness.lastEvent()?.({ type: 'playing' });
    expect(controller.status()).toBe('playing');
    expect(controller.isPlaying()).toBe(true);
  });

  it('does not touch the <video> element for a YouTube source', async () => {
    const { controller, harness, media } = setup();
    await controller.load(channelOf([youtubeLive]), youtubeLive, { volume: 0.5, muted: false });
    expect(media.play).not.toHaveBeenCalled();
    expect(harness.last().calls).not.toContain('play');
  });

  it('surfaces buffering from the official player as buffering', async () => {
    const { controller, harness } = setup();
    await controller.load(channelOf([youtubeLive]), youtubeLive, { volume: 0.5, muted: false });
    harness.lastEvent()?.({ type: 'playing' });
    harness.lastEvent()?.({ type: 'waiting' });
    expect(controller.status()).toBe('buffering');
    harness.lastEvent()?.({ type: 'playing' });
    expect(controller.status()).toBe('playing');
  });
});

describe('PlayerController — YouTube errors', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('reports a refusal to embed as a terminal, non-retryable state', async () => {
    const { controller, harness } = setup();
    await controller.load(channelOf([youtubeLive]), youtubeLive, { volume: 0.5, muted: false });
    harness.lastEvent()?.({ type: 'playing' });
    harness.lastEvent()?.({
      type: 'error',
      code: 'YOUTUBE_150',
      message: 'El emisor no permite incrustar esta emisión fuera de YouTube.',
      recoverable: false,
    });
    // The engine vocabulary is normalised to the shared failure classes, so the
    // refusal is `blocked` (never retried, never masked by an external link).
    expect(controller.snapshot().error?.code).toBe('BLOCKED_EMBED_FORBIDDEN');
    expect(controller.snapshot().error?.message).toMatch(/no permite incrustar/i);
    expect(controller.snapshot().error?.recoverable).toBe(false);
    expect(controller.status()).toBe('blocked');
    // A refusal is not retried: exactly one engine was ever created.
    expect(harness.created).toHaveLength(1);
  });

  it('keeps the refusal visible even when the channel publishes an official page', async () => {
    // `hasOfficialRoute()` is true for any channel with a web page. That must not
    // replace the real reason ("the owner forbids embedding") with a redirect.
    const { controller, harness } = setup();
    const channel = { ...channelOf([youtubeLive]), webUrl: 'https://emisora.example.org' };
    await controller.load(channel, youtubeLive, { volume: 0.5, muted: false });
    harness.lastEvent()?.({
      type: 'error',
      code: 'YOUTUBE_101',
      message: 'El emisor no permite incrustar esta emisión fuera de YouTube.',
      recoverable: false,
    });
    expect(controller.status()).toBe('blocked');
    expect(controller.snapshot().error?.message).toMatch(/no permite incrustar/i);
  });

  it('treats a missing client identity (153) as its own refusal', async () => {
    const { controller, harness } = setup();
    await controller.load(channelOf([youtubeLive]), youtubeLive, { volume: 0.5, muted: false });
    harness.lastEvent()?.({
      type: 'error',
      code: 'YOUTUBE_153',
      message: 'YouTube exige que la página identifique el reproductor.',
      recoverable: false,
    });
    expect(controller.snapshot().error?.code).toBe('BLOCKED_CLIENT_IDENTITY');
    // Our own deployment problem must never be blamed on the emitter.
    expect(controller.snapshot().error?.message).not.toMatch(/emisor/i);
  });

  it('does not resurrect a failed YouTube source from a late playing event', async () => {
    const { controller, harness } = setup();
    await controller.load(channelOf([youtubeLive]), youtubeLive, { volume: 0.5, muted: false });
    harness.lastEvent()?.({
      type: 'error',
      code: 'YOUTUBE_100',
      message: 'La emisión de YouTube ya no está disponible.',
      recoverable: false,
    });
    const afterError = controller.status();
    harness.lastEvent()?.({ type: 'playing' });
    expect(controller.status()).toBe(afterError);
  });

  it('falls back to another source when a YouTube video is gone', async () => {
    const { controller, harness } = setup();
    await controller.load(channelOf([youtubeLive, hls]), youtubeLive, { volume: 0.5, muted: false });
    harness.lastEvent()?.({
      type: 'error',
      code: 'YOUTUBE_100',
      message: 'La emisión de YouTube ya no está disponible.',
      recoverable: false,
    });
    // The canonical fallback: the dead route is recorded and HLS is attempted.
    await vi.waitFor(() => expect(harness.requested).toContain('hls'));
    expect(controller.snapshot().failedSources.map((record) => record.sourceId)).toContain('yt#0');
  });
});

describe('PlayerController — channel resolution', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('plays the resolved live video of a channel inside our player', async () => {
    const resolver = vi.fn(async () => ({ kind: 'video' as const, videoId: 'OkQduT-9Pyc' }));
    const { controller, harness } = setup(resolver);
    await controller.load(channelOf([youtubeChannel]), youtubeChannel, { volume: 0.5, muted: false });

    // The resolver receives the published page AND the deployment's key.
    expect(resolver).toHaveBeenCalledWith('https://www.youtube.com/channel/UCOCGPFW1UqPP9zdol7vEK1A/live', '');
    expect(harness.requested).toEqual(['youtube']);
    // The engine receives the resolved VIDEO page, not the channel page.
    expect(harness.created[0].options.url).toBe('https://www.youtube.com/live/OkQduT-9Pyc');
    expect(controller.status()).toBe('loading');
  });

  it('passes the deployment runtime key to the resolver', async () => {
    // A deployment enables channel resolution by setting this global; the
    // controller must hand it to the adapter (no rebuild, no service exposure).
    (globalThis as { TDT_YOUTUBE_API_KEY?: string }).TDT_YOUTUBE_API_KEY = 'deploy-key';
    try {
      const resolver = vi.fn(async () => ({ kind: 'offline' as const }));
      const { controller } = setup(resolver);
      await controller.load(channelOf([youtubeChannel]), youtubeChannel, { volume: 0.5, muted: false });
      expect(resolver).toHaveBeenCalledWith('https://www.youtube.com/channel/UCOCGPFW1UqPP9zdol7vEK1A/live', 'deploy-key');
    } finally {
      delete (globalThis as { TDT_YOUTUBE_API_KEY?: string }).TDT_YOUTUBE_API_KEY;
    }
  });

  it('says "the channel is not live" instead of mounting a player', async () => {
    const resolver = vi.fn(async () => ({ kind: 'offline' as const }));
    const { controller, harness } = setup(resolver);
    await controller.load(channelOf([youtubeChannel]), youtubeChannel, { volume: 0.5, muted: false });

    expect(harness.created).toHaveLength(0);
    expect(controller.snapshot().error?.message).toBe('El canal no está emitiendo ahora.');
    expect(controller.status()).not.toBe('playing');
  });

  it('explains a creator who forbids embedding and never mounts it', async () => {
    const resolver = vi.fn(async () => ({ kind: 'not-embeddable' as const }));
    const { controller, harness } = setup(resolver);
    await controller.load(channelOf([youtubeChannel]), youtubeChannel, { volume: 0.5, muted: false });

    expect(harness.created).toHaveLength(0);
    expect(controller.snapshot().error?.message).toMatch(/no permite/i);
    expect(controller.snapshot().error?.recoverable).toBe(false);
  });

  it('does not pretend a channel is offline when the resolver could not check it', async () => {
    const resolver = vi.fn(async () => ({
      kind: 'unplayable' as const,
      message: 'No se puede comprobar si el canal está emitiendo.',
      url: 'https://www.youtube.com/channel/UCOCGPFW1UqPP9zdol7vEK1A/live',
      cause: 'unavailable' as const,
    }));
    const { controller, harness } = setup(resolver);
    const channel = { ...channelOf([youtubeChannel]), webUrl: 'https://emisora.example.org' };
    await controller.load(channel, youtubeChannel, { volume: 0.5, muted: false });

    expect(harness.created).toHaveLength(0);
    // Never the claim "it is not broadcasting": we did not check it.
    expect(controller.snapshot().error?.message).not.toMatch(/no está emitiendo/i);
    expect(controller.snapshot().error?.message).toMatch(/no se puede comprobar/i);
    // And the user keeps a way to watch it.
    expect(controller.snapshot().watchableUrl).toBe(
      'https://www.youtube.com/channel/UCOCGPFW1UqPP9zdol7vEK1A/live',
    );
    expect(controller.status()).toBe('external');
  });

  /*
   * The case reported for La Séptima: the catalogue only publishes the channel
   * page, there is no Data API key, and the channel IS broadcasting on YouTube.
   * The app said "ninguna fuente está disponible", which was wrong: YouTube's
   * documented channel embed is the public route and needs no key.
   */
  it('plays a channel through the documented channel embed when no key is configured', async () => {
    resetChannelEmbedAttempts();
    const resolver = vi.fn(createYoutubeLiveResolver({ apiFor: () => new YoutubeDataApi({}) }));
    const { controller, harness } = setup(resolver);
    await controller.load(channelOf([youtubeChannel]), youtubeChannel, { volume: 0.5, muted: false });

    expect(harness.requested).toEqual(['youtube']);
    // The engine is handed the channel embed, and the app does NOT claim playback.
    expect(harness.created[0].options.url).toContain('/embed/live_stream?channel=UCOCGPFW1UqPP9zdol7vEK1A');
    harness.lastEvent()?.({ type: 'can-play' });
    expect(controller.status()).toBe('paused');
    expect(controller.snapshot().error).toBeUndefined();
  });

  it('gives the channel embed a second attempt, then explains and links', async () => {
    resetChannelEmbedAttempts();
    const resolver = vi.fn(createYoutubeLiveResolver({ apiFor: () => new YoutubeDataApi({}) }));
    const { controller, harness } = setup(resolver);
    // First visit: the embed is mounted.
    await controller.load(channelOf([youtubeChannel]), youtubeChannel, { volume: 0.5, muted: false });
    expect(harness.requested).toEqual(['youtube']);
    /*
     * A retry is one more REAL attempt: the reported failure ("a veces da este
     * fallo y otras reproduce") came from giving up after a single try.
     */
    await controller.retry(0.5, false);
    expect(harness.requested).toEqual(['youtube', 'youtube']);
    // After both attempts, the reason is shown with a way out instead of a loop.
    await controller.retry(0.5, false);
    expect(harness.requested).toEqual(['youtube', 'youtube']);
    expect(controller.snapshot().error?.message).toMatch(/no se ha podido reproducir/i);
  });

  it('treats a resolver crash as an explained refusal, not a hang', async () => {
    const resolver = vi.fn(async () => {
      throw new Error('network down');
    });
    const { controller, harness } = setup(resolver);
    await controller.load(channelOf([youtubeChannel]), youtubeChannel, { volume: 0.5, muted: false });
    expect(harness.created).toHaveLength(0);
    expect(controller.snapshot().error?.message).toMatch(/no se ha podido comprobar/i);
  });

  /*
   * The channel may publish a YouTube page FIRST and a real HLS stream second.
   * If the YouTube route cannot be resolved the channel must still play over HLS:
   * a failed route falls back exactly like any other failed source.
   */
  it('falls back to another source when the YouTube channel cannot be resolved', async () => {
    const cases = [
      ['offline', { kind: 'offline' as const }],
      ['not-embeddable', { kind: 'not-embeddable' as const }],
      [
        'uncertain',
        { kind: 'unplayable' as const, message: 'no se puede comprobar', cause: 'unavailable' as const },
      ],
    ] as const;
    for (const [name, resolution] of cases) {
      TestBed.resetTestingModule();
      const { controller, harness } = setup(async () => resolution);
      await controller.load(channelOf([youtubeChannel, hls]), youtubeChannel, { volume: 0.5, muted: false });
      await vi.waitFor(() => expect(harness.requested, name).toContain('hls'));
      expect(controller.snapshot().failedSources.map((record) => record.sourceId), name).toContain('ytc#0');
    }
  });

  it('keeps the exact reason when the YouTube channel is the only route', async () => {
    const { controller, harness } = setup(async () => ({ kind: 'offline' as const }));
    await controller.load(channelOf([youtubeChannel]), youtubeChannel, { volume: 0.5, muted: false });
    expect(harness.created).toHaveLength(0);
    expect(controller.snapshot().error?.message).toBe('El canal no está emitiendo ahora.');
    expect(controller.status()).not.toBe('playing');
  });
});

describe('PlayerController — switching (no simultaneous playback)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('YouTube → HLS releases the YouTube engine first', async () => {
    const { controller, harness } = setup();
    await controller.load(channelOf([youtubeLive]), youtubeLive, { volume: 0.5, muted: false });
    const youtubeEngine = harness.last();

    await controller.load(channelOf([hls], 'otro'), hls, { volume: 0.5, muted: false });
    expect(youtubeEngine.destroyed).toBe(true);
    expect(harness.live).toBe(1);
    expect(harness.maxLive).toBe(1);
    expect(controller.snapshot().engine).toBe('hls');
  });

  it('HLS → YouTube releases the HLS engine first', async () => {
    const { controller, harness } = setup();
    await controller.load(channelOf([hls]), hls, { volume: 0.5, muted: false });
    const hlsEngine = harness.last();

    await controller.load(channelOf([youtubeLive], 'yt'), youtubeLive, { volume: 0.5, muted: false });
    expect(hlsEngine.destroyed).toBe(true);
    expect(harness.live).toBe(1);
    expect(harness.maxLive).toBe(1);
    expect(controller.snapshot().engine).toBe('youtube');
  });

  it('YouTube → YouTube keeps only the new player', async () => {
    const { controller, harness } = setup();
    await controller.load(channelOf([youtubeLive]), youtubeLive, { volume: 0.5, muted: false });
    const first = harness.last();
    const other: MediaSource = { ...youtubeLive, id: 'yt#1', url: 'https://www.youtube.com/live/cN8S9e2pLxI' };
    await controller.load(channelOf([other], 'otro2'), other, { volume: 0.5, muted: false });
    const second = harness.last();

    expect(first.destroyed).toBe(true);
    expect(second.destroyed).toBe(false);
    expect(harness.live).toBe(1);
    expect(controller.snapshot().source?.id).toBe('yt#1');
  });

  it('keeps the selected channel and then plays its new source', async () => {
    const { controller, harness } = setup();
    const channel = channelOf([youtubeLive]);
    await controller.load(channel, youtubeLive, { volume: 0.5, muted: false });
    await controller.selectSource(0, 0.5, false);
    expect(controller.snapshot().channel?.id).toBe('canal');
    expect(harness.created).toHaveLength(2);
    expect(harness.live).toBe(1);
  });

  it('destroys the engine when the controller is cleared', async () => {
    const { controller, harness } = setup();
    await controller.load(channelOf([youtubeLive]), youtubeLive, { volume: 0.5, muted: false });
    const engine = harness.last();
    controller.clear();
    expect(engine.destroyed).toBe(true);
    expect(harness.live).toBe(0);
    expect(controller.status()).toBe('idle');
  });
});

describe('PlayerController — volume and mute without recreation', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('routes volume and mute to the live player', async () => {
    const { controller, harness } = setup();
    await controller.load(channelOf([youtubeLive]), youtubeLive, { volume: 0.5, muted: false });
    const engine = harness.last();
    controller.setVolume(0.2);
    controller.setMuted(true);
    controller.setMuted(false);
    expect(engine.calls).toEqual(['setVolume:0.2', 'setMuted:true', 'setMuted:false']);
    expect(harness.created).toHaveLength(1);
    expect(engine.destroyed).toBe(false);
  });

  it('toggles play through the official engine, not the empty <video>', async () => {
    const { controller, harness, media } = setup();
    await controller.load(channelOf([youtubeLive]), youtubeLive, { volume: 0.5, muted: false });
    const engine = harness.last();
    harness.lastEvent()?.({ type: 'can-play' });
    await controller.togglePlay();
    expect(engine.calls).toContain('play');
    expect(media.play).not.toHaveBeenCalled();

    harness.lastEvent()?.({ type: 'playing' });
    await controller.togglePlay();
    expect(engine.calls).toContain('pause');
  });

  /*
   * An ended live must not send the controller down the media-element path: the
   * `<video>` holds no source, so `play()` there rejects (`PLAY_REJECTED`) or
   * trips the no-frames watchdog, blaming the emitter for something nobody
   * asked to play.
   */
  it('does not try to replay an ended YouTube live on the empty <video>', async () => {
    const { controller, harness, media } = setup();
    await controller.load(channelOf([youtubeLive]), youtubeLive, { volume: 0.5, muted: false });
    harness.lastEvent()?.({ type: 'playing' });
    expect(controller.status()).toBe('playing');

    harness.lastEvent()?.({ type: 'ended' });
    expect(media.play).not.toHaveBeenCalled();
    expect(media.currentTime).toBe(0);
    expect(controller.status()).not.toBe('playing');
    expect(controller.isPlaying()).toBe(false);
    // No spurious retry was scheduled for this stream.
    expect(controller.snapshot().error).toBeUndefined();
  });
});
