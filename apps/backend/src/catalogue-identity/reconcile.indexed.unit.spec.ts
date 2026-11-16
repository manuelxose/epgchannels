/**
 * Indexed reconciliation: equivalence with the full scan, bucketed (sub-linear)
 * lookup with generic-token handling, tolerance of the store's identity
 * projection, and a documented before/after per-call cost measurement.
 */
import { describe, expect, it } from 'vitest';
import {
  buildIdentityIndex,
  collectCandidateViews,
  GENERIC_TOKEN_CUTOFF,
  reconcile,
  reconcileIndexed,
  reconcileNaive,
  REVIEW_THRESHOLD,
} from './reconcile.js';
import { identityKey, normalizeChannelName } from './normalize.js';
import type { ChannelIdentityView, ReconcileCandidate } from './types.js';

const COUNTRIES = ['ES', 'US', 'GB', 'MX', 'FR', 'DE', 'IT', 'PT', 'AR', 'BR'];
const PREFIXES = ['Pluto', 'Canal', 'Channel', 'La', 'Net'];

// Every non-first view contains the generic token `tv`, so the `tv` bucket is
// larger than GENERIC_TOKEN_CUTOFF and must NOT expand the candidate set.
function viewName(i: number): string {
  if (i === 0) return 'TV';
  const prefix = PREFIXES[(i - 1) % PREFIXES.length] ?? 'Pluto';
  const n = (i - 1) % 100;
  return `${prefix} ${n} TV`;
}

function viewCountry(i: number): string {
  return COUNTRIES[i % COUNTRIES.length] ?? 'ES';
}

