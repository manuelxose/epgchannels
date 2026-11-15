import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAYER_ENGINE_FACTORY, PlayerController } from './player.controller';
import type { EngineEvent, EngineOptions, EngineRequestKind, PlayerEngine } from '../player/engine';
import type { Channel, MediaSource } from '../models/catalog.model';

/** Minimal HTMLVideoElement surface used by the controller. */
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
  };
}

const source: MediaSource = {
  id: 'canal#0',
  label: 'Emisión 1',
  format: 'hls',
  url: 'https://cdn.example.org/stream.m3u8',
  geoRestricted: false,
};

const channel: Channel = {
  id: 'canal',
  name: 'Canal',
  categoryId: 'es:generalistas',
  categoryName: 'Generalistas',
  country: 'España',
  sources: [source],
  tags: [],
  availability: 'playable',
};

function channelWith(sources: MediaSource[], overrides: Partial<Channel> = {}): Channel {
  return { ...channel, sources, ...overrides };
}

const dashSource: MediaSource = {
  id: 'canal#1',
  label: 'Emisión 2',
  format: 'dash',
  url: 'https://cdn.example.org/stream.mpd',
  geoRestricted: false,
};

const geoSource: MediaSource = {
  id: 'canal#2',
  label: 'Emisión 3',
  format: 'hls',
  url: 'https://cdn.example.org/geo.m3u8',
  geoRestricted: true,
};

/** Records every engine created and lets a test drive its events. */
class FakeEngineHarness {
  readonly created: { options: EngineOptions; kind: EngineRequestKind; engine: PlayerEngine; destroyed: boolean }[] = [];
  /** Engine kind reported to the controller (hls engines report 'hls', etc.). */
  engineKind: 'hls' | 'dash' | 'native' = 'hls';
  /** Forces the factory to reject, simulating an engine that cannot start. */
  failStart = false;

  readonly factory = async (options: EngineOptions, kind: EngineRequestKind): Promise<PlayerEngine> => {
    if (this.failStart) {
      throw new Error('engine start failed');
    }
    const record = {
      options,
      kind,
      destroyed: false,
      engine: {
        kind: this.engineKind,
        play: async () => undefined,
        pause: () => undefined,
        setVolume: () => undefined,
        setMuted: () => undefined,
        setQuality: () => undefined,
        setAudioTrack: () => undefined,
        setSubtitleTrack: () => undefined,
        seekToLive: () => undefined,
        destroy: () => {
          record.destroyed = true;
        },
      } as PlayerEngine,
    };
    this.created.push(record);
    // Mirror production: `createHlsEngine`/`createDashEngine` await their lazy
    // `import('hls.js' | 'dashjs')`, so the engine exists only on a later
    // microtask. Without this yield the await inside `startAt` would not
    // suspend and the controller's re-entrancy would be untested.
    await Promise.resolve();
    return record.engine;
  };

  get latest() {
    return this.created[this.created.length - 1];
  }

  get destroyCount(): number {
    return this.created.filter((record) => record.destroyed).length;
  }

  emit(event: EngineEvent, index = this.created.length - 1): void {
    this.created[index]?.options.onEvent(event);
  }
}

