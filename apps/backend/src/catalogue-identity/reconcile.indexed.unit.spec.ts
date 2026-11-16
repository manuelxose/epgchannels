/**
 * Indexed reconciliation: equivalence with the full scan, bucketed (sub-linear)
 * lookup, tolerance of the store's current identity projection, and a
 * documented before/after per-call cost measurement.
 */
import { describe, expect, it } from 'vitest';
import {
  buildIdentityIndex,
  collectCandidateViews,
  reconcile,
  reconcileIndexed,
  reconcileNaive,
} from './reconcile.js';
import { identityKey, normalizeChannelName } from './normalize.js';
import type { ChannelIdentityView, ReconcileCandidate } from './types.js';

const COUNTRIES = ['ES', 'US', 'GB', 'MX', 'FR', 'DE', 'IT', 'PT', 'AR', 'BR'];
const NETWORKS = ['Canal', 'Tele', 'Radio', 'TV', 'Net'];

function viewName(i: number): string {
  return `${NETWORKS[i % NETWORKS.length] ?? 'Canal'} ${i % 200}${i % 7 === 0 ? ' HD' : ''}`;
}

function viewCountry(i: number): string {
  return COUNTRIES[i % COUNTRIES.length] ?? 'ES';
}

function viewTvgId(i: number): string {
  const base = NETWORKS[i % NETWORKS.length] ?? 'Canal';
  return `${base}${i % 200}.${viewCountry(i).toLowerCase()}${i % 3 === 0 ? '@SD' : ''}`;
}

function makeView(i: number): ChannelIdentityView {
  const country = viewCountry(i);
  const name = viewName(i);
  return {
    channelId: `ch-${String(i).padStart(6, '0')}`,
    key: identityKey(country, normalizeChannelName(name)),
    name,
    country,
    language: 'es',
    variantKey: i % 11 === 0 ? `${country.toLowerCase()}-r${i % 5}` : null,
    tvgIds: [viewTvgId(i)],
    urlHosts: [`h${i % 50}.example`],
  };
}

function makeCandidate(i: number, totalViews: number): ReconcileCandidate {
  const mode = i % 5;
  const j = i % totalViews;
  const country = viewCountry(j);
  if (mode === 0) {
    return {
      name: viewName(j),
      country,
      url: `https://c${i}.example/stream.m3u8`,
      provider: null,
      groupTitle: null,
      language: 'es',
      attributes: { 'tvg-id': viewTvgId(j) },
    };
  }
  if (mode === 1) {
    return {
      name: viewName(j),
      country,
      url: `https://c${i}.example/stream.m3u8`,
      provider: null,
      groupTitle: null,
      language: 'es',
      attributes: { 'tvg-id': `Other${i}.${country.toLowerCase()}` },
    };
  }
  if (mode === 2) {
    return {
      name: `${viewName(j)} (Ciudad)`,
      country,
      url: `https://c${i}.example/stream.m3u8`,
      provider: null,
      groupTitle: null,
      language: 'es',
      attributes: {},
    };
  }
  if (mode === 3) {
    return {
      name: viewName(j),
      country: null,
      url: `https://c${i}.example/stream.m3u8`,
      provider: null,
      groupTitle: null,
      language: 'es',
      attributes: {},
    };
  }
  const cc = COUNTRIES[i % COUNTRIES.length] ?? 'ES';
  return {
    name: `Zorblax ${i}`,
    country: cc,
    url: `https://c${i}.example/stream.m3u8`,
    provider: null,
    groupTitle: null,
    language: 'es',
    attributes: { 'tvg-id': `Zorblax${i}.${cc.toLowerCase()}` },
  };
}

describe('reconcileIndexed — equivalence with the full scan', () => {
  it('returns exactly the same decision as reconcileNaive across a generated corpus', () => {
    const viewCount = 600;
    const candidateCount = 600;
    const views = Array.from({ length: viewCount }, (_, i) => makeView(i));
    const index = buildIdentityIndex(views);
    const candidates = Array.from({ length: candidateCount }, (_, i) => makeCandidate(i, viewCount));

    let same = 0;
    let review = 0;
    let different = 0;
    for (const candidate of candidates) {
      const indexed = reconcileIndexed(candidate, index);
      const naive = reconcileNaive(candidate, views);
      expect(indexed).toEqual(naive);
      if (indexed.kind === 'same') same += 1;
      else if (indexed.kind === 'review') review += 1;
      else different += 1;
    }
    expect(same).toBeGreaterThan(0);
    expect(review).toBeGreaterThan(0);
    expect(different).toBeGreaterThan(0);
  }, 60_000);

  it('the public reconcile wrapper agrees with both paths', () => {
    const views = Array.from({ length: 200 }, (_, i) => makeView(i));
    const index = buildIdentityIndex(views);
    for (let i = 0; i < 60; i += 1) {
      const candidate = makeCandidate(i, views.length);
      expect(reconcile(candidate, views)).toEqual(reconcileIndexed(candidate, index));
      expect(reconcile(candidate, views)).toEqual(reconcileNaive(candidate, views));
    }
  }, 30_000);
});