function viewTvgId(i: number): string {
  const cc = viewCountry(i).toLowerCase();
  if (i === 0) return `TV.${cc}`;
  const prefix = PREFIXES[(i - 1) % PREFIXES.length] ?? 'Pluto';
  const n = (i - 1) % 100;
  return `${prefix}${n}.${cc}${i % 3 === 0 ? '@SD' : ''}`;
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
  const mode = i % 6;
  const j = i % totalViews;
  const country = viewCountry(j);
  if (mode === 0) {
    // Exact clone of a view → `same` (or the single-token `TV` candidate).
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
    // Same name + country, disagreeing tvg-id → `review`.
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
    // Regional variant (city qualifier) → `review`, never `same`.
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
    // Unknown country, shared base name (and the shared generic `tv` token).
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
  if (mode === 4) {
    // Same country, completely different name → `different` (same-country residual).
    return {
      name: `Zorblax ${10000 + i}`,
      country,
      url: `https://c${i}.example/stream.m3u8`,
      provider: null,
      groupTitle: null,
      language: 'es',
      attributes: {},
    };
  }
  // Country not in the catalogue + unrelated name → `different`, score 0.
  return {
    name: `Qwerty ${20000 + i}`,
    country: 'XK',
    url: `https://c${i}.example/stream.m3u8`,
    provider: null,
    groupTitle: null,
    language: 'es',
    attributes: {},
  };
}

describe('reconcileIndexed — equivalence with the full scan', () => {
  it('preserves every same/review verdict and the different verdict across a corpus with a hot `tv` token', () => {
    const viewCount = 600;
    const candidateCount = 600;
    const views = Array.from({ length: viewCount }, (_, i) => makeView(i));
    const index = buildIdentityIndex(views);

    // The corpus really does have a generic `tv` bucket.
    expect(index.byToken.get('tv')?.length ?? 0).toBeGreaterThan(GENERIC_TOKEN_CUTOFF);

    const candidates = Array.from({ length: candidateCount }, (_, i) => makeCandidate(i, viewCount));

    let same = 0;
    let review = 0;
    let different = 0;
    for (const candidate of candidates) {
      const indexed = reconcileIndexed(candidate, index);
      const naive = reconcileNaive(candidate, views);
      if (naive.kind === 'different') {
        // Kind and channelId are invariant; the diagnostic score below the
        // threshold may differ because generic-only views are not scanned.
        expect(indexed.kind).toBe('different');
        expect(indexed.channelId).toBeNull();
        expect(indexed.score).toBeLessThan(REVIEW_THRESHOLD);
        different += 1;
      } else {
        // same / review must be byte-identical (score, signals, reason).
        expect(indexed).toEqual(naive);
        if (indexed.kind === 'same') same += 1;
        else review += 1;
      }
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
    }
  }, 30_000);

  it('a single-token generic candidate still matches the full scan exactly', () => {
    const views = Array.from({ length: 300 }, (_, i) => makeView(i));
    const index = buildIdentityIndex(views);
    // Candidate name "TV" has no discriminating token, so it takes the full-bucket
    // fallback and must agree with the naive scan byte-for-byte.
    const candidate: ReconcileCandidate = {
      name: 'TV',
      country: 'ES',
      url: 'https://c0.example/stream.m3u8',
      provider: null,
      groupTitle: null,
      language: 'es',
      attributes: { 'tvg-id': 'TV.es' },
    };
    expect(reconcileIndexed(candidate, index)).toEqual(reconcileNaive(candidate, views));
  }, 30_000);
});

describe('reconcileIndexed — generic token does not expand the candidate set', () => {
  it('collects a small fraction of the catalogue for a discriminating candidate', () => {
    const viewCount = 800;
    const views = Array.from({ length: viewCount }, (_, i) => makeView(i));
    const index = buildIdentityIndex(views);

    const candidate: ReconcileCandidate = {
      name: 'Pluto 0 TV',
      country: 'ES',
      url: 'https://c0.example/stream.m3u8',
      provider: null,
      groupTitle: null,
      language: 'es',
      attributes: { 'tvg-id': 'Pluto0.es' },
    };
    const plausible = collectCandidateViews(candidate, index);
    // The `tv` bucket has ~viewCount entries; a discriminating candidate must not
    // pull it in full.
    expect(plausible.length).toBeGreaterThan(0);
    expect(plausible.length).toBeLessThan(viewCount / 3);
  });
});

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
    const viewCount = 14000;
    const views = Array.from({ length: viewCount }, (_, i) => makeDistinctView(i));
    const index = buildIdentityIndex(views);

    const candidates: ReconcileCandidate[] = [];
    for (let i = 0; i < 500; i += 1) {
      const kind = i % 3;
      const cc = MANY_COUNTRIES[i % MANY_COUNTRIES.length] ?? 'ES';
      if (kind === 0) {
        candidates.push({
          name: `UniqueNet${i}`,
          country: cc,
          url: `https://c${i}.example/stream.m3u8`,
          provider: null,
          groupTitle: null,
          language: 'es',
          attributes: { 'tvg-id': `U${i}.${cc.toLowerCase()}` },
        });
      } else if (kind === 1) {
        candidates.push({
          name: `UniqueNet${i} Extra`,
          country: cc,
          url: `https://c${i}.example/stream.m3u8`,
          provider: null,
          groupTitle: null,
          language: 'es',
          attributes: {},
        });
      } else {
        candidates.push({
          name: `UniqueNet${i}`,
          country: null,
          url: `https://c${i}.example/stream.m3u8`,
          provider: null,
          groupTitle: null,
          language: 'es',
          attributes: {},
        });
      }
    }

    reconcileIndexed(candidates[0] as ReconcileCandidate, index);
    reconcileNaive(candidates[0] as ReconcileCandidate, views);

    let start = performance.now();
    for (const candidate of candidates) {
      reconcileIndexed(candidate, index);
    }
    const perCallIndexed = (performance.now() - start) / candidates.length;

    const naiveCalls = 5;
    start = performance.now();
    for (let i = 0; i < naiveCalls; i += 1) {
      reconcileNaive(candidates[i] as ReconcileCandidate, views);
    }
    const perCallNaive = (performance.now() - start) / naiveCalls;

    // eslint-disable-next-line no-console
    console.log(
      `[reconcile perf] catalogue=${viewCount} perCallNaive=${perCallNaive.toFixed(3)}ms perCallIndexed=${perCallIndexed.toFixed(4)}ms (500 mixed candidates)`,
    );

    expect(perCallIndexed).toBeLessThan(perCallNaive);
  }, 60_000);
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
