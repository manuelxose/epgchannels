/**
 * Publication policy: authorisation first, availability second, never confused.
 *
 * These are the rules that stop the platform from presenting a third party's
 * signal as an available resource. They are pure functions, so they are tested
 * exhaustively without a database.
 */
import { describe, expect, it } from 'vitest';
import {
  canAttemptInApp,
  compareSources,
  decidePublication,
  engineFor,
  EXCLUSION_MESSAGES,
  isSourceHealthy,
  isSourcePublic,
} from './publication-policy.js';
import type { PlaybackSourceDoc } from '../../infrastructure/schema.js';

function source(overrides: Partial<PlaybackSourceDoc> = {}): PlaybackSourceDoc {
  return {
    _id: '00000000-0000-4000-8000-000000000001',
    channelId: '00000000-0000-4000-8000-0000000000aa',
    provider: 'emitter:example.org',
    type: 'hls',
    url: 'https://example.org/live/master.m3u8',
    officialPageUrl: 'https://example.org/directo',
    permission: 'emitter-public-stream',
    authorisationEvidence: 'evidencia',
    conditions: {
      embedAllowed: true,
      proxyAllowed: false,
      worldwide: true,
      restrictedRegions: [],
      browserCompatibility: 'all',
      requiresForgedHeader: false,
      emitterAppOnly: false,
      notes: null,
    },
    priority: 100,
    editorialStatus: 'published',
    technicalStatus: 'ok',
    lastVerifiedAt: new Date(),
    lastVerification: null,
    provenance: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    revision: 1,
    ...overrides,
  };
}

describe('publication policy', () => {
  it('publishes a licensed, healthy emitter stream', () => {
    expect(decidePublication({
      channelStatus: 'published',
      sourceStatus: 'published',
      permission: 'emitter-public-stream',
      technicalStatus: 'ok',
      conditions: source().conditions,
    })).toEqual({ public: true });
  });

  it.each(['emitter-public-stream', 'emitter-embeddable', 'official-player-only', 'open-data-licence', 'explicit-permission'] as const)(
    'publishes under permission %s',
    (permission) => {
      expect(decidePublication({
        channelStatus: 'published',
        sourceStatus: 'published',
        permission,
        technicalStatus: 'ok',
        conditions: source().conditions,
      }).public).toBe(true);
    },
  );

  it('never publishes an unlicensed source, even when it works', () => {
    const decision = decidePublication({
      channelStatus: 'published',
      sourceStatus: 'published',
      permission: 'unlicensed',
      technicalStatus: 'ok',
      conditions: source().conditions,
    });
    expect(decision).toEqual({ public: false, reason: 'unlicensed' });
    expect(isSourcePublic(source({ permission: 'unlicensed' }))).toBe(false);
  });

  it('refuses a source that would need a forged header', () => {
    const decision = decidePublication({
      channelStatus: 'published',
      sourceStatus: 'published',
      permission: 'emitter-public-stream',
      technicalStatus: 'ok',
      conditions: { ...source().conditions, requiresForgedHeader: true },
    });
    expect(decision).toEqual({ public: false, reason: 'requires-forged-header' });
  });

  it('refuses a source the emitter restricts to its own application', () => {
    const decision = decidePublication({
      channelStatus: 'published',
      sourceStatus: 'published',
      permission: 'emitter-public-stream',
      technicalStatus: 'ok',
      conditions: { ...source().conditions, emitterAppOnly: true },
    });
    expect(decision).toEqual({ public: false, reason: 'emitter-app-only' });
  });

  it('precedence: a withdrawn channel wins over a healthy source', () => {
    expect(
      decidePublication({
        channelStatus: 'withdrawn',
        sourceStatus: 'published',
        permission: 'emitter-public-stream',
        technicalStatus: 'ok',
        conditions: source().conditions,
      }),
    ).toEqual({ public: false, reason: 'channel-withdrawn' });
  });

  it('precedence: a withdrawn source wins over an invalid permission', () => {
    expect(
      decidePublication({
        channelStatus: 'published',
        sourceStatus: 'withdrawn',
        permission: 'unlicensed',
        technicalStatus: 'ok',
        conditions: source().conditions,
      }),
    ).toEqual({ public: false, reason: 'withdrawn' });
  });

  it('keeps draft and review sources out of the public surface', () => {
    for (const status of ['draft', 'review'] as const) {
      expect(
        decidePublication({
          channelStatus: 'published',
          sourceStatus: status,
          permission: 'emitter-public-stream',
          technicalStatus: 'ok',
          conditions: source().conditions,
        }).public,
      ).toBe(false);
    }
  });

  it('a source marked blocked by verification is never exposed', () => {
    expect(
      decidePublication({
        channelStatus: 'published',
        sourceStatus: 'published',
        permission: 'emitter-public-stream',
        technicalStatus: 'blocked',
        conditions: source().conditions,
      }),
    ).toEqual({ public: false, reason: 'disallowed-integration' });
  });

  it('separates permission from health: an unreachable source stays public but unhealthy', () => {
    const unhealthy = source({ technicalStatus: 'http-error' });
    expect(isSourcePublic(unhealthy)).toBe(true);
    expect(isSourceHealthy(unhealthy)).toBe(false);
    expect(canAttemptInApp(unhealthy)).toBe(false);
  });

  it('an unknown health state is attemptable (never assumed broken)', () => {
    const unknown = source({ technicalStatus: 'unknown' });
    expect(isSourcePublic(unknown)).toBe(true);
    expect(isSourceHealthy(unknown)).toBe(true);
    expect(canAttemptInApp(unknown)).toBe(true);
  });

  it('external sources are public but never attempted in-app', () => {
    const external = source({ type: 'external', url: 'https://example.org/directo' });
    expect(isSourcePublic(external)).toBe(true);
    expect(canAttemptInApp(external)).toBe(false);
    expect(engineFor(external)).toBe('external');
  });

  it.each([
    ['hls', 'hls'],
    ['dash', 'dash'],
    ['youtube', 'youtube-iframe'],
    ['official-embed', 'official-embed'],
    ['external', 'external'],
  ] as const)('maps type %s to engine %s', (type, engine) => {
    expect(engineFor(source({ type }))).toBe(engine);
  });

  it('a source without a URL is never attemptable', () => {
    expect(canAttemptInApp(source({ url: null }))).toBe(false);
  });

  it('orders by priority, then by worldwide reach, then by age', () => {
    const geo = source({ priority: 10, conditions: { ...source().conditions, worldwide: false } });
    const worldwide = source({ priority: 10 });
    const earlier = source({ priority: 5 });
    expect([worldwide, earlier, geo].sort(compareSources).map((entry) => entry._id)).toEqual([
      earlier._id,
      worldwide._id,
      geo._id,
    ]);
  });

  it('every exclusion reason has a human explanation', () => {
    for (const message of Object.values(EXCLUSION_MESSAGES)) {
      expect(message.length).toBeGreaterThan(10);
    }
  });
});
