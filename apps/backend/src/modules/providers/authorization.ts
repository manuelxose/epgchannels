/**
 * The authorization record: the persisted *rights* decision for one source.
 *
 * This is the 02C axis, and it is deliberately separate from availability:
 *
 * | question                       | field / record                     |
 * | ------------------------------ | ---------------------------------- |
 * | may we play it, and how?       | `AuthorizationRecord` (this file)  |
 * | does the stream answer today?  | `technicalStatus` (verification)   |
 *
 * Nothing in this file is ever derived from an HTTP probe. A stream that answers
 * 200 with a valid manifest still has `verdict: 'unresolved'` until a person
 * records a quoted right. The gate in `eligibility.ts` refuses public playback
 * whenever the verdict is not one of the two permitted classes.
 */
import { isProviderKind, type ProviderKind } from './provider-kinds.js';

/**
 * Exactly five eligibility classes. Every source resolves to exactly one.
 *
 * - `permitted-direct-playback` — an authorized signal our own engine may play.
 * - `permitted-official-embed` — an authorized embed scoped to the platform's
 *   own player (YouTube IFrame). Never direct playback.
 * - `external-link-only` — publicly reachable, but only as a link to the
 *   emitter's own page. Never in-app.
 * - `restricted` — the operator's published terms prohibit it.
 * - `unresolved` — no published right. The fail-closed default.
 */
export const eligibilityClassSchema = [
  'permitted-direct-playback',
  'permitted-official-embed',
  'external-link-only',
  'restricted',
  'unresolved',
] as const;

export type EligibilityClass = (typeof eligibilityClassSchema)[number];

/** Exactly the classes that permit public in-app playback. */
export const PLAYBACK_PERMITTING_CLASSES: readonly EligibilityClass[] = [
  'permitted-direct-playback',
  'permitted-official-embed',
];

export function isEligibilityClass(value: unknown): value is EligibilityClass {
  return typeof value === 'string' && (eligibilityClassSchema as readonly string[]).includes(value);
}

export function permitsPublicPlayback(verdict: EligibilityClass): boolean {
  return PLAYBACK_PERMITTING_CLASSES.includes(verdict);
}

/**
 * Where the finding came from.
 *
 * `published-terms` carries a quoted clause. `written-licence` is an executed
 * agreement held by the operator, not published pages. `none` is the absence of
 * evidence — never a permission.
 */
export const authorisationBasisSchema = ['published-terms', 'written-licence', 'none'] as const;
export type AuthorisationBasis = (typeof authorisationBasisSchema)[number];

/**
 * Operator-side follow-up state. `requires-written-licence` is deliberately
 * *blocked but still reachable*: the operator has a documented licensing channel,
 * so an operator action can change the verdict. It is not a permanent exclusion.
 */
export const reviewStatusSchema = ['reviewed', 'pending-review', 'requires-written-licence'] as const;
export type ReviewStatus = (typeof reviewStatusSchema)[number];

/**
 * How the source, if ever published, may be played. Mirrors the authorised
 * playback method on the source entry; `none` means no playback at all.
 */
export const authorisedMethodSchema = [
  'direct-playback',
  'official-embed',
  'external-link',
  'none',
] as const;
export type AuthorisedMethod = (typeof authorisedMethodSchema)[number];

/** Publication scope granted by the decision. */
export const publicationScopeSchema = ['in-app', 'external-only', 'none'] as const;
export type PublicationScope = (typeof publicationScopeSchema)[number];

/** Discovery evidence: how we came to know about this source. */
export interface DiscoveryEvidence {
  /** Upstream catalogue, e.g. `iptv-org`. */
  readonly upstream: string | null;
  /** Snapshot id / commit the line came from. */
  readonly snapshotId: string | null;
  /** Path inside the snapshot, e.g. `es.m3u`. */
  readonly path: string | null;
  /** 1-based line of the entry. */
  readonly line: number | null;
  /** The exact URL as it appeared upstream. */
  readonly sourceUrl: string | null;
  /** Canonical URL of an official document, when the evidence is documentary. */
  readonly documentUrl: string | null;
  /** When the evidence was retrieved. */
  readonly retrievedAt: Date | null;
}

/** Territory scope: where the right applies. */
export interface TerritoryScope {
  /** ISO 3166-1 alpha-2 codes the right covers; empty means "not established". */
  readonly allowed: readonly string[];
  /** ISO alpha-2 codes explicitly excluded. */
  readonly restricted: readonly string[];
  /** True only when the decision itself says the right is worldwide. */
  readonly worldwide: boolean;
  /** True when the upstream marks the stream `[Geo-blocked]`. */
  readonly geoBlocked: boolean;
}

/**
 * The authorization decision for one source. Persisted in its own collection
 * (`source_authorizations_02c`), never merged into the playback source document.
 */
