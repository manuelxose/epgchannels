import { describe, expect, it, vi } from 'vitest';
import {
  BATCH_SIZE,
  MAX_EVENTS,
  MIN_FLUSH_INTERVAL_MS,
  PlaybackTelemetry,
  sanitizeUrl,
  type PlaybackRecord,
} from './playback-telemetry';

/** A controllable clock, so throttle behaviour is asserted without real waiting. */
function clock(start = 1_000) {
  let time = start;
  return {
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
  };
}

describe('sanitizeUrl', () => {
  it('drops the query and fragment, which is where tokens live', () => {
    expect(sanitizeUrl('https://cdn.example.com/live/ch1.m3u8?token=SECRET&sig=abc')).toBe(
      'https://cdn.example.com/live/ch1.m3u8',
    );
    expect(sanitizeUrl('https://cdn.example.com/live/ch1.m3u8#frag')).toBe('https://cdn.example.com/live/ch1.m3u8');
  });

  it('returns undefined for a missing or unparseable value rather than recording it verbatim', () => {
    expect(sanitizeUrl(undefined)).toBeUndefined();
    expect(sanitizeUrl('')).toBeUndefined();
  });

  it('keeps a relative path relative, without inventing an origin', () => {
    expect(sanitizeUrl('/demo/media/master.m3u8?x=1')).toBe('/demo/media/master.m3u8');
  });
});

