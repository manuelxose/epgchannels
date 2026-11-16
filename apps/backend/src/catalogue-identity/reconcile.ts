/**
 * Deterministic reconciliation of a source candidate against known channels.
 *
 * Pure: no randomness, no timestamps, no `Date.now`, no I/O. The same inputs
 * always produce the same `kind`, `score`, `signals` and `channelId`.
 *
 * Safety invariant: two different regional or local stations are NEVER
 * silently merged. `kind === 'same'` requires an exact normalized-name match
 * AND country AND `tvg-id` corroboration, and a differing regional/local
 * qualifier forces `review` even when everything else agrees.
 *
 * Performance: the lookup index is bucketed only by discriminating signals —
 * exact identity key, every normalized-name token, tvg-id base and URL host.
 * Country is NOT used to expand the candidate set (that would be a full scan
 * of the same-country population); it acts as a filter/tie-break inside the
 * scoring formula, where it already contributes 0.25.
 */
import {
  foldText,
  identityKey,
  normalizeChannelName,
  normalizeCountry,
  stripProviderHint,
} from './normalize.js';
import type {
  ChannelIdentityView,
  MatchDecision,
  MatchSignals,
  ReconcileCandidate,
} from './types.js';

/** Below: `different`. Between: `review`. Above: candidate for `same`. */
export const REVIEW_THRESHOLD = 0.55;
export const SAME_THRESHOLD = 0.85;

/**
 * A name token whose inverted bucket exceeds this size is a generic stop-word
 * (`tv`, 3,792 entries in the real corpus): its full bucket is NOT unioned into
 * the candidate set.
 *
 * Why skipping the multi-token part of a generic bucket is safe: a multi-token
 * view sharing only a generic name token has name similarity <= Dice 0.5, so its
 * score is at most 0.45*0.5 + 0.25 = 0.475 (name + country alone), below the
 * 0.55 review threshold. It can only reach `review` through a signal that is
 * collected independently of the token cutoff: a matching URL host
 * (0.45*0.5 + 0.25 + 0.10 = 0.575, via the host index), a matching tvg-id base
 * (via the tvg index), an exact identity key (via the key index), or
 * single-token whole-word containment (via `bySingleToken`). Only the
 * single-token views of a generic token are collected; a candidate whose tokens
 * are all generic falls back to the full buckets.
 */
export const GENERIC_TOKEN_CUTOFF = 512;

// Weights sum to 1. `name` and `country` are the primary identity signals;
// `tvg-id` is a strong corroborator; `urlHost` only breaks ties toward review.
const W_NAME = 0.45;
const W_COUNTRY = 0.25;
const W_TVG_ID = 0.2;
const W_URL_HOST = 0.1;

/** Parsed `tvg-id` identity components (all folded, country upper-cased). */
export interface ParsedTvgId {
  base: string | null;
  country: string | null;
  quality: string | null;
}

/**
 * Parses an iptv-org / Free-TV style `tvg-id` (`Name.cc@SD`). The `@Quality`
 * suffix and a trailing provider hint are decoration; the last dot-separated
 * two-letter segment is the country. Returns `null` fields for what is absent —
 * it never invents a component.
 */
export function parseTvgId(raw: string | null | undefined): ParsedTvgId {
  if (typeof raw !== 'string') {
    return { base: null, country: null, quality: null };
  }
  let s = raw.trim();
  if (s === '') {
    return { base: null, country: null, quality: null };
  }
  let quality: string | null = null;
  const q = /@(2160p|1080p|720p|576p|480p|uhd|fhd|hd|sd|4k|8k)\s*$/i.exec(s);
  if (q !== null) {
    quality = (q[1] ?? '').toLowerCase();
    s = s.slice(0, q.index).trim();
  }
  s = stripProviderHint(s);
  const parts = s.split('.').map((p) => p.trim()).filter((p) => p !== '');
  let country: string | null = null;
  let baseParts = parts;
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    const cc = normalizeCountry(last);
    if (cc !== null && /^[a-z]{2}$/i.test(last ?? '')) {
      country = cc;
      baseParts = parts.slice(0, -1);
    }
  }
  const baseRaw = baseParts.join('.');
  const base = baseRaw === '' ? null : foldText(baseRaw);
  return { base, country, quality };
}

