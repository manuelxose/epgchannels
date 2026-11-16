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
 */
import {
  foldText,
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

interface ScoredMatch {
  view: ChannelIdentityView;
  signals: MatchSignals;
  score: number;
}

function scoreAgainst(
  candidate: ReconcileCandidate,
  candName: string,
  candCountry: string | null,
  candTvg: ParsedTvgId,
  candHost: string | null,
  view: ChannelIdentityView,
): ScoredMatch {
  const viewName = normalizeChannelName(view.name);
  const name = nameSimilarity(candName, viewName);

  const viewCountry = normalizeCountry(view.country);
  let country: number;
  if (candCountry !== null && viewCountry !== null) {
    country = candCountry === viewCountry ? 1 : 0;
  } else if (candCountry === null && viewCountry === null) {
    country = 0.5;
  } else {
    country = 0.5;
  }

  let tvgId = 0;
  if (candTvg.base !== null) {
    for (const raw of view.tvgIds) {
      const vt = parseTvgId(raw);
      if (vt.base !== null && vt.base === candTvg.base) {
        if (vt.country === null || candTvg.country === null || vt.country === candTvg.country) {
          tvgId = 1;
          break;
        }
      }
    }
  }

  let urlHost = 0;
  if (candHost !== null) {
    for (const host of view.urlHosts) {
      if (host === candHost) {
        urlHost = 1;
        break;
      }
    }
  }

  const score =
    W_NAME * name + W_COUNTRY * country + W_TVG_ID * tvgId + W_URL_HOST * urlHost;
  return { view, signals: { name, country, tvgId, urlHost }, score };
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
 * Reconciles one candidate against the known channel identities.
 *
 * Returns `same` only when the normalized name matches exactly AND both the
 * country and the `tvg-id` corroborate — and never when a regional/local
 * qualifier differs. Anything uncertain returns `review`; weak matches return
 * `different` with `channelId: null`.
 */
export function reconcile(
  candidate: ReconcileCandidate,
  existing: ChannelIdentityView[],
): MatchDecision {
  const candName = normalizeChannelName(candidate.name);
  const tvgRaw = candidate.attributes['tvg-id'] ?? candidate.attributes['tvg_id'] ?? null;
  const candCountry = normalizeCountry(
    candidate.country ?? candidate.attributes['tvg-country'] ?? null,
  );
  const candTvg = parseTvgId(tvgRaw);
  const candHost = urlHostOf(candidate.url);
  const candRegion = regionQualifier(candidate.name);

  if (existing.length === 0) {
    return {
      kind: 'different',
      score: 0,
      signals: { name: 0, country: 0, tvgId: 0, urlHost: 0 },
      channelId: null,
      reason: 'no existing canonical channels',
    };
  }

  // Sort by channelId so the winner is deterministic and independent of input
  // array order (ties keep the lowest channelId).
  const sorted = [...existing].sort((x, y) => {
    if (x.channelId < y.channelId) return -1;
    if (x.channelId > y.channelId) return 1;
    return 0;
  });

  let best: ScoredMatch | null = null;
  for (const view of sorted) {
    const scored = scoreAgainst(candidate, candName, candCountry, candTvg, candHost, view);
    if (best === null || scored.score > best.score) {
      best = scored;
    }
  }

  const winner = best as ScoredMatch;
  const { name, country, tvgId, urlHost } = winner.signals;
  const signals: MatchSignals = { name, country, tvgId, urlHost };

  if (winner.score < REVIEW_THRESHOLD) {
    return {
      kind: 'different',
      score: winner.score,
      signals,
      channelId: null,
      reason: `no sufficient match (score ${winner.score.toFixed(3)} below ${REVIEW_THRESHOLD})`,
    };
  }

  const existingRegion = winner.view.variantKey
    ? foldText(winner.view.variantKey)
    : null;
  const regionConflict = (candRegion ?? null) !== (existingRegion ?? null);

  if (regionConflict) {
    const reason =
      candRegion !== null && existingRegion !== null
        ? `regional/local qualifier differs (${candRegion} vs ${existingRegion})`
        : `regional/local variant detected (${candRegion ?? existingRegion ?? 'unknown'})`;
    return { kind: 'review', score: winner.score, signals, channelId: winner.view.channelId, reason };
  }

  if (name === 1 && country === 1 && tvgId === 1 && winner.score >= SAME_THRESHOLD) {
    return {
      kind: 'same',
      score: winner.score,
      signals,
      channelId: winner.view.channelId,
      reason: 'name, country and tvg-id agree',
    };
  }

  return {
    kind: 'review',
    score: winner.score,
    signals,
    channelId: winner.view.channelId,
    reason: describeReview(name, country, tvgId),
  };
}