describe('reconcileIndexed — bucketed (sub-linear) lookup', () => {
  it('scores only a constant number of views for a distinctive null-country candidate', () => {
    const viewCount = 4000;
    const views = Array.from({ length: viewCount }, (_, i) => makeDistinctView(i));
    const index = buildIdentityIndex(views);
    const candidate: ReconcileCandidate = {
      name: 'UniqueNet0',
      country: null,
      url: 'https://c0.example/stream.m3u8',
      provider: null,
      groupTitle: null,
      language: 'es',
      attributes: { 'tvg-id': 'U0.es' },
    };
    const plausible = collectCandidateViews(candidate, index);
    expect(plausible.length).toBeGreaterThan(0);
    // O(1) in the catalogue size: key + one token + one tvg-id + one host.
    expect(plausible.length).toBeLessThanOrEqual(5);
  });

  it('scores only the same-country population for a known-country candidate', () => {
    const viewCount = 4000;
    const views = Array.from({ length: viewCount }, (_, i) => makeDistinctView(i));
    const index = buildIdentityIndex(views);
    const candidate: ReconcileCandidate = {
      name: 'UniqueNet0',
      country: 'ES',
      url: 'https://c0.example/stream.m3u8',
      provider: null,
      groupTitle: null,
      language: 'es',
      attributes: { 'tvg-id': 'U0.es' },
    };
    const plausible = collectCandidateViews(candidate, index);
    expect(plausible.length).toBeGreaterThan(0);
    // Bounded by the ES population (viewCount / MANY_COUNTRIES.length), not by viewCount.
    expect(plausible.length).toBeLessThan(viewCount / 10);
  });
});

const MANY_COUNTRIES = [
  'ES', 'US', 'GB', 'MX', 'FR', 'DE', 'IT', 'PT', 'AR', 'BR',
  'CA', 'AU', 'NZ', 'IE', 'NL', 'BE', 'CH', 'AT', 'SE', 'NO',
  'DK', 'FI', 'PL', 'CZ', 'GR', 'TR', 'RU', 'CN', 'JP', 'KR',
  'IN', 'CL', 'CO', 'PE', 'UY', 'VE', 'EC', 'BO', 'PY', 'GT',
  'HN', 'SV', 'NI', 'CR', 'PA', 'DO', 'CU', 'JM', 'TT', 'ZA',
  'EG', 'MA', 'NG', 'KE', 'IL', 'SA', 'AE', 'TH', 'VN', 'PH',
  'MY', 'SG', 'ID', 'RO', 'HU', 'UA', 'RS', 'HR', 'BG', 'SK',
  'SI', 'LT', 'LV', 'EE', 'IS', 'MT', 'CY', 'LU', 'AL', 'MK',
];

function makeDistinctView(i: number): ChannelIdentityView {
  const country = MANY_COUNTRIES[i % MANY_COUNTRIES.length] ?? 'ES';
  const name = `UniqueNet${i}`;
  return {
    channelId: `d-${String(i).padStart(6, '0')}`,
    key: identityKey(country, normalizeChannelName(name)),
    name,
    country,
    variantKey: null,
    tvgIds: [`U${i}.${country.toLowerCase()}`],
    urlHosts: [`d${i}.example`],
  };
}

describe('reconcileIndexed — tolerates the store projection', () => {
  it('does not throw when tvgIds/urlHosts are absent and language is present', () => {
    const storeLikeView: ChannelIdentityView = {
      channelId: 's1',
      key: 'es:la-1',
      name: 'La 1',
      country: 'ES',
      language: 'es',
      variantKey: null,
    };
    const candidate: ReconcileCandidate = {
      name: 'La 1',
      country: 'ES',
      url: 'https://a.example/stream.m3u8',
      provider: null,
      groupTitle: null,
      language: 'es',
      attributes: { 'tvg-id': 'La1.es' },
    };
    const decision = reconcileIndexed(candidate, buildIdentityIndex([storeLikeView]));
    expect(decision.kind).toBe('review');
    expect(decision.channelId).toBe('s1');
  });

  it('reaches `same` once the store projects tvgIds', () => {
    const projectedView: ChannelIdentityView = {
      channelId: 's1',
      key: 'es:la-1',
      name: 'La 1',
      country: 'ES',
      language: 'es',
      variantKey: null,
      tvgIds: ['La1.es'],
      urlHosts: [],
    };
    const decision = reconcileIndexed(
      {
        name: 'La 1',
        country: 'ES',
        url: 'https://a.example/stream.m3u8',
        provider: null,
        groupTitle: null,
        language: 'es',
        attributes: { 'tvg-id': 'La1.es@SD' },
      },
      buildIdentityIndex([projectedView]),
    );
    expect(decision.kind).toBe('same');
  });
});

describe('reconcileIndexed — before/after per-call cost', () => {
  it('indexed per-call cost is far below the naive full scan', () => {
    const viewCount = 4000;
    const views = Array.from({ length: viewCount }, (_, i) => makeDistinctView(i));
    const index = buildIdentityIndex(views);
    const candidate: ReconcileCandidate = {
      name: 'UniqueNet0',
      country: 'ES',
      url: 'https://c0.example/stream.m3u8',
      provider: null,
      groupTitle: null,
      language: 'es',
      attributes: { 'tvg-id': 'U0.es' },
    };

    // Warm both paths once, then measure.
    reconcileIndexed(candidate, index);
    reconcileNaive(candidate, views);

    const indexedCalls = 5000;
    let start = performance.now();
    for (let i = 0; i < indexedCalls; i += 1) {
      reconcileIndexed(candidate, index);
    }
    const perCallIndexed = (performance.now() - start) / indexedCalls;

    const naiveCalls = 20;
    start = performance.now();
    for (let i = 0; i < naiveCalls; i += 1) {
      reconcileNaive(candidate, views);
    }
    const perCallNaive = (performance.now() - start) / naiveCalls;

    // eslint-disable-next-line no-console
    console.log(
      `[reconcile perf] catalogue=${viewCount} perCallNaive=${perCallNaive.toFixed(3)}ms perCallIndexed=${perCallIndexed.toFixed(4)}ms`,
    );

    expect(perCallIndexed).toBeLessThan(perCallNaive);
  }, 60_000);
});