export interface AuthorizationRecord {
  /** Stable id: operatorId + ':' + sourceKey. */
  readonly _id: string;
  /** Operator that owns the right (e.g. `rtve`, `atresmedia`). */
  readonly operatorId: string;
  /** The source this decision attaches to (normalized URL or official page). */
  readonly sourceUrl: string;
  /** What the origin host actually is. A shortener/cdn/reference can never authorize. */
  readonly providerKind: ProviderKind;
  /** The five-way class. */
  readonly verdict: EligibilityClass;
  /** Where the verdict came from. */
  readonly basis: AuthorisationBasis;
  /** Literal quoted clause that justifies the verdict; `null` when none exists. */
  readonly quotedClause: string | null;
  /** Citation URL for the quoted clause (or the licensing channel). */
  readonly clauseUrl: string | null;
  /** The authorised playback method. */
  readonly method: AuthorisedMethod;
  /** Publication scope granted. */
  readonly publicationScope: PublicationScope;
  /** Territory in which the decision applies. */
  readonly territory: TerritoryScope;
  /** Restrictions the decision imposes (rendered to the client). */
  readonly restrictions: readonly string[];
  /** Attribution text that must accompany any display. */
  readonly attribution: string | null;
  /** Discovery evidence for the source. */
  readonly discovery: DiscoveryEvidence;
  /** Editorial lifecycle of this decision record. */
  readonly lifecycle: 'draft' | 'active' | 'superseded' | 'expired';
  /** When the decision stops applying; `null` means no expiry recorded. */
  readonly expiresAt: Date | null;
  /** When the technical validation last ran (availability axis, never a right). */
  readonly validationTimestamp: Date | null;
  /** When the authorization decision itself was taken. */
  readonly authorizationTimestamp: Date | null;
  /** Operator review state. */
  readonly reviewStatus: ReviewStatus;
  /** Human notes, e.g. the licensing channel to contact. */
  readonly notes: string | null;
}

/** The pair `(playable, reason)` the gate returns. Reasons are machine-readable. */
export type EligibilityDenial =
  | 'no-authorization-record'
  | 'authorization-unresolved'
  | 'authorization-restricted'
  | 'authorization-expired'
  | 'authorization-not-active'
  | 'provider-kind-cannot-authorize'
  | 'authorization-missing-quote'
  | 'authorization-method-mismatch'
  | 'authorization-class-mismatch';

export type EligibilityDecision =
  | {
      readonly eligible: true;
      readonly verdict: EligibilityClass;
      readonly method: AuthorisedMethod;
      readonly record: AuthorizationRecord;
    }
  | {
      readonly eligible: false;
      readonly verdict: EligibilityClass;
      readonly reason: EligibilityDenial;
      readonly detail: string;
      readonly record: AuthorizationRecord | null;
    };

/** Convenience: the fail-closed default used when nothing is recorded. */
export function unresolvedRecord(
  operatorId: string,
  sourceUrl: string,
  providerKind: ProviderKind,
  discovery: DiscoveryEvidence,
): AuthorizationRecord {
  return {
    _id: `${operatorId}:${sourceUrl}`,
    operatorId,
    sourceUrl,
    providerKind,
    verdict: 'unresolved',
    basis: 'none',
    quotedClause: null,
    clauseUrl: null,
    method: 'none',
    publicationScope: 'none',
    territory: { allowed: [], restricted: [], worldwide: false, geoBlocked: false },
    restrictions: ['Sin derecho publicado: no se reproduce.'],
    attribution: null,
    discovery,
    lifecycle: 'active',
    expiresAt: null,
    validationTimestamp: null,
    authorizationTimestamp: null,
    reviewStatus: 'pending-review',
    notes: null,
  };
}

/**
 * Whether a citation is a real, re-checkable pointer.
 *
 * Non-nullness was not enough: any sentinel string ('n/a', a scheme-less label)
 * satisfied the old check, which is how a minted registration could briefly claim
 * a right with no evidence. A citation must now parse as an absolute `http(s)`
 * URL, so only something a person can actually open counts as evidence.
 */
export function isRealCitation(citation: string | null): boolean {
  if (citation === null || citation.trim().length === 0) return false;
  try {
    const url = new URL(citation.trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * A permitted verdict is only credible with a citable right behind it: either a
 * quoted clause plus a real citation (published terms) or an executed written
 * licence with a real citation. A green field with no evidence is exactly what
 * this milestone exists to reject.
 */
export function hasCitableRight(record: AuthorizationRecord): boolean {
  if (record.basis === 'published-terms') {
    return (
      record.quotedClause !== null &&
      record.quotedClause.trim().length > 0 &&
      isRealCitation(record.clauseUrl)
    );
  }
  if (record.basis === 'written-licence') {
    return isRealCitation(record.clauseUrl);
  }
  return false;
}

/** Structural check used by the gate; keeps an invalid record from ever passing. */
export function isWellFormedRecord(record: AuthorizationRecord): boolean {
  if (!isProviderKind(record.providerKind)) return false;
  if (!isEligibilityClass(record.verdict)) return false;
  if (!authorisationBasisSchema.includes(record.basis)) return false;
  if (!authorisedMethodSchema.includes(record.method)) return false;
  if (!publicationScopeSchema.includes(record.publicationScope)) return false;
  if (!reviewStatusSchema.includes(record.reviewStatus)) return false;
  return true;
}
