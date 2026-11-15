import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAYER_ENGINE_FACTORY, PlayerController } from './player.controller';
import type { EngineEvent, EngineOptions, EngineRequestKind, PlayerEngine } from '../player/engine';
import type { Channel, MediaSource } from '../models/catalog.model';

/**
 * T2 engine routing, HLS/DASH normalisation and multi-source fallback (spec §5.4).
 *
 * Kept in its own file next to `player.controller.spec.ts` (lifecycle basics) so
 * the recovery state machine can be read and reviewed on its own.
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
  };
}

const hls1: MediaSource = {
  id: 'canal#0',
  label: 'Emisión 1',
  format: 'hls',
  url: 'https://cdn.example.org/one.m3u8',
  geoRestricted: false,
};
const hls2: MediaSource = { ...hls1, id: 'canal#1', label: 'Emisión 2', url: 'https://cdn.example.org/two.m3u8' };
const hls3: MediaSource = { ...hls1, id: 'canal#2', label: 'Emisión 3', url: 'https://cdn.example.org/three.m3u8' };
const dash: MediaSource = {
  id: 'canal#3',
  label: 'Emisión DASH',
  format: 'dash',
  url: 'https://cdn.example.org/stream.mpd',
  geoRestricted: false,
};
const geo: MediaSource = {
  id: 'canal#4',
  label: 'Emisión geo',
  format: 'hls',
  url: 'https://cdn.example.org/geo.m3u8',
  geoRestricted: true,
};

function channelOf(sources: readonly MediaSource[], overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'canal',
    name: 'Canal',
    categoryId: 'es:generalistas',
    categoryName: 'Generalistas',
    country: 'España',
    sources,
    tags: [],
    availability: 'playable',
    ...overrides,
  };
}

class FakeEngineHarness {
  readonly created: { options: EngineOptions; kind: EngineRequestKind; engine: PlayerEngine; destroyed: boolean }[] = [];
  engineKind: 'hls' | 'dash' | 'native' = 'hls';
  failStart = false;

  readonly factory = async (options: EngineOptions, kind: EngineRequestKind): Promise<PlayerEngine> => {
    if (this.failStart) {
      throw new Error('engine start failed');
    }
    const record = { options, kind, destroyed: false } as {
      options: EngineOptions;
      kind: EngineRequestKind;
      engine: PlayerEngine;
      destroyed: boolean;
    };
    record.engine = {
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
    };
    this.created.push(record);
    // One microtask: matches the lazily imported backend, so a test advances
    // past the engine creation before it emits engine events.
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

/**
 * Models how the real backends settle: `createHlsEngine`/`createDashEngine`
 * `await import('hls.js' | 'dashjs')` before the engine exists, so the media
 * element is not playing in the same turn the controller calls the factory.
 * The harness factory yields one microtask for the same reason.
 */
function freshController(): { controller: PlayerController; harness: FakeEngineHarness; media: ReturnType<typeof fakeMedia> } {
  // A fresh injector per test: a cached root controller would keep the engine of
  // a previous test and make every assertion order-dependent.
  TestBed.resetTestingModule();
  const harness = new FakeEngineHarness();
  TestBed.configureTestingModule({ providers: [{ provide: PLAYER_ENGINE_FACTORY, useValue: harness.factory }] });
  const controller = TestBed.inject(PlayerController);
  const media = fakeMedia();
  controller.attachMedia(media as unknown as HTMLVideoElement);
  return { controller, harness, media };
}

describe('PlayerController — engine routing (DASH is a real engine)', () => {
  let controller: PlayerController;
  let harness: FakeEngineHarness;

  beforeEach(() => {
    vi.useFakeTimers();
    ({ controller, harness } = freshController());
  });

  afterEach(() => {
    controller.clear();
    vi.useRealTimers();
  });

  it('routes an .mpd source to the dash backend, never to progressive', async () => {
    await controller.load(channelOf([dash]), dash, { volume: 1, muted: false });
    expect(harness.created).toHaveLength(1);
    expect(harness.latest.kind).toBe('dash');
    expect(harness.created.map((record) => record.kind)).not.toContain('progressive');
    expect(harness.latest.options.url).toBe('https://cdn.example.org/stream.mpd');
  });

  it('keeps routing HLS sources to the hls backend', async () => {
    await controller.load(channelOf([hls1]), hls1, { volume: 1, muted: false });
    expect(harness.latest.kind).toBe('hls');
  });

  it('surfaces the dash engine kind and source format for the UI', async () => {
    harness.engineKind = 'dash';
    await controller.load(channelOf([dash]), dash, { volume: 1, muted: false });
    expect(controller.snapshot().engine).toBe('dash');
    expect(controller.snapshot().source?.format).toBe('dash');
  });

  it('normalises dash manifest qualities, tracks and quality changes like HLS', async () => {
    harness.engineKind = 'dash';
    await controller.load(channelOf([dash]), dash, { volume: 1, muted: false });
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
  });
});

