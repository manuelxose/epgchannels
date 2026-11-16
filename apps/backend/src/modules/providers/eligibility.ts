/**
 * The eligibility gate: fail closed, always.
 *
 * The single rule this module exists to enforce: **a source is publicly playable
 * only when a recorded authorization says so**, and unknown authorization always
 * blocks playback. Technical availability is never consulted here — a healthy
 * HLS manifest proves the stream answers, not that we may play it.
 *
 * Resolution order (first match wins, the first two rules are the security ones):
 *
 * 1. No record at all                       → `unresolved`, denied.
 * 2. Origin kind that cannot authorize      → denied, even with an "approved" record.
 * 3. Verdict `restricted`/`unresolved`      → denied.
 * 4. Decision not active / expired          → denied.
 * 5. Verdict `external-link-only`           → allowed as a link, never in-app.
 * 6. Permitted verdict without a citable right → denied (green field, no evidence).
 * 7. Permitted verdict, method/scope mismatch → denied.
 * 8. Otherwise                              → eligible.
 *
 * Rule 2 is structural: a URL shortener, static CDN or catalogue reference is
 * never a party that can grant a playback right, so it cannot be promoted to a
 * permitted verdict by a data edit.
 */
import {
  hasCitableRight,
  isWellFormedRecord,
  type AuthorizationRecord,
  type EligibilityClass,
  type EligibilityDecision,
} from './authorization.js';

export type { EligibilityDecision } from './authorization.js';
import { kindMayAuthorizePlayback, PROVIDER_KIND_FACTS } from './provider-kinds.js';

export interface EligibilityInput {
  /** The persisted record, or `null` when nothing was ever recorded. */
  readonly record: AuthorizationRecord | null;
  /** Injected clock, so expiry is testable and deterministic. */
  readonly now?: Date | undefined;
  /**
   * Whether the caller wants an in-app playback verdict. When false (a link
   * surface), `external-link-only` is acceptable.
   */
  readonly forInAppPlayback?: boolean | undefined;
  /** ISO 3166-1 alpha-2 the right must cover, when a territory is being claimed. */
  readonly requestedTerritory?: string | null | undefined;
}

function denial(
  verdict: EligibilityClass,
  reason: Extract<EligibilityDecision, { eligible: false }>['reason'],
  detail: string,
  record: AuthorizationRecord | null,
): EligibilityDecision {
  return { eligible: false, verdict, reason, detail, record };
}

/**
 * Decides whether one source may be played. Pure: no I/O, no probes, no clock
 * beyond the injected one.
 */
export function decideEligibility(input: EligibilityInput): EligibilityDecision {
  const now = input.now ?? new Date();
  const record = input.record;

  // 1. Nothing recorded: the honest answer is "we do not know", which denies.
  if (record === null) {
    return denial('unresolved', 'no-authorization-record', 'No hay decisión de autorización registrada.', null);
  }

  if (!isWellFormedRecord(record)) {
    return denial('unresolved', 'authorization-unresolved', 'La decisión de autorización está mal formada.', record);
  }

  // 2. Structural: some origins can never authorize, whatever the record claims.
  if (!kindMayAuthorizePlayback(record.providerKind)) {
    return denial(
      record.verdict === 'restricted' ? 'restricted' : 'unresolved',
      'provider-kind-cannot-authorize',
      `${PROVIDER_KIND_FACTS[record.providerKind].label}: ${PROVIDER_KIND_FACTS[record.providerKind].rationale}`,
      record,
    );
  }

  // 3. Explicit denials.
  if (record.verdict === 'restricted') {
    return denial(
      'restricted',
      'authorization-restricted',
      record.quotedClause ?? 'Los términos publicados del operador prohíben esta integración.',
      record,
    );
  }
  if (record.verdict === 'unresolved') {
    return denial('unresolved', 'authorization-unresolved', 'Autorización no resuelta: no se reproduce.', record);
  }

  // 4. Lifecycle and expiry apply to every verdict, including the permissive ones.
  if (record.lifecycle !== 'active') {
    return denial(record.verdict, 'authorization-not-active', `Ciclo de vida "${record.lifecycle}".`, record);
  }
  if (record.expiresAt !== null && record.expiresAt.getTime() <= now.getTime()) {
    return denial(record.verdict, 'authorization-expired', `Caducó el ${record.expiresAt.toISOString()}.`, record);
  }

  // 5. A link is not a playback.
  if (record.verdict === 'external-link-only') {
    if (input.forInAppPlayback === false) {
      return { eligible: true, verdict: record.verdict, method: record.method, record };
    }
    return denial(
      record.verdict,
      'authorization-class-mismatch',
      'Solo se permite como enlace externo; no se reproduce dentro de la aplicación.',
      record,
    );
  }

  // 6. A permitted verdict needs a citable right behind it.
  if (!hasCitableRight(record)) {
    return denial(
      record.verdict,
      'authorization-missing-quote',
      'Un veredicto permisivo exige una cláusula citada o una licencia por escrito.',
      record,
    );
  }

  // 7. The method and scope must agree with the class.
  const expectedMethod = record.verdict === 'permitted-official-embed' ? 'official-embed' : 'direct-playback';
  if (record.method !== expectedMethod) {
    return denial(
      record.verdict,
      'authorization-method-mismatch',
      `La clase "${record.verdict}" exige el método "${expectedMethod}", no "${record.method}".`,
      record,
    );
  }
  if (record.publicationScope !== 'in-app') {
    return denial(
      record.verdict,
      'authorization-method-mismatch',
      `La clase "${record.verdict}" exige el ámbito de publicación "in-app".`,
      record,
    );
  }

  // 8. A right recorded for another territory is not a right here.
  if (!coversTerritory(record, input.requestedTerritory ?? null)) {
    return denial(
      record.verdict,
      'authorization-restricted',
      'La autorización no cubre el territorio solicitado.',
      record,
    );
  }

  return { eligible: true, verdict: record.verdict, method: record.method, record };
}

/**
 * Whether a record's territory covers `requested` (ISO alpha-2).
 *
 * A `null` request means the caller did not name a territory. That must NOT be a
 * way to dodge a territorial restriction: a call with no territory is allowed
 * only when the right is genuinely unrestricted (worldwide). A right confined to
 * named countries — or geo-blocked — denies a territory-less request, because we
 * cannot show that the viewer is inside the permitted region. Asking no question
 * is not the same as answering "yes".
 */
export function coversTerritory(record: AuthorizationRecord, requested: string | null): boolean {
  const { allowed, restricted, worldwide, geoBlocked } = record.territory;
  if (requested === null) {
    const isRestrictive = geoBlocked || restricted.length > 0 || !worldwide;
    return isRestrictive ? false : true;
  }
  const code = requested.toUpperCase();
  if (restricted.includes(code)) return false;
  if (worldwide) return true;
  if (geoBlocked && allowed.length === 0) return false;
  return allowed.includes(code);
}

/** Convenience for callers that only need a boolean. */
export function isPubliclyPlayable(record: AuthorizationRecord | null, now?: Date): boolean {
  return decideEligibility({ record, now }).eligible;
}
