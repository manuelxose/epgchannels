/**
 * Reconciliation invariants: the safety core of the catalogue.
 *
 * The one rule these tests protect above all else: two different regional or
 * local stations are never silently merged. `same` requires an exact
 * normalized-name match plus country AND tvg-id corroboration, and a differing
 * regional/local qualifier forces `review`.
 */
import { describe, expect, it } from 'vitest';
import { reconcile, REVIEW_THRESHOLD, SAME_THRESHOLD } from './reconcile.js';
import type { ChannelIdentityView, ReconcileCandidate } from './types.js';

function candidate(overrides: Partial<ReconcileCandidate> = {}): ReconcileCandidate {
  return {
    name: 'La 1',
    url: 'https://a.example/live.m3u8',
    country: 'ES',
    provider: null,
    groupTitle: null,
    language: 'es',
    attributes: { 'tvg-id': 'La1.es@SD' },
    ...overrides,
  };
}

function identity(overrides: Partial<ChannelIdentityView> = {}): ChannelIdentityView {
  return {
    channelId: 'c1',
    key: 'es:la-1',
    name: 'La 1',
    country: 'ES',
    variantKey: null,
    tvgIds: ['La1.es'],
    urlHosts: ['b.example'],
    ...overrides,
  };
}

describe('reconcile — same station, two upstreams', () => {
  it('collapses iptv-org and Free-TV to `same` when name, country and tvg-id agree', () => {
    // iptv-org style tvg-id carries an `@SD` quality suffix; Free-TV's does not.
    const decision = reconcile(candidate({ attributes: { 'tvg-id': 'La1.es@SD' } }), [
      identity({ tvgIds: ['La1.es'] }),
    ]);
    expect(decision.kind).toBe('same');
    expect(decision.channelId).toBe('c1');
    expect(decision.signals.name).toBe(1);
    expect(decision.signals.country).toBe(1);
    expect(decision.signals.tvgId).toBe(1);
    expect(decision.score).toBeGreaterThanOrEqual(SAME_THRESHOLD);
  });
});

describe('reconcile — disagreement is never `same`', () => {
  it('same name and country but disagreeing tvg-id is `review`', () => {
    const decision = reconcile(candidate({ attributes: { 'tvg-id': 'La1.es' } }), [
      identity({ tvgIds: ['TVE1.es'] }),
    ]);
    expect(decision.kind).toBe('review');
    expect(decision.kind).not.toBe('same');
  });

  it('name-only agreement never reaches `same`', () => {
    const decision = reconcile(
      candidate({ name: 'Fox', country: null, attributes: {}, url: 'https://x/stream' }),
      [identity({ name: 'Fox', country: null, key: ':fox', tvgIds: [], urlHosts: [] })],
    );
    expect(decision.kind).toBe('review');
    expect(decision.kind).not.toBe('same');
  });
});

describe('reconcile — regional / local qualifiers', () => {
  it('a city/region qualifier in the name forces `review`, never `same`', () => {
    const decision = reconcile(
      candidate({ name: 'Canal Sur (Andalucía)', country: 'ES', attributes: {} }),
      [identity({ name: 'Canal Sur', key: 'es:canal-sur', tvgIds: [], urlHosts: [] })],
    );
    expect(decision.kind).toBe('review');
    expect(decision.reason).toMatch(/regional/i);
  });

  it('a differing tvg-id region suffix forces `review`, never `same`', () => {
    // `La1.ast.es` is an Asturias regional feed of the same base `La 1`.
    const decision = reconcile(candidate({ attributes: { 'tvg-id': 'La1.es@SD' } }), [
      identity({ tvgIds: ['La1.ast.es'] }),
    ]);
    expect(decision.kind).toBe('review');
    expect(decision.kind).not.toBe('same');
  });

  it('an existing regional variantKey blocks `same` even when name, country and tvg-id agree', () => {
    const decision = reconcile(candidate({ attributes: { 'tvg-id': 'La1.es' } }), [
      identity({ variantKey: 'es-and' }),
    ]);
    expect(decision.kind).toBe('review');
    expect(decision.kind).not.toBe('same');
  });

  it('two distinct regional stations never merge', () => {
    const decision = reconcile(
      candidate({
        name: 'Canal Sur Andalucía',
        country: 'ES',
        attributes: { 'tvg-id': 'CanalSur.and.es' },
      }),
      [
        identity({
          channelId: 'c2',
          name: 'Canal Sur Cataluña',
          key: 'es:canal-sur-cataluna',
          tvgIds: ['CanalSur.cat.es'],
          urlHosts: [],
        }),
      ],
    );
    expect(decision.kind).not.toBe('same');
  });
});

describe('reconcile — provider hints are not identity', () => {
  it('differing provider field yields an identical decision', () => {
    const a = reconcile(candidate({ provider: 'pluto' }), [identity()]);
    const b = reconcile(candidate({ provider: 'samsung' }), [identity()]);
    expect(a).toEqual(b);
    expect(a.kind).toBe('same');
  });
});

describe('reconcile — determinism and order independence', () => {
  it('is idempotent: identical inputs yield identical decision and score', () => {
    const input = candidate({ attributes: { 'tvg-id': 'La1.es@SD' } });
    const existing = [identity(), identity({ channelId: 'c2', name: 'Canal Sur', key: 'es:canal-sur' })];
    const first = reconcile(input, existing);
    const second = reconcile(input, existing);
    expect(first).toEqual(second);
  });

  it('is independent of the existing-identities array order', () => {
    const input = candidate({ attributes: { 'tvg-id': 'La1.es@SD' } });
    const e1 = identity();
    const e2 = identity({ channelId: 'c2', name: 'Canal Sur', key: 'es:canal-sur' });
    expect(reconcile(input, [e1, e2])).toEqual(reconcile(input, [e2, e1]));
  });

  it('returns `different` with a null channelId for an unrelated candidate', () => {
    const decision = reconcile(
      candidate({ name: 'Fox', country: 'US', attributes: { 'tvg-id': 'Fox.us' } }),
      [identity({ name: 'BBC', country: 'GB', key: 'gb:bbc', tvgIds: ['BBC.uk'] })],
    );
    expect(decision.kind).toBe('different');
    expect(decision.channelId).toBeNull();
    expect(decision.score).toBeLessThan(REVIEW_THRESHOLD);
  });

  it('returns `different` when there are no existing channels', () => {
    const decision = reconcile(candidate(), []);
    expect(decision.kind).toBe('different');
    expect(decision.channelId).toBeNull();
  });
});