describe('PlayerController — error classification is deterministic', () => {
  let controller: PlayerController;
  let harness: FakeEngineHarness;

  beforeEach(() => {
    vi.useFakeTimers();
    ({ controller, harness } = freshController());
  });

  afterEach(() => {
    controller.clear();
    vi.useRealTimers();
  });

  it('never lets a non-recoverable MEDIA error enter the retry budget', async () => {
    await controller.load(channelOf([hls1]), hls1, { volume: 1, muted: false });
    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
    // Decided synchronously: no scheduled retry exists.
    expect(controller.snapshot().attempts).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.created).toHaveLength(1);
    expect(controller.status()).toBe('unavailable');
    expect(controller.failures()).toMatchObject([{ sourceId: hls1.id, failureClass: 'permanent' }]);
  });

  it('advances a non-recoverable MEDIA error to the next eligible source exactly once', async () => {
    await controller.load(channelOf([hls1, hls2]), hls1, { volume: 1, muted: false });
    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.created.map((record) => record.options.url)).toEqual([hls1.url, hls2.url]);
    expect(controller.snapshot().sourceIndex).toBe(1);
    // The failed engine was released before the next one started.
    expect(harness.created[0].destroyed).toBe(true);
  });

  it('treats a DRM refusal as blocked with no retry and no fallback', async () => {
    await controller.load(channelOf([dash, hls2]), dash, { volume: 1, muted: false });
    // The refuted route is never retried; the other published route is tried
    // once, because a key lock applies to that route, not to the channel.
    harness.emit({ type: 'error', code: 'BLOCKED_DRM', message: 'DRM', recoverable: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.created.map((record) => record.options.url)).toEqual([dash.url, hls2.url]);
    expect(harness.created.filter((record) => record.options.url === dash.url)).toHaveLength(1);
    expect(controller.failures()).toMatchObject([{ sourceId: dash.id, cause: 'blocked', failureClass: 'blocked' }]);
  });

  it('stops on an unsupported browser without retrying or falling back', async () => {
    await controller.load(channelOf([dash, hls2]), dash, { volume: 1, muted: false });
    harness.emit({ type: 'error', code: 'UNSUPPORTED_MEDIASOURCE', message: 'no MSE', recoverable: false });
    await vi.advanceTimersByTimeAsync(10_000);
    // The failing source is released and never retried; the alternate source is
    // attempted once because it may use a container this browser can decode.
    expect(harness.created.map((record) => record.options.url)).toEqual([dash.url, hls2.url]);
    expect(harness.created[0].destroyed).toBe(true);
    expect(harness.created.filter((record) => record.options.url === dash.url)).toHaveLength(1);
  });

  it('classifies an invalid manifest as a format failure (not a network fault)', async () => {
    await controller.load(channelOf([hls1]), hls1, { volume: 1, muted: false });
    harness.emit({ type: 'error', code: 'MANIFEST_INVALID', message: 'bad mpd', recoverable: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.snapshot().attempts).toBe(0);
    expect(controller.failures()[0]).toMatchObject({ cause: 'format' });
  });
});