describe('PlaybackTelemetry', () => {
  it('sends nothing anywhere when no collector is configured', () => {
    const sink = vi.fn();
    const telemetry = new PlaybackTelemetry({ now: clock().now });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    telemetry.record({ name: 'playback-start', channelId: 'ch1' });
    telemetry.record({ name: 'first-frame', channelId: 'ch1' });

    expect(sink).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(telemetry.collectionEnabled).toBe(false);
    vi.unstubAllGlobals();
  });

  it('bounds the buffer instead of growing without limit', () => {
    const telemetry = new PlaybackTelemetry({ now: clock().now, maxEvents: 5 });
    for (let index = 0; index < 20; index += 1) {
      telemetry.record({ name: 'buffering', channelId: `ch${index}` });
    }
    const snapshot = telemetry.snapshot();
    expect(snapshot).toHaveLength(5);
    // The newest records survive.
    expect(snapshot[snapshot.length - 1]?.channelId).toBe('ch19');
  });

  it('defaults its cap to MAX_EVENTS', () => {
    const telemetry = new PlaybackTelemetry({ now: clock().now });
    for (let index = 0; index < MAX_EVENTS + 50; index += 1) {
      telemetry.record({ name: 'playing' });
    }
    expect(telemetry.snapshot()).toHaveLength(MAX_EVENTS);
  });

  it('measures first-frame as the gap since playback-start', () => {
    const time = clock();
    const telemetry = new PlaybackTelemetry({ now: time.now });
    telemetry.record({ name: 'playback-start', channelId: 'ch1', format: 'hls' });
    time.advance(1_450);
    telemetry.record({ name: 'first-frame', channelId: 'ch1' });

    const firstFrame = telemetry.snapshot().find((event) => event.name === 'first-frame');
    expect(firstFrame?.durationMs).toBe(1_450);
  });

  it('does not invent a duration when no playback-start was recorded', () => {
    const telemetry = new PlaybackTelemetry({ now: clock().now });
    telemetry.record({ name: 'first-frame' });
    expect(telemetry.snapshot()[0]?.durationMs).toBeUndefined();
  });

  it('throttles to one batch per interval, caps each batch, and loses nothing', () => {
    const time = clock();
    const batches: PlaybackRecord[][] = [];
    const telemetry = new PlaybackTelemetry({
      now: time.now,
      sink: (batch) => batches.push([...batch]),
      batchSize: 2,
      minFlushIntervalMs: 1_000,
    });

    // The FIRST record flushes immediately, so a short session still reports.
    telemetry.record({ name: 'playing' });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);

    // Records arriving inside the window are queued, not sent.
    telemetry.record({ name: 'buffering' });
    telemetry.record({ name: 'playing' });
    expect(batches).toHaveLength(1);

    // Still throttled just before the interval elapses.
    time.advance(999);
    telemetry.record({ name: 'playing' });
    expect(batches).toHaveLength(1);

    // Once allowed, exactly one batch of at most `batchSize` is released.
    time.advance(1);
    telemetry.record({ name: 'playing' });
    expect(batches).toHaveLength(2);
    expect(batches[1]?.length).toBeLessThanOrEqual(2);

    // Every subsequent interval drains more of the backlog.
    time.advance(1_000);
    telemetry.record({ name: 'playing' });
    time.advance(1_000);
    telemetry.record({ name: 'playing' });

    // Nothing was ever lost: the collector received every retained record.
    expect(batches.flat()).toHaveLength(telemetry.snapshot().length);
  });

  it('uses no timers at all: a paused player costs nothing', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const telemetry = new PlaybackTelemetry({ now: clock().now, sink: () => undefined });

    telemetry.record({ name: 'playback-start' });
    telemetry.record({ name: 'playing' });
    telemetry.record({ name: 'buffering' });
    // Idle: nothing is scheduled, so nothing runs while paused or hidden.
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    setIntervalSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });

  it('does no per-frame work: it never touches requestAnimationFrame', () => {
    const rafSpy = vi.fn();
    vi.stubGlobal('requestAnimationFrame', rafSpy);
    const telemetry = new PlaybackTelemetry({ now: clock().now, sink: () => undefined });
    for (let index = 0; index < 30; index += 1) {
      telemetry.record({ name: 'playing' });
    }
    expect(rafSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('records the codes it is given, and never classifies failure by itself', () => {
    const telemetry = new PlaybackTelemetry({ now: clock().now });
    // The caller supplies the code from a real MediaError / engine event.
    telemetry.record({ name: 'error', code: 'MEDIA_ERR_SRC_NOT_SUPPORTED', format: 'hls' });
    const [error] = telemetry.snapshot();
    expect(error?.code).toBe('MEDIA_ERR_SRC_NOT_SUPPORTED');
    // Recording a failure never removes or downgrades the evidence that it played.
    telemetry.record({ name: 'playing' });
    expect(telemetry.snapshot().filter((event) => event.name === 'playing')).toHaveLength(1);
  });

  it('keeps playback working when the collector throws', () => {
    const telemetry = new PlaybackTelemetry({
      now: clock().now,
      sink: () => {
        throw new Error('collector down');
      },
    });
    expect(() => telemetry.record({ name: 'playback-start' })).not.toThrow();
    // The retained copy survives regardless of the transport failing.
    expect(telemetry.snapshot()).toHaveLength(1);
  });

  it('uses the default batch size for a large burst', () => {
    const time = clock();
    const batches: PlaybackRecord[][] = [];
    const telemetry = new PlaybackTelemetry({
      now: time.now,
      sink: (batch) => batches.push([...batch]),
      minFlushIntervalMs: 0,
    });
    for (let index = 0; index < BATCH_SIZE + 10; index += 1) {
      telemetry.record({ name: 'playing' });
    }
    expect(batches[0]?.length).toBeLessThanOrEqual(BATCH_SIZE);
  });

  it('reset clears both retained and pending records', () => {
    const telemetry = new PlaybackTelemetry({ now: clock().now });
    telemetry.record({ name: 'playing' });
    telemetry.reset();
    expect(telemetry.snapshot()).toHaveLength(0);
  });

  it('does not queue anything for a sink when none exists', () => {
    const time = clock();
    const telemetry = new PlaybackTelemetry({ now: time.now });
    for (let index = 0; index < 10; index += 1) {
      telemetry.record({ name: 'playing' });
    }
    time.advance(60_000);
    // `snapshot` is the only observable here; the point is that no transport ran.
    expect(telemetry.collectionEnabled).toBe(false);
    expect(telemetry.snapshot()).toHaveLength(10);
  });
});
