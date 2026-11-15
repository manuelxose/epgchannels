import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  isTerminalStatus,
  nextFallbackIndex,
  playbackStateFor,
  reducePlayerStatus,
  type PlayerEvent,
  type PlayerStatus,
} from './player-state';

const ALL_EVENTS: PlayerEvent[] = [
  'select-source',
  'manifest-ready',
  'can-play',
  'playing',
  'waiting',
  'pause',
  'ended',
  'error',
  'unavailable',
  'external',
  'blocked',
  'unsupported',
  'clear',
];

const ALL_STATES: PlayerStatus[] = [
  'idle',
  'loading',
  'buffering',
  'playing',
  'paused',
  'error',
  'unavailable',
  'external',
  'blocked',
  'unsupported',
];

describe('reducePlayerStatus', () => {
  it('loads from idle only on select-source', () => {
    expect(reducePlayerStatus('idle', 'select-source')).toBe('loading');
    expect(reducePlayerStatus('idle', 'playing')).toBe('idle');
    expect(reducePlayerStatus('idle', 'pause')).toBe('idle');
  });

  it('never reaches playing directly from error', () => {
    expect(reducePlayerStatus('error', 'playing')).toBe('error');
    expect(reducePlayerStatus('error', 'can-play')).toBe('error');
    expect(reducePlayerStatus('error', 'select-source')).toBe('loading');
  });

  it('ignores pause while still loading', () => {
    expect(reducePlayerStatus('loading', 'pause')).toBe('loading');
  });

  it('goes back to paused from an active playback pause', () => {
    expect(reducePlayerStatus('playing', 'pause')).toBe('paused');
  });

  it('does not treat a pause while buffering as a user-visible pause', () => {
    expect(reducePlayerStatus('buffering', 'pause')).toBe('buffering');
  });

  it('only buffers from active playback', () => {
    expect(reducePlayerStatus('playing', 'waiting')).toBe('buffering');
    expect(reducePlayerStatus('buffering', 'waiting')).toBe('buffering');
    expect(reducePlayerStatus('loading', 'waiting')).toBe('loading');
  });

  it('resumes from buffering and paused on playing', () => {
    expect(reducePlayerStatus('buffering', 'playing')).toBe('playing');
    expect(reducePlayerStatus('paused', 'playing')).toBe('playing');
  });

  it('treats ended as paused', () => {
    expect(reducePlayerStatus('playing', 'ended')).toBe('paused');
  });

  it('makes terminal states exit only via select-source or clear', () => {
    for (const status of ['unavailable', 'external', 'blocked', 'unsupported'] as PlayerStatus[]) {
      expect(reducePlayerStatus(status, 'playing')).toBe(status);
      expect(reducePlayerStatus(status, 'error')).toBe(status);
      expect(reducePlayerStatus(status, 'select-source')).toBe('loading');
      expect(reducePlayerStatus(status, 'clear')).toBe('idle');
    }
  });

  it('lets a failed source fall back into loading, or end as unavailable', () => {
    expect(reducePlayerStatus('error', 'select-source')).toBe('loading');
    expect(reducePlayerStatus('error', 'unavailable')).toBe('unavailable');
    // Nothing can resurrect an unavailable channel except a new source.
    expect(reducePlayerStatus('unavailable', 'playing')).toBe('unavailable');
    // An official route can be offered once no source is left.
    expect(reducePlayerStatus('unavailable', 'external')).toBe('external');
  });

  it('clears to idle from every state', () => {
    for (const status of ALL_STATES) {
      expect(reducePlayerStatus(status, 'clear')).toBe('idle');
    }
  });

  it('is total: no event ever throws or yields an unknown status', () => {
    for (const status of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        expect(ALL_STATES).toContain(reducePlayerStatus(status, event));
      }
    }
  });
});

