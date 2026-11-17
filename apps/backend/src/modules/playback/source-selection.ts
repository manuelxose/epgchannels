/**
 * Playback-source selection over four separate, ordered axes.
 *
 * | # | axis          | evidence                                        | may it disable? |
 * |---|---------------|-------------------------------------------------|-----------------|
 * | 1 | authorization | the 02C record + publication policy (fail-closed)| yes, absolutely |
 * | 2 | compatibility | a MEASURED reproduction verdict only             | if incompatible |
 * | 3 | health        | the recorded check, else `technicalStatus`       | only when it observed this type |
 * | 4 | quality       | priority, geo reach, age                         | no — tie-break only |
 *
 * Three properties this module is built to hold, each of which was a real defect
 * somewhere in this platform:
 *
 * - **Health never outranks authorization.** Authorization is evaluated first and
 *   a source it refuses never becomes a candidate, so it can never become a
 *   failover target. Failover exists only between candidates that passed every
 *   axis: "separately authorized" is a precondition, not a preference.
 * - **`not-verified` is not `failing`.** No source row on the platform carries an
 *   `ok`, so an axis that required one would attempt nothing. Health is resolved
 *   from the recorded check first (`verification/source-health.ts`) and an absent
 *   verdict is its own answer.
 * - **Compatibility is only ever measured.** It is derived from the reproduction
 *   probe (`verification/compatibility.ts`); no failure code, message or
 *   heuristic can produce `incompatible`.
 *
 * Pure: no I/O, no clock beyond the injected `now`, no database.
 */
import type { PlaybackCompatibility, PlaybackHealth, PlaybackOption, PlaybackType } from '@tdt/contracts';
import type { PlaybackSourceDoc } from '../../infrastructure/schema.js';
import { compareSources, engineFor, isSourcePublic } from './publication-policy.js';
import { decideSourceEligibility } from '../providers/source-eligibility.js';
import type { AuthorizationRecord } from '../providers/authorization.js';
import {
  healthGovernsType,
  NOT_VERIFIED,
  resolveSourceHealth,
  type RecordedCheck,
  type SourceHealthVerdict,
  type StoredTechnicalStatus,
} from '../../verification/source-health.js';
import { resolveCompatibility, type ReproductionResult } from '../../verification/compatibility.js';

/** Authorization decisions, keyed by source id. An absent key is a denial. */
export type SourceAuthorizationMap = ReadonlyMap<string, AuthorizationRecord>;

/** Engine label recorded with a compatibility verdict when the caller names none. */
export const DEFAULT_REPRODUCTION_ENGINE = 'unknown-engine';
/**
 * The evidence every candidate is decided on. Keyed by source id.
 *
 * Absence of an entry is meaningful and safe: no recorded check ⇒ health is
 * resolved from the source row, and no probe ⇒ compatibility is `unknown`.
 */
export interface SourceEvidence {
  /** The recorded validation result for this source, if one exists. */
  readonly checks: ReadonlyMap<string, RecordedCheck>;
  /** The reproduction verdict the engine kept, if one was run. */
  readonly reproductions: ReadonlyMap<string, ReproductionResult>;
  /** Label of the browser/engine the reproductions ran on. */
  readonly reproductionEngine: string;
}

export const NO_EVIDENCE: SourceEvidence = Object.freeze({
  checks: new Map<string, RecordedCheck>(),
  reproductions: new Map<string, ReproductionResult>(),
  reproductionEngine: DEFAULT_REPRODUCTION_ENGINE,
});

/** The axes a candidate was judged on, kept for the descriptor and for tests. */
export interface CandidateAxes {
  readonly authorized: true;
  readonly compatibility: PlaybackCompatibility;
  readonly health: SourceHealthVerdict;
}

export type CandidateRefusal =
  | { readonly axis: 'authorization'; readonly code: string }
  | { readonly axis: 'compatibility'; readonly code: string }
  | { readonly axis: 'health'; readonly code: string }
  | { readonly axis: 'address'; readonly code: string };

export type CandidateDecision =
  | { readonly source: PlaybackSourceDoc; readonly selectable: true; readonly axes: CandidateAxes }
  | { readonly source: PlaybackSourceDoc; readonly selectable: false; readonly refusal: CandidateRefusal };

export interface SelectionInput {
  readonly channel: { readonly editorialStatus: string };
  readonly sources: readonly PlaybackSourceDoc[];
  readonly authorizations: SourceAuthorizationMap | undefined;
  readonly evidence?: SourceEvidence;
  readonly now?: Date;
}

export interface PlaybackSelection {
  /** Selectable candidates, best first. Failover may only use these. */
  readonly candidates: readonly { readonly source: PlaybackSourceDoc; readonly axes: CandidateAxes }[];
  /**
   * Authorized in-app candidates that exist but cannot be selected now, with the
   * axis that refused them. Never contains an unauthorized source: a denial is
   * not a fallback. The type narrows out `authorization` so a caller cannot
   * accidentally publish a denial as a recoverable reason.
   */
  readonly refused: readonly {
    readonly source: PlaybackSourceDoc;
    readonly refusal: Extract<CandidateRefusal, { axis: 'compatibility' | 'health' | 'address' }>;
  }[];
}

/**
 * Judges one source across the axes, in order, and stops at the first refusal.
 *
 * Authorization is first for a reason that is not stylistic: if health were
 * consulted first, a failing source would be reported as "unhealthy" even when it
 * also lacks a right, and the operator would be told to retry a stream we may not
 * play.
 */