/** Lowercase hostname of a URL, default port dropped; `null` when unparseable. */
function urlHostOf(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url === '') {
    return null;
  }
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** A trailing parenthesized or bracketed city/region qualifier, or `null`. */
function regionQualifier(rawName: string): string | null {
  const paren = /\(\s*([^()]+?)\s*\)\s*$/.exec(rawName);
  const bracket = /\[\s*([^[\]]+?)\s*\]\s*$/.exec(rawName);
  const match = paren ?? bracket;
  if (match === null) {
    return null;
  }
  const inner = (match[1] ?? '').trim();
  if (inner === '') {
    return null;
  }
  if (/^(?:2160p|1080p|720p|576p|480p|360p|4k|8k|uhd|fhd|hd|sd|hevc|h\.26[45])$/i.test(inner)) {
    return null;
  }
  if (/^(?:geo-blocked|geo blocked|geo|not 24\/7|24\/7|not 24h|24h)$/i.test(inner)) {
    return null;
  }
  return foldText(inner);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `a` appears in `b` at a whole-word boundary. */
function containedIn(a: string, b: string): boolean {
  if (a === '') {
    return false;
  }
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(a)}([^a-z0-9]|$)`);
  return re.test(b);
}

function tokens(folded: string): string[] {
  return folded.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/**
 * Name similarity in `0..1`. Only an exact match returns `1`; a token
 * containment returns `0.8`; anything else is a bounded Dice coefficient
 * (never above `0.7`), so a non-exact name can never reach `same`.
 */
function nameSimilarity(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  if (a === '' || b === '') {
    return 0;
  }
  if (containedIn(a, b) || containedIn(b, a)) {
    return 0.8;
  }
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) {
    return 0;
  }
  const setB = new Set(tb);
  let intersection = 0;
  for (const t of ta) {
    if (setB.has(t)) {
      intersection += 1;
    }
  }
  const dice = (2 * intersection) / (ta.length + tb.length);
  return Math.min(dice, 0.7);
}

/** A channel view with every per-call normalisation precomputed once. */
interface PreparedChannel {
  view: ChannelIdentityView;
  normalizedName: string;
  country: string | null;
  variantRegion: string | null;
  tvg: ReadonlyArray<{ base: string; country: string | null }>;
  hosts: string[];
}

/**
 * Immutable lookup index over known channels, bucketed only by discriminating
 * signals: exact identity key, every normalized-name token, tvg-id base and
 * URL host. Country is stored as per-country counts (used to decide whether a
 * same-country-only channel exists), never as a whole population bucket.
 */
export interface IdentityIndex {
  readonly byKey: ReadonlyMap<string, readonly PreparedChannel[]>;
  readonly byToken: ReadonlyMap<string, readonly PreparedChannel[]>;
  /** Single-token views per token (the only generic-only views kept for review). */
  readonly bySingleToken: ReadonlyMap<string, readonly PreparedChannel[]>;
  readonly byTvgBase: ReadonlyMap<string, readonly PreparedChannel[]>;
  readonly byHost: ReadonlyMap<string, readonly PreparedChannel[]>;
  readonly countryCounts: ReadonlyMap<string, number>;
  readonly nullCount: number;
  readonly total: number;
}

function prepareChannel(view: ChannelIdentityView): PreparedChannel {
  const normalizedName = normalizeChannelName(view.name);
  const tvg: Array<{ base: string; country: string | null }> = [];
  for (const raw of view.tvgIds ?? []) {
    const parsed = parseTvgId(raw);
    if (parsed.base !== null) {
      tvg.push({ base: parsed.base, country: parsed.country });
    }
  }
  const hosts: string[] = [];
  for (const host of view.urlHosts ?? []) {
    if (host !== '') {
      hosts.push(host);
    }
  }
  return {
    view,
    normalizedName,
    country: normalizeCountry(view.country),
    variantRegion: view.variantKey ? foldText(view.variantKey) : null,
    tvg,
    hosts,
  };
}

function addBucket<K>(
  map: Map<K, PreparedChannel[]>,
  key: K,
  value: PreparedChannel,
): void {
  const bucket = map.get(key);
  if (bucket === undefined) {
    map.set(key, [value]);
  } else {
    bucket.push(value);
  }
}

/**
 * Builds the reconciliation index over the known channel identities.
 *
 * Deterministic and independent of input array order (channels are deduplicated
 * by `channelId`; bucket contents are only ever read as unordered sets).
 */
export function buildIdentityIndex(views: readonly ChannelIdentityView[]): IdentityIndex {
  const byKey = new Map<string, PreparedChannel[]>();
  const byToken = new Map<string, PreparedChannel[]>();
  const bySingleToken = new Map<string, PreparedChannel[]>();
  const byTvgBase = new Map<string, PreparedChannel[]>();
  const byHost = new Map<string, PreparedChannel[]>();
  const countryCounts = new Map<string, number>();
  let nullCount = 0;
  const seen = new Set<string>();

  for (const view of views) {
    if (seen.has(view.channelId)) {
      continue;
    }
    seen.add(view.channelId);
    const prepared = prepareChannel(view);
    addBucket(byKey, view.key, prepared);
    const nameTokens = tokens(prepared.normalizedName);
    for (const token of nameTokens) {
      addBucket(byToken, token, prepared);
    }
    if (nameTokens.length === 1) {
      const single = nameTokens[0];
      if (single !== undefined) {
        addBucket(bySingleToken, single, prepared);
      }
    }
    for (const t of prepared.tvg) {
      addBucket(byTvgBase, t.base, prepared);
    }
    for (const host of prepared.hosts) {
      addBucket(byHost, host, prepared);
    }
    if (prepared.country === null) {
      nullCount += 1;
    } else {
      countryCounts.set(prepared.country, (countryCounts.get(prepared.country) ?? 0) + 1);
    }
  }

  return {
    byKey,
    byToken,
    bySingleToken,
    byTvgBase,
    byHost,
    countryCounts,
    nullCount,
    total: seen.size,
  };
}

interface CandidateFacts {
  candName: string;
  candKey: string;
  candTokens: string[];
  candCountry: string | null;
  candTvgBase: string | null;
  candTvgCountry: string | null;
  candHost: string | null;
  candRegion: string | null;
}

function computeCandidateFacts(candidate: ReconcileCandidate): CandidateFacts {
  const candName = normalizeChannelName(candidate.name);
  const tvgRaw = candidate.attributes['tvg-id'] ?? candidate.attributes['tvg_id'] ?? null;
  const candCountry = normalizeCountry(
    candidate.country ?? candidate.attributes['tvg-country'] ?? null,
  );
  const candTvg = parseTvgId(tvgRaw);
  return {
    candName,
    candKey: identityKey(candCountry, candName),
    candTokens: tokens(candName),
    candCountry,
    candTvgBase: candTvg.base,
    candTvgCountry: candTvg.country,
    candHost: urlHostOf(candidate.url),
    candRegion: regionQualifier(candidate.name),
  };
}

/**
 * Collects the plausible channels for a candidate using ONLY discriminating
 * signals: the exact-key bucket, the tvg-id base bucket, the host bucket, and
 * name-token buckets that are small enough to be selective.
 *
 * A generic token (bucket size > `GENERIC_TOKEN_CUTOFF`) does not expand the
 * candidate set: only its single-token views are collected. A multi-token view
 * sharing only a generic token scores at most 0.475 on name + country, so it
 * cannot reach `review` on the name signal alone; any view that DOES reach
 * `review` does so via a matching host, tvg-id base, exact key or single-token
 * containment, all of which are collected here. A candidate whose tokens are
 * ALL generic falls back to the full token buckets.
 */
function collectPrepared(facts: CandidateFacts, index: IdentityIndex): Map<string, PreparedChannel> {
  const collected = new Map<string, PreparedChannel>();
  const push = (bucket: readonly PreparedChannel[] | undefined): void => {
    if (bucket === undefined) {
      return;
    }
    for (const prepared of bucket) {
      if (!collected.has(prepared.view.channelId)) {
        collected.set(prepared.view.channelId, prepared);
      }
    }
  };

  push(index.byKey.get(facts.candKey));
  if (facts.candTvgBase !== null) {
    push(index.byTvgBase.get(facts.candTvgBase));
  }
  if (facts.candHost !== null) {
    push(index.byHost.get(facts.candHost));
  }

  const generic: string[] = [];
  const discriminating: string[] = [];
  for (const token of facts.candTokens) {
    const size = index.byToken.get(token)?.length ?? 0;
    if (size > GENERIC_TOKEN_CUTOFF) {
      generic.push(token);
    } else {
      discriminating.push(token);
    }
  }

  if (discriminating.length > 0) {
    for (const token of discriminating) {
      push(index.byToken.get(token));
    }
    for (const token of generic) {
      push(index.bySingleToken.get(token));
    }
  } else {
    // No discriminating token: a short/all-generic candidate must be able to
    // exact/containment-match, so scan its full token buckets (rare path).
    for (const token of facts.candTokens) {
      push(index.byToken.get(token));
    }
  }
  return collected;
}

/**
 * Returns the plausible channels a candidate will be scored against. Exposed
 * for diagnostics and to prove that the lookup is bucketed (sub-linear in the
 * global catalogue size) rather than a full scan.
 */
export function collectCandidateViews(
  candidate: ReconcileCandidate,
  index: IdentityIndex,
): ChannelIdentityView[] {
  const collected = collectPrepared(computeCandidateFacts(candidate), index);
  return [...collected.values()].map((prepared) => prepared.view);
}

interface ScoredMatch {
  prepared: PreparedChannel;
  signals: MatchSignals;
  score: number;
}

function scorePrepared(facts: CandidateFacts, prepared: PreparedChannel): ScoredMatch {
  const name = nameSimilarity(facts.candName, prepared.normalizedName);

  let country: number;
  if (facts.candCountry !== null && prepared.country !== null) {
    country = facts.candCountry === prepared.country ? 1 : 0;
  } else if (facts.candCountry === null && prepared.country === null) {
    country = 0.5;
  } else {
    country = 0.5;
  }

  let tvgId = 0;
  if (facts.candTvgBase !== null) {
    for (const t of prepared.tvg) {
      if (t.base === facts.candTvgBase) {
        if (t.country === null || facts.candTvgCountry === null || t.country === facts.candTvgCountry) {
          tvgId = 1;
          break;
        }
      }
    }
  }

  let urlHost = 0;
  if (facts.candHost !== null) {
    for (const host of prepared.hosts) {
      if (host === facts.candHost) {
        urlHost = 1;
        break;
      }
    }
  }

  const score =
    W_NAME * name + W_COUNTRY * country + W_TVG_ID * tvgId + W_URL_HOST * urlHost;
  return { prepared, signals: { name, country, tvgId, urlHost }, score };
}

function describeReview(name: number, country: number, tvgId: number): string {
  const parts: string[] = [];
  if (name !== 1) {
    parts.push('name is not an exact match');
  }
  if (name === 1 && country !== 1) {
    parts.push('country is not corroborated');
  }
  if (name === 1 && country === 1 && tvgId !== 1) {
    parts.push('tvg-id does not corroborate');
  }
  if (parts.length === 0) {
    parts.push('insufficient corroboration');
  }
  return `manual review: ${parts.join('; ')}`;
}

/**
 * Renders the final decision. `prepared` is `null` only for a "residual" winner
 * (a same-country-only or neutral-country-only channel with no name/tvg/host
 * signal), whose score is always below the review threshold, so it can only
 * produce `different`.
 */
function decide(
  facts: CandidateFacts,
  score: number,
  signals: MatchSignals,
  prepared: PreparedChannel | null,
): MatchDecision {
  if (score < REVIEW_THRESHOLD) {
    return {
      kind: 'different',
      score,
      signals,
      channelId: null,
      reason: `no sufficient match (score ${score.toFixed(3)} below ${REVIEW_THRESHOLD})`,
    };
  }

  const channel = prepared as PreparedChannel;
  const regionConflict = (facts.candRegion ?? null) !== (channel.variantRegion ?? null);
  if (regionConflict) {
    const reason =
      facts.candRegion !== null && channel.variantRegion !== null
        ? `regional/local qualifier differs (${facts.candRegion} vs ${channel.variantRegion})`
        : `regional/local variant detected (${facts.candRegion ?? channel.variantRegion ?? 'unknown'})`;
    return { kind: 'review', score, signals, channelId: channel.view.channelId, reason };
  }

  if (
    signals.name === 1 &&
    signals.country === 1 &&
    signals.tvgId === 1 &&
    score >= SAME_THRESHOLD
  ) {
    return {
      kind: 'same',
      score,
      signals,
      channelId: channel.view.channelId,
      reason: 'name, country and tvg-id agree',
    };
  }

  return {
    kind: 'review',
    score,
    signals,
    channelId: channel.view.channelId,
    reason: describeReview(signals.name, signals.country, signals.tvgId),
  };
}

/** The best score a channel with no name/tvg/host signal could contribute. */
function residualFor(
  facts: CandidateFacts,
  index: IdentityIndex,
  collectedCountryCount: number,
  collectedNullCount: number,
  collectedTotal: number,
): { score: number; country: number } | null {
  if (facts.candCountry !== null) {
    const sameCountry = index.countryCounts.get(facts.candCountry) ?? 0;
    if (sameCountry > collectedCountryCount) {
      return { score: 0.25, country: 1 };
    }
    if (index.nullCount > collectedNullCount) {
      return { score: 0.125, country: 0.5 };
    }
    return null;
  }
  // Unknown candidate country → every channel is neutral (country 0.5).
  if (index.total > collectedTotal) {
    return { score: 0.125, country: 0.5 };
  }
  return null;
}

/**
 * Reconciles one candidate against a pre-built `IdentityIndex`.
 *
 * Deterministic and independent of the index build order; ties are broken by
 * the lowest `channelId`, exactly as the naive scan.
 */
export function reconcileIndexed(
  candidate: ReconcileCandidate,
  index: IdentityIndex,
): MatchDecision {
  const facts = computeCandidateFacts(candidate);

  if (index.total === 0) {
    return {
      kind: 'different',
      score: 0,
      signals: { name: 0, country: 0, tvgId: 0, urlHost: 0 },
      channelId: null,
      reason: 'no existing canonical channels',
    };
  }

  const collected = collectPrepared(facts, index);

  let collectedCountryCount = 0;
  let collectedNullCount = 0;
  let best: ScoredMatch | null = null;
  for (const prepared of collected.values()) {
    if (facts.candCountry !== null && prepared.country === facts.candCountry) {
      collectedCountryCount += 1;
    }
    if (prepared.country === null) {
      collectedNullCount += 1;
    }
    const scored = scorePrepared(facts, prepared);
    if (
      best === null ||
      scored.score > best.score ||
      (scored.score === best.score && prepared.view.channelId < best.prepared.view.channelId)
    ) {
      best = scored;
    }
  }

  const residual = residualFor(
    facts,
    index,
    collectedCountryCount,
    collectedNullCount,
    collected.size,
  );

  let score: number;
  let signals: MatchSignals;
  let prepared: PreparedChannel | null;
  if (residual !== null && (best === null || residual.score > best.score)) {
    score = residual.score;
    signals = { name: 0, country: residual.country, tvgId: 0, urlHost: 0 };
    prepared = null;
  } else if (best !== null) {
    score = best.score;
    signals = best.signals;
    prepared = best.prepared;
  } else {
    score = 0;
    signals = { name: 0, country: 0, tvgId: 0, urlHost: 0 };
    prepared = null;
  }

  return decide(facts, score, signals, prepared);
}

/**
 * Reference full-scan implementation (`O(n)` per call). It is kept as the
 * correctness oracle for `reconcileIndexed` and for one-off calls; the
 * ingestion hot path should use `buildIdentityIndex` + `reconcileIndexed`.
 */
export function reconcileNaive(
  candidate: ReconcileCandidate,
  existing: readonly ChannelIdentityView[],
): MatchDecision {
  const facts = computeCandidateFacts(candidate);

  if (existing.length === 0) {
    return {
      kind: 'different',
      score: 0,
      signals: { name: 0, country: 0, tvgId: 0, urlHost: 0 },
      channelId: null,
      reason: 'no existing canonical channels',
    };
  }

  const sorted = [...existing].sort((x, y) => {
    if (x.channelId < y.channelId) return -1;
    if (x.channelId > y.channelId) return 1;
    return 0;
  });

  let best: ScoredMatch | null = null;
  for (const view of sorted) {
    const scored = scorePrepared(facts, prepareChannel(view));
    if (best === null || scored.score > best.score) {
      best = scored;
    }
  }

  const winner = best as ScoredMatch;
  return decide(facts, winner.score, winner.signals, winner.prepared);
}

/**
 * Reconciles one candidate against a fresh list of known channels.
 *
 * This builds an index and delegates to `reconcileIndexed`; for many candidates
 * against the same catalogue, build the index once and call `reconcileIndexed`
 * directly.
 */
export function reconcile(
  candidate: ReconcileCandidate,
  existing: ChannelIdentityView[],
): MatchDecision {
  return reconcileIndexed(candidate, buildIdentityIndex(existing));
}