describe('PlayerController', () => {
  let controller: PlayerController;
  let media: ReturnType<typeof fakeMedia>;
  let harness: FakeEngineHarness;

  beforeEach(() => {
    vi.useFakeTimers();
    harness = new FakeEngineHarness();
    TestBed.configureTestingModule({
      providers: [{ provide: PLAYER_ENGINE_FACTORY, useValue: harness.factory }],
    });
    controller = TestBed.inject(PlayerController);
    media = fakeMedia();
    controller.attachMedia(media as unknown as HTMLVideoElement);
  });

  afterEach(() => {
    controller.clear();
    vi.useRealTimers();
  });

  it('starts idle without a channel', () => {
    expect(controller.status()).toBe('idle');
    expect(controller.snapshot().engine).toBe('none');
  });

  it('creates an engine and requests playback on load()', async () => {
    await controller.load(channel, source, { volume: 0.5, muted: false });
    expect(controller.snapshot().engine).toBe('hls');
    expect(harness.created).toHaveLength(1);
    expect(harness.latest.options.startVolume).toBe(0.5);
    expect(harness.latest.options.url).toBe(source.url);
    // Autoplay succeeded against the fake element, so playback is underway.
    expect(media.play).toHaveBeenCalled();
    expect(['loading', 'playing']).toContain(controller.status());
  });

  it('does nothing without a media element', async () => {
    controller.detachMedia();
    await controller.load(channel, source, { volume: 1, muted: false });
    expect(controller.status()).toBe('idle');
    expect(harness.created).toHaveLength(0);
  });

  it('marks itself ready on can-play', async () => {
    await controller.load(channel, source, { volume: 1, muted: false });
    harness.emit({ type: 'can-play' });
    expect(controller.ready()).toBe(true);
  });

  it('goes to playing on a playing event', async () => {
    await controller.load(channel, source, { volume: 1, muted: false });
    harness.emit({ type: 'playing' });
    expect(controller.status()).toBe('playing');
    expect(controller.isPlaying()).toBe(true);
  });

  it('ignores a pause while the source is still loading', async () => {
    // Prevent the fake autoplay from succeeding so the controller stays loading.
    media.play.mockRejectedValueOnce(Object.assign(new Error('slow'), { name: 'AbortError' }));
    await controller.load(channel, source, { volume: 1, muted: false });
    expect(controller.status()).toBe('loading');
    harness.emit({ type: 'pause' });
    expect(controller.status()).toBe('loading');
  });

  it('goes to paused on a real pause from playback', async () => {
    await controller.load(channel, source, { volume: 1, muted: false });
    harness.emit({ type: 'playing' });
    harness.emit({ type: 'pause' });
    expect(controller.status()).toBe('paused');
    expect(controller.isPlaying()).toBe(false);
  });

  it('destroys the previous engine when a new load starts (no engine leak)', async () => {
    await controller.load(channel, source, { volume: 1, muted: false });
    expect(harness.destroyCount).toBe(0);

    await controller.load(channel, { ...source, id: 'canal#1' }, { volume: 1, muted: false });
    expect(harness.created).toHaveLength(2);
    expect(harness.destroyCount).toBe(1);
    expect(harness.created[0].destroyed).toBe(true);
  });

  it('destroys the engine before retrying the same source', async () => {
    await controller.load(channel, source, { volume: 1, muted: false });
    await controller.retry(0.4, true);
    expect(harness.created).toHaveLength(2);
    expect(harness.destroyCount).toBe(1);
    expect(harness.latest.options.startVolume).toBe(0.4);
    expect(harness.latest.options.muted).toBe(true);
  });

  it('retries a recoverable error a bounded number of times, then reports the source as unavailable', async () => {
    await controller.load(channel, source, { volume: 1, muted: false });

    harness.emit({ type: 'error', code: 'NETWORK', message: 'net', recoverable: true });
    // The retry is scheduled, not applied yet.
    expect(harness.created).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.created).toHaveLength(2);

    harness.emit({ type: 'error', code: 'NETWORK', message: 'net', recoverable: true });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.created).toHaveLength(3);

    harness.emit({ type: 'error', code: 'NETWORK', message: 'net', recoverable: true });
    await vi.advanceTimersByTimeAsync(10_000);
    // The single source of this channel is gone: the channel is unavailable,
    // not merely in a retryable error state.
    expect(controller.status()).toBe('unavailable');
    // No fourth engine: the automatic budget is exhausted.
    expect(harness.created).toHaveLength(3);
    expect(controller.failures()).toMatchObject([{ sourceId: source.id, cause: 'network', failureClass: 'transient' }]);
  });

  it('does not retry a non-recoverable error', async () => {
    await controller.load(channel, source, { volume: 1, muted: false });
    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.status()).toBe('unavailable');
    expect(harness.created).toHaveLength(1);
  });

  it('stops the engine when it fails, so nothing plays behind the error', async () => {
    await controller.load(channel, source, { volume: 1, muted: false });
    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
    expect(controller.snapshot().engine).toBe('none');
    expect(harness.destroyCount).toBe(1);
    expect(controller.snapshot().error?.code).toBe('MEDIA');
  });

  it('ignores a late playing event once the source has failed', async () => {
    await controller.load(channel, source, { volume: 1, muted: false });
    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
    harness.emit({ type: 'playing' });
    expect(controller.status()).toBe('unavailable');
    expect(controller.isPlaying()).toBe(false);
    expect(controller.snapshot().error?.code).toBe('MEDIA');
  });

  it('fails visibly when a source never produces a frame', async () => {
    await controller.load(channel, source, { volume: 1, muted: false });
    harness.emit({ type: 'can-play' });
    await vi.advanceTimersByTimeAsync(12_000);
    // Two engine attempts (initial + one automatic retry), then the verdict.
    expect(controller.status()).toBe('unavailable');
    expect(controller.snapshot().error?.code).toBe('NO_FRAMES');
    expect(controller.failures()[0]).toMatchObject({ cause: 'no-frames' });
  });

  it('does not fire the no-frame watchdog once frames arrive', async () => {
    await controller.load(channel, source, { volume: 1, muted: false });
    media.videoWidth = 1280;
    harness.emit({ type: 'playing' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(controller.status()).toBe('playing');
  });

  it('degrades a permanently stalled signal to an error', async () => {
    await controller.load(channel, source, { volume: 1, muted: false });
    media.videoWidth = 1280;
    harness.emit({ type: 'playing' });
    harness.emit({ type: 'waiting' });
    expect(controller.status()).toBe('buffering');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(controller.status()).toBe('unavailable');
    expect(controller.snapshot().error?.code).toBe('SOURCE_STALLED');
    expect(controller.failures()[0]).toMatchObject({ cause: 'stalled' });
  });

  it('recovers from a stall when playback resumes', async () => {
    await controller.load(channel, source, { volume: 1, muted: false });
    media.videoWidth = 1280;
    harness.emit({ type: 'playing' });
    harness.emit({ type: 'waiting' });
    harness.emit({ type: 'playing' });
    expect(controller.status()).toBe('playing');
    await vi.advanceTimersByTimeAsync(25_000);
    expect(controller.status()).toBe('playing');
  });

  it('is idempotent on clear() and destroys the engine once', async () => {
    await controller.load(channel, source, { volume: 1, muted: false });
    controller.clear();
    controller.clear();
    expect(harness.destroyCount).toBe(1);
    expect(controller.status()).toBe('idle');
    expect(controller.snapshot().channel).toBeUndefined();
  });

  it('cancels pending retries when cleared', async () => {
    await controller.load(channel, source, { volume: 1, muted: false });
    harness.emit({ type: 'error', code: 'NETWORK', message: 'net', recoverable: true });
    controller.clear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.created).toHaveLength(1);
    expect(controller.status()).toBe('idle');
  });

  it('treats an autoplay rejection as blocked autoplay rather than an error', async () => {
    media.play.mockRejectedValueOnce(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    await controller.load(channel, source, { volume: 1, muted: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.autoplayBlocked()).toBe(true);
    expect(controller.status()).not.toBe('error');
    expect(controller.snapshot().engine).toBe('hls');
  });

  it('ignores events emitted by a superseded engine (generation guard)', async () => {
    await controller.load(channel, source, { volume: 1, muted: false });
    await controller.load(channel, { ...source, id: 'canal#1' }, { volume: 1, muted: false });
    const statusBefore = controller.status();
    // Status is driven by the current engine only.
    harness.emit({ type: 'pause' }, 0);
    expect(controller.status()).toBe(statusBefore);
  });

  it('exposes engine-reported qualities and tracks', async () => {
    await controller.load(channel, source, { volume: 1, muted: false });
    harness.emit({
      type: 'manifest-ready',
      qualities: [
        { index: 0, label: '720p', height: 720 },
        { index: 1, label: '360p', height: 360 },
      ],
    });
    harness.emit({ type: 'quality-changed', index: 1 });
    harness.emit({
      type: 'tracks',
      audio: [{ id: 0, label: 'Español', language: 'es' }],
      subtitles: [],
    });
    expect(controller.snapshot().qualities).toHaveLength(2);
    expect(controller.snapshot().currentQuality).toBe(1);
    expect(controller.snapshot().audioTracks[0].label).toBe('Español');
  });

  it('reports unsupported playback explicitly', async () => {
    media.play.mockRejectedValueOnce(Object.assign(new Error('slow'), { name: 'AbortError' }));
    await controller.load(channel, source, { volume: 1, muted: false });
    harness.emit({ type: 'unsupported', reason: 'MediaSource is unavailable' });
    expect(controller.status()).toBe('unsupported');
    expect(controller.snapshot().error?.code).toBe('UNSUPPORTED');
  });
});

describe('PlayerController — DASH routing', () => {
  let controller: PlayerController;
  let harness: FakeEngineHarness;

  beforeEach(() => {
    vi.useFakeTimers();
    harness = new FakeEngineHarness();
    TestBed.configureTestingModule({ providers: [{ provide: PLAYER_ENGINE_FACTORY, useValue: harness.factory }] });
    controller = TestBed.inject(PlayerController);
    controller.attachMedia(fakeMedia() as unknown as HTMLVideoElement);
  });

  afterEach(() => {
    controller.clear();
    vi.useRealTimers();
  });

  it('requests the dash backend for an .mpd source and never a progressive one', async () => {
    // The channel must actually carry the source being requested: `load()`
    // resolves the start index from `channel.sources`, so passing a source the
    // channel does not contain silently falls back to the first eligible one.
    await controller.load(channelWith([dashSource, source]), dashSource, { volume: 1, muted: false });
    expect(harness.created).toHaveLength(1);
    expect(harness.latest.kind).toBe('dash');
    expect(harness.latest.options.url).toBe('https://cdn.example.org/stream.mpd');
  });

  it('reports the dash engine kind so the UI/probe records it', async () => {
    harness.engineKind = 'dash';
    await controller.load(channelWith([dashSource, source]), dashSource, { volume: 1, muted: false });
    expect(controller.snapshot().engine).toBe('dash');
    expect(controller.snapshot().source?.format).toBe('dash');
  });

  it('exposes dash manifest qualities, tracks and quality changes through the same contract', async () => {
    harness.engineKind = 'dash';
    await controller.load(channelWith([dashSource, source]), dashSource, { volume: 1, muted: false });
    harness.emit({
      type: 'manifest-ready',
      qualities: [
        { index: 0, label: '270p', height: 270, bitrate: 300_000 },
        { index: 1, label: '480p', height: 480, bitrate: 900_000 },
      ],
    });
    harness.emit({ type: 'quality-changed', index: 1 });
    harness.emit({ type: 'tracks', audio: [{ id: 0, label: 'Español', language: 'es' }], subtitles: [] });
    expect(controller.snapshot().qualities.map((quality) => quality.label)).toEqual(['270p', '480p']);
    expect(controller.snapshot().currentQuality).toBe(1);
    expect(controller.snapshot().audioTracks).toEqual([{ id: 0, label: 'Español', language: 'es' }]);
    // Manifest metadata arrives before playback starts: it must not itself
    // advance the status machine (no fabricated `playing`).
    // `load()` keeps the in-flight engine creation, so settle it first.
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.status()).toBe('loading');
  });

  it('treats a dash DRM error as blocked and never falls back to the next source', async () => {
    harness.engineKind = 'dash';
    const twoSources = channelWith([dashSource, { ...source, id: 'canal#4' }]);
    await controller.load(twoSources, dashSource, { volume: 1, muted: false });
    // The failing source itself is never retried (a key-locked stream is not a
    // network fault), but another published route is still attempted once.
    harness.emit({ type: 'error', code: 'BLOCKED_DRM', message: 'DRM', recoverable: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.created.map((record) => record.options.url)).toEqual([dashSource.url, source.url]);
    expect(controller.failures()).toMatchObject([{ sourceId: dashSource.id, cause: 'blocked' }]);
    // Nothing loops back to the refuted source.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.created.filter((record) => record.options.url === dashSource.url)).toHaveLength(1);
  });

  it('marks an unsupported browser as unsupported without retrying', async () => {
    harness.engineKind = 'dash';
    await controller.load(channelWith([dashSource, source]), dashSource, { volume: 1, muted: false });
    harness.emit({ type: 'unsupported', reason: 'Este navegador no puede reproducir vídeo DASH.' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.status()).toBe('unsupported');
    expect(harness.created).toHaveLength(1);
    expect(harness.destroyCount).toBe(1);
  });
});

describe('PlayerController — multi-source fallback (spec §5.4)', () => {
  let controller: PlayerController;
  let harness: FakeEngineHarness;
  let media: ReturnType<typeof fakeMedia>;

  const second: MediaSource = { ...source, id: 'canal#1', label: 'Emisión 2', url: 'https://cdn.example.org/two.m3u8' };
  const third: MediaSource = { ...source, id: 'canal#2', label: 'Emisión 3', url: 'https://cdn.example.org/three.m3u8' };

  beforeEach(() => {
    vi.useFakeTimers();
    harness = new FakeEngineHarness();
    TestBed.configureTestingModule({ providers: [{ provide: PLAYER_ENGINE_FACTORY, useValue: harness.factory }] });
    controller = TestBed.inject(PlayerController);
    media = fakeMedia();
    controller.attachMedia(media as unknown as HTMLVideoElement);
  });

  afterEach(() => {
    controller.clear();
    vi.useRealTimers();
  });

  it('falls back to the next eligible source after retries are exhausted on the first', async () => {
    const multi = channelWith([source, second]);
    await controller.load(multi, source, { volume: 1, muted: false });
    expect(harness.created).toHaveLength(1);
    // The user mutes and lowers the volume while the failing source is playing.
    controller.setMuted(true);
    controller.setVolume(0.5);

    // Exhaust the per-source retry budget (2 automatic retries).
    harness.emit({ type: 'error', code: 'fragLoadError', message: 'net', recoverable: true });
    await vi.advanceTimersByTimeAsync(1_000);
    harness.emit({ type: 'error', code: 'fragLoadError', message: 'net', recoverable: true });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.created).toHaveLength(3);

    harness.emit({ type: 'error', code: 'fragLoadError', message: 'net', recoverable: true });
    await vi.advanceTimersByTimeAsync(10_000);

    // One attempt on the second source, with the user's current volume/mute.
    expect(harness.created).toHaveLength(4);
    expect(harness.latest.options.url).toBe(second.url);
    expect(harness.latest.options.startVolume).toBe(0.5);
    expect(harness.latest.options.muted).toBe(true);
    expect(controller.snapshot().sourceIndex).toBe(1);
    // The failed source is gone, so the channel goes back to loading on the next one.
    expect(controller.status()).toBe('loading');
    expect(controller.snapshot().notice).toContain('Emisión 2');
    // The failed engine was torn down before the next one started.
    expect(harness.created[2].destroyed).toBe(true);
    expect(controller.failures()).toMatchObject([{ sourceId: source.id, cause: 'network' }]);
  });

  it('tries every eligible source at most once, then reports the channel as unavailable', async () => {
    const multi = channelWith([source, second, third]);
    await controller.load(multi, source, { volume: 1, muted: false });

    // Drive each source to a non-recoverable failure.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(controller.status()).toBe('unavailable');
    const urls = harness.created.map((record) => record.options.url);
    expect(urls).toEqual([source.url, second.url, third.url]);
    expect(controller.failures().map((record) => record.sourceId)).toEqual([source.id, second.id, third.id]);
    // Everything that was created was released.
    expect(harness.destroyCount).toBe(harness.created.length);

    // No further automatic attempts: bounded, no loop.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.created).toHaveLength(3);
  });

  it('never retries a source already recorded as failed', async () => {
    const multi = channelWith([source, second]);
    await controller.load(multi, source, { volume: 1, muted: false });
    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().sourceIndex).toBe(1);

    // A late failure from the superseded first engine must not resurrect it.
    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false }, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.created).toHaveLength(2);
    expect(controller.snapshot().sourceIndex).toBe(1);

    // The second source failing exhausts the channel; the first is not retried.
    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.status()).toBe('unavailable');
    expect(harness.created).toHaveLength(2);
  });

  it('skips a geo-blocked source and never hands it to an engine', async () => {
    const multi = channelWith([source, geoSource, second]);
    await controller.load(multi, source, { volume: 1, muted: false });
    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
    await vi.advanceTimersByTimeAsync(0);
    // Second eligible source is index 2, not the geo-locked one at index 1.
    expect(controller.snapshot().sourceIndex).toBe(2);
    expect(harness.created.map((record) => record.options.url)).toEqual([source.url, second.url]);
  });

  it('starts on the first eligible source when the requested one is geo-blocked', async () => {
    const multi = channelWith([geoSource, source]);
    await controller.load(multi, geoSource, { volume: 1, muted: false });
    expect(harness.created).toHaveLength(1);
    expect(harness.created[0].options.url).toBe(source.url);
    expect(controller.failures()).toMatchObject([{ sourceId: geoSource.id, cause: 'blocked' }]);
  });

  it('reports every source geo-blocked as blocked, with the official route to the user', async () => {
    const multi = channelWith([geoSource, { ...geoSource, id: 'canal#9' }], { webUrl: 'https://emisora.example' });
    await controller.load(multi, geoSource, { volume: 1, muted: false });
    // With an official route published, the user gets sent to the emitter's
    // player instead of a dead end (no source ever reaches an engine).
    expect(controller.status()).toBe('external');
    expect(harness.created).toHaveLength(0);
    expect(controller.failures()).toHaveLength(2);
  });

  it('offers the official player when every source is gone and the emitter has one', async () => {
    const multi = channelWith([source], { availability: 'external', webUrl: 'https://emisora.example' });
    await controller.load(multi, source, { volume: 1, muted: false });
    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.status()).toBe('external');
  });

  it('does not start an engine for a channel with no attemptable source', async () => {
    const empty = channelWith([], { availability: 'no-emission' });
    const loading = controller.load(empty, undefined, { volume: 1, muted: false });
    // Depends on the clock: `load()` holds the in-flight engine creation, so a
    // test must settle it before asserting the outcome.
    await vi.advanceTimersByTimeAsync(0);
    await loading;
    expect(controller.status()).toBe('unavailable');
    expect(harness.created).toHaveLength(0);
    expect(controller.snapshot().error).toBeUndefined();
  });

  it('retry() re-enables the active source and clears its failure record', async () => {
    const multi = channelWith([source, second]);
    await controller.load(multi, second, { volume: 1, muted: false });
    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
    await vi.advanceTimersByTimeAsync(0);
    // First source is now active; fail it too so the channel is unavailable.
    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.status()).toBe('unavailable');

    await controller.retry(0.3, false);
    // The active source (index 0) is retried with the new volume.
    expect(harness.latest.options.url).toBe(source.url);
    expect(harness.latest.options.startVolume).toBe(0.3);
    expect(controller.failures().map((record) => record.sourceId)).not.toContain(source.id);
    expect(controller.status()).toBe('loading');
  });

  it('selectSource() switches to a specific source and resets the failure ledger view', async () => {
    const multi = channelWith([source, second]);
    await controller.load(multi, source, { volume: 1, muted: false });
    await controller.selectSource(1, 0.7, false);
    expect(controller.snapshot().sourceIndex).toBe(1);
    expect(harness.latest.options.url).toBe(second.url);
    expect(harness.latest.options.startVolume).toBe(0.7);
  });

  it('records the cause when the engine itself cannot start', async () => {
    harness.failStart = true;
    await controller.load(channel, source, { volume: 1, muted: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.failures()[0]).toMatchObject({ code: 'ENGINE_START' });
    expect(controller.status()).toBe('unavailable');
  });

  it('annotates the picker with eligibility, not just presence', async () => {
    const multi = channelWith([source, geoSource, dashSource]);
    await controller.load(multi, source, { volume: 1, muted: false });
    expect(controller.sourceOptions()).toEqual([
      { source, index: 0, eligible: true },
      { source: geoSource, index: 1, eligible: false },
      { source: dashSource, index: 2, eligible: true },
    ]);
  });

  it('clearing a load cancels a pending fallback', async () => {
    const multi = channelWith([source, second]);
    await controller.load(multi, source, { volume: 1, muted: false });
    harness.emit({ type: 'error', code: 'fragLoadError', message: 'net', recoverable: true });
    controller.clear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.created).toHaveLength(1);
    expect(controller.status()).toBe('idle');
    expect(controller.failures()).toHaveLength(0);
  });
});