export function decideCandidate(source: PlaybackSourceDoc, input: SelectionInput): CandidateDecision {
  const now = input.now ?? new Date();
  const evidence = input.evidence ?? NO_EVIDENCE;
  const type = source.type as PlaybackType;

  // ── Axis 1: authorization, fail-closed and unchanged ─────────────────────
  /*
   * The single existing gate, composed exactly as it always was: the publication
   * policy, the 02C right (fail-closed — a source with no record is denied) and the
   * type's adapter. Nothing here re-implements it, so a right can never be
   * granted by the selector that the gate would refuse.
   */
  const eligibility = decideSourceEligibility({
    publication: {
      channelStatus: input.channel.editorialStatus,
      sourceStatus: source.editorialStatus,
      permission: source.permission as never,
      technicalStatus: source.technicalStatus,
      conditions: source.conditions,
    },
    authorization: input.authorizations?.get(source._id) ?? null,
    type,
    now,
    requestedTerritory: null,
  });
  if (!eligibility.playable) {
    return {
      source,
      selectable: false,
      refusal: {
        axis: 'authorization',
        code: eligibility.publicationReason ?? eligibility.authorizationReason ?? 'ineligible',
      },
    };
  }

  /*
   * An `external` source is a link the caller may offer, NEVER an in-app candidate
   * and never a failover target — even though it is authorised and eligible. This
   * refusal is the reason the selector and the exposure question must stay
   * separate: see `isEligibleSource` in `playback.service.ts`.
   */
  if (type === 'external') {
    return { source, selectable: false, refusal: { axis: 'authorization', code: 'external-link-only' } };
  }
  if (source.url === null) {
    return { source, selectable: false, refusal: { axis: 'address', code: 'no-url' } };
  }

  // ── Axis 2: compatibility, measured only ────────────────────────────────
  const compatibility = resolveCompatibility({
    probe: evidence.reproductions.get(source._id) ?? null,
    browser: evidence.reproductionEngine,
  });
  if (compatibility.state === 'incompatible') {
    return {
      source,
      selectable: false,
      refusal: { axis: 'compatibility', code: compatibility.reason },
    };
  }

  // ── Axis 3: health, tri-state, and only for the types it observed ────────
  /*
   * `healthGovernsType` is read here rather than inside `sourceHealth`, and it
   * decides the *reported* state too, not only whether the source is refused: a
   * recorded `http-404` on a YouTube channel page is a fact about an HTTP probe
   * this platform does not perform for embeds, so reporting it as the embed's
   * health would be a claim the observation does not support.
   */
  const governed = healthGovernsType(type);
  const health = governed ? sourceHealth(source, evidence) : NOT_VERIFIED;
  if (governed && health.state === 'failing') {
    return {
      source,
      selectable: false,
      refusal: { axis: 'health', code: health.failure ?? 'failing' },
    };
  }

  return { source, selectable: true, axes: { authorized: true, compatibility, health } };
}

/** Health of one source: the recorded check first, then the source row. */
export function sourceHealth(source: PlaybackSourceDoc, evidence: SourceEvidence): SourceHealthVerdict {
  const row: StoredTechnicalStatus = {
    technicalStatus: source.technicalStatus,
    lastVerifiedAt: source.lastVerifiedAt,
    lastVerification: source.lastVerification,
  };
  return resolveSourceHealth(evidence.checks.get(source._id) ?? null, row);
}

/**
 * Axis 4: quality. A tie-break between candidates that already passed the first
 * three axes — never a way in. A higher-priority source that is failing is simply
 * not a candidate; it is not "outranked".
 */
export function compareByQuality(a: PlaybackSourceDoc, b: PlaybackSourceDoc): number {
  return compareSources(a, b);
}

/**
 * Evaluates every source and returns the selectable ones in quality order plus
 * the authorized-but-refused ones. This is the *only* function that decides
 * attemptability; nothing else in playback may consult health on its own.
 */
export function selectPlaybackCandidates(input: SelectionInput): PlaybackSelection {
  const decisions = input.sources.map((source) => decideCandidate(source, input));
  const candidates = decisions
    .filter((decision): decision is Extract<CandidateDecision, { selectable: true }> => decision.selectable)
    .sort((a, b) => compareByQuality(a.source, b.source))
    .map((decision) => ({ source: decision.source, axes: decision.axes }));
  const refused = decisions
    .filter(
      (decision): decision is Extract<CandidateDecision, { selectable: false }> & {
        refusal: Extract<CandidateRefusal, { axis: 'compatibility' | 'health' | 'address' }>;
      } => !decision.selectable && decision.refusal.axis !== 'authorization',
    )
    .map((decision) => ({ source: decision.source, refusal: decision.refusal }));
  return { candidates, refused };
}

/** Whether a channel has any selectable in-app candidate. */
export function hasSelectableCandidate(selection: PlaybackSelection): boolean {
  return selection.candidates.length > 0;
}

/** Health state of an option, as `PlaybackOption['health']` carries it. */
export function healthEvidence(health: SourceHealthVerdict): NonNullable<PlaybackOption['health']> {
  return {
    state: health.state,
    origin: health.origin,
    depth: health.depth,
    failure: health.failure,
    observedAt: health.observedAt?.toISOString() ?? null,
  };
}