describe('playbackStateFor', () => {
  it('maps every status onto exactly one P5 playback class', () => {
    const expected: Record<PlayerStatus, string> = {
      idle: 'idle',
      loading: 'loading',
      buffering: 'loading',
      playing: 'playing',
      paused: 'paused',
      error: 'recoverable-failure',
      unavailable: 'source-unavailable',
      external: 'external-official',
      blocked: 'unauthorised',
      unsupported: 'unsupported',
    };
    for (const status of ALL_STATES) {
      expect(playbackStateFor(status)).toBe(expected[status]);
    }
  });

  it('separates terminal states from recoverable ones', () => {
    expect(isTerminalStatus('error')).toBe(true);
    expect(isTerminalStatus('unavailable')).toBe(true);
    expect(isTerminalStatus('external')).toBe(true);
    expect(isTerminalStatus('playing')).toBe(false);
    expect(isTerminalStatus('loading')).toBe(false);
  });
});

describe('classifyFailure', () => {
  it('treats recoverable network-ish errors as transient', () => {
    expect(classifyFailure({ code: 'fragLoadError', message: 'x', recoverable: true })).toBe('transient');
    expect(classifyFailure({ code: 'NO_FRAMES', message: 'x', recoverable: true })).toBe('transient');
  });

  it('never falls back for a DRM, geo or authorisation refusal', () => {
    expect(classifyFailure({ code: 'BLOCKED_DRM', message: 'x', recoverable: false })).toBe('blocked');
    expect(classifyFailure({ code: 'BLOCKED_SOURCE', message: 'x', recoverable: false })).toBe('blocked');
    // Even a "recoverable" code is a refusal when it says so explicitly.
    expect(classifyFailure({ code: 'GEO_UNAVAILABLE', message: 'x', recoverable: true })).toBe('blocked');
  });

  it('recognises unsupported media and invalid manifests', () => {
    expect(classifyFailure({ code: 'UNSUPPORTED', message: 'x', recoverable: false })).toBe('unsupported');
    expect(classifyFailure({ code: 'UNSUPPORTED_MEDIASOURCE', message: 'x', recoverable: false })).toBe('unsupported');
    expect(classifyFailure({ code: 'MANIFEST_INVALID', message: 'x', recoverable: false })).toBe('invalid');
    expect(classifyFailure({ code: 'FORMAT_MISMATCH', message: 'x', recoverable: false })).toBe('invalid');
  });

  it('treats a non-recoverable media error as permanent', () => {
    expect(classifyFailure({ code: 'MEDIA_4', message: 'x', recoverable: false })).toBe('permanent');
    expect(classifyFailure({ code: 'APPEND_ERROR', message: 'x', recoverable: false })).toBe('permanent');
  });
});

describe('nextFallbackIndex', () => {
  const sources = [
    { id: 'a', eligible: true },
    { id: 'b', eligible: false },
    { id: 'c', eligible: true },
    { id: 'd', eligible: true },
  ];

  it('picks the next eligible, not-yet-failed source', () => {
    expect(nextFallbackIndex(sources, ['a'], 0, 'transient')).toBe(2);
    expect(nextFallbackIndex(sources, ['a', 'c'], 0, 'transient')).toBe(3);
  });

  it('wraps around once but never returns the current source', () => {
    expect(nextFallbackIndex(sources, ['d'], 3, 'transient')).toBe(0);
    expect(nextFallbackIndex([{ id: 'only', eligible: true }], ['only'], 0, 'transient')).toBeUndefined();
  });

  it('never retries a source already recorded as failed', () => {
    expect(nextFallbackIndex(sources, ['a', 'c', 'd'], 0, 'transient')).toBeUndefined();
  });

  it('skips ineligible sources (geo, embeds, unplayable URLs)', () => {
    expect(nextFallbackIndex(sources, ['a'], 0, 'transient')).toBe(2);
  });

  it('does not fall back for a blocked, permanent or unsupported failure', () => {
    expect(nextFallbackIndex(sources, ['a'], 0, 'blocked')).toBeUndefined();
    expect(nextFallbackIndex(sources, ['a'], 0, 'permanent')).toBeUndefined();
    expect(nextFallbackIndex(sources, ['a'], 0, 'unsupported')).toBeUndefined();
    expect(nextFallbackIndex(sources, ['a'], 0, 'invalid')).toBeUndefined();
  });
});