describe('PlayerController — bounded multi-source fallback (spec §5.4)', () => {
  let controller: PlayerController;
  let harness: FakeEngineHarness;
  let media: ReturnType<typeof fakeMedia>;

  beforeEach(() => {
    vi.useFakeTimers();
    ({ controller, harness, media } = freshController());
  });

  afterEach(() => {
    controller.clear();
    vi.useRealTimers();
  });

  it('retries a transient failure twice, then tries the next eligible source once', async () => {
    await controller.load(channelOf([hls1, hls2]), hls1, { volume: 0.5, muted: true });
    harness.emit({ type: 'error', code: 'fragLoadError', message: 'net', recoverable: true });
    await vi.advanceTimersByTimeAsync(1_000);
    harness.emit({ type: 'error', code: 'fragLoadError', message: 'net', recoverable: true });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.created.map((record) => record.options.url)).toEqual([hls1.url, hls1.url, hls1.url]);

    harness.emit({ type: 'error', code: 'fragLoadError', message: 'net', recoverable: true });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(harness.created.map((record) => record.options.url)).toEqual([hls1.url, hls1.url, hls1.url, hls2.url]);
    // The fallback inherits the user's current volume and mute.
    expect(harness.latest.options.startVolume).toBe(0.5);
    expect(harness.latest.options.muted).toBe(true);
    expect(controller.snapshot().sourceIndex).toBe(1);
    expect(controller.snapshot().notice).toContain('Emisión 2');
    expect(controller.failures()).toMatchObject([{ sourceId: hls1.id, cause: 'network', failureClass: 'transient' }]);
  });

  it('tries each eligible source at most once and then reports the channel unavailable', async () => {
    await controller.load(channelOf([hls1, hls2, hls3]), hls1, { volume: 1, muted: false });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(controller.status()).toBe('unavailable');
    expect(harness.created.map((record) => record.options.url)).toEqual([hls1.url, hls2.url, hls3.url]);
    expect(controller.failures().map((record) => record.sourceId)).toEqual([hls1.id, hls2.id, hls3.id]);
    expect(harness.destroyCount).toBe(harness.created.length);

    // Bounded: nothing else is attempted later.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.created).toHaveLength(3);
  });

  it('never retries a source already recorded as failed, and ignores stale engines', async () => {
    await controller.load(channelOf([hls1, hls2]), hls1, { volume: 1, muted: false });
    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().sourceIndex).toBe(1);

    // A late event from the superseded engine must be dropped by the generation guard.
    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false }, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.created).toHaveLength(2);
    expect(controller.snapshot().sourceIndex).toBe(1);

    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.status()).toBe('unavailable');
    expect(harness.created).toHaveLength(2);
  });

  it('skips a geo-blocked source entirely (it never reaches an engine)', async () => {
    await controller.load(channelOf([hls1, geo, hls2]), hls1, { volume: 1, muted: false });
    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().sourceIndex).toBe(2);
    expect(harness.created.map((record) => record.options.url)).toEqual([hls1.url, hls2.url]);
  });

  it('starts on the first eligible source when the requested one is geo-blocked', async () => {
    await controller.load(channelOf([geo, hls1]), geo, { volume: 1, muted: false });
    expect(harness.created.map((record) => record.options.url)).toEqual([hls1.url]);
    expect(controller.failures()).toMatchObject([{ sourceId: geo.id, cause: 'blocked' }]);
  });

  it('reports a channel with only blocked sources as blocked without starting an engine', async () => {
    const other = { ...geo, id: 'canal#5', url: 'https://cdn.example.org/geo-two.m3u8' };
    // No emitter route: there is nowhere else to send the user, so the honest
    // terminal state is `blocked` (see the `external` case below).
    await controller.load(channelOf([geo, other], { availability: 'unavailable' }), geo, { volume: 1, muted: false });
    expect(controller.status()).toBe('blocked');
    expect(harness.created).toHaveLength(0);
    expect(controller.failures().length).toBeGreaterThan(0);
    expect(controller.failures().every((record) => record.cause === 'blocked')).toBe(true);
  });

  it('offers the official player when every source is gone and the emitter has one', async () => {
    await controller.load(channelOf([hls1], { availability: 'external', webUrl: 'https://emisora.example' }), hls1, {
      volume: 1,
      muted: false,
    });
    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.status()).toBe('external');
  });

  it('does not start an engine for a channel with no attemptable source', async () => {
    await controller.load(channelOf([], { availability: 'no-emission' }), undefined, { volume: 1, muted: false });
    // Depends on the clock: `load()` keeps (and returns) the in-flight engine
    // creation, so a test must settle it before asserting the outcome.
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.status()).toBe('unavailable');
    expect(harness.created).toHaveLength(0);
  });

  it('re-enables a recorded failure only through retry(), with the new volume', async () => {
    await controller.load(channelOf([hls1, hls2]), hls2, { volume: 1, muted: false });
    expect(controller.snapshot().sourceIndex).toBe(1);

    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().sourceIndex).toBe(0);

    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.status()).toBe('unavailable');

    await controller.retry(0.3, false);
    expect(harness.latest.options.url).toBe(hls1.url);
    expect(harness.latest.options.startVolume).toBe(0.3);
    expect(controller.failures().map((record) => record.sourceId)).not.toContain(hls1.id);
  });

  it('switches to an explicitly chosen source with the current volume', async () => {
    await controller.load(channelOf([hls1, hls2]), hls1, { volume: 1, muted: false });
    await controller.selectSource(1, 0.7, true);
    expect(controller.snapshot().sourceIndex).toBe(1);
    expect(harness.latest.options.url).toBe(hls2.url);
    expect(harness.latest.options.startVolume).toBe(0.7);
    expect(harness.latest.options.muted).toBe(true);
  });

  it('records the cause when the engine itself cannot start', async () => {
    harness.failStart = true;
    await controller.load(channelOf([hls1]), hls1, { volume: 1, muted: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.failures()[0]).toMatchObject({ code: 'ENGINE_START' });
    expect(controller.status()).toBe('unavailable');
  });

  it('annotates the source picker with eligibility, not just presence', async () => {
    await controller.load(channelOf([hls1, geo, dash]), hls1, { volume: 1, muted: false });
    expect(controller.sourceOptions()).toEqual([
      { source: hls1, index: 0, eligible: true },
      { source: geo, index: 1, eligible: false },
      { source: dash, index: 2, eligible: true },
    ]);
  });

  it('judges a source that plays nothing after the watchdog window', async () => {
    await controller.load(channelOf([hls1]), hls1, { volume: 1, muted: false });
    harness.emit({ type: 'can-play' });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(controller.failures()[0]).toMatchObject({ code: 'NO_FRAMES', cause: 'no-frames' });
    // The single source is gone, so the channel reports itself unavailable.
    expect(controller.status()).toBe('unavailable');
  });

  it('keeps a source alive while frames keep arriving', async () => {
    await controller.load(channelOf([hls1]), hls1, { volume: 1, muted: false });
    media.videoWidth = 1280;
    harness.emit({ type: 'playing' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(controller.status()).toBe('playing');
    expect(controller.failures()).toHaveLength(0);
  });

  it('cancels a pending fallback and retries when the load is cleared', async () => {
    await controller.load(channelOf([hls1, hls2]), hls1, { volume: 1, muted: false });
    harness.emit({ type: 'error', code: 'fragLoadError', message: 'net', recoverable: true });
    controller.clear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.created).toHaveLength(1);
    expect(controller.status()).toBe('idle');
    expect(controller.failures()).toHaveLength(0);
  });

  /*
   * Regression (TDT-CLONE-10 §1): muting used to reload a healthy stream,
   * because the UI round-tripped its state through `load()`/`retry()` instead
   * of the engine's own audio controls. Changing volume or mute — or any
   * status/detection-driven re-render — must never recreate the engine.
   */
  it('never recreates a healthy stream when the user mutes, unmutes or changes volume', async () => {
    await controller.load(channelOf([hls1, hls2]), hls1, { volume: 0.8, muted: false });
    harness.emit({ type: 'playing' });
    media.videoWidth = 1280;
    expect(harness.created).toHaveLength(1);

    controller.setMuted(true);
    controller.setMuted(false);
    controller.setVolume(0.3);
    controller.setVolume(0.9);
    // Re-reading the snapshot (what a template re-render does) changes nothing.
    controller.snapshot();
    await vi.advanceTimersByTimeAsync(30_000);

    // One engine, still the same one, never destroyed or rebuilt.
    expect(harness.created).toHaveLength(1);
    expect(harness.created[0].destroyed).toBe(false);
    expect(harness.latest.options.url).toBe(hls1.url);
    expect(controller.status()).toBe('playing');
    expect(controller.failures()).toHaveLength(0);
  });

  it('keeps the mute and volume the user chose for the next retry', async () => {
    await controller.load(channelOf([hls1, hls2]), hls1, { volume: 1, muted: false });
    controller.setMuted(true);
    controller.setVolume(0.25);
    harness.emit({ type: 'error', code: 'MEDIA', message: 'bad', recoverable: false });
    await vi.advanceTimersByTimeAsync(0);

    // The fallback inherits the user's *current* audio state, not the one the
    // channel was first opened with.
    expect(harness.latest.options.url).toBe(hls2.url);
    expect(harness.latest.options.muted).toBe(true);
    expect(harness.latest.options.startVolume).toBe(0.25);
  });
});
