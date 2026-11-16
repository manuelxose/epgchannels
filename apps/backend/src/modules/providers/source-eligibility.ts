/**
 * Source-level eligibility, applied to real playback descriptors.
 *
 * This is the seam between the 02C rights model and the existing publication
 * policy. It composes — it does not replace — `decidePublication`:
 *
 *   public?            = decidePublication(...)         (existing, unchanged)
 *   AND authorized?    = decideEligibility(record)      (02C, fail-closed)
 *
 * A source that the old policy allows but whose authorization is missing,
 * unresolved or restricted is **not playable**. Availability never enters this
 * decision: `technicalStatus` is read only to *report* health, never to grant a
 * right.
 */
import { decidePublication, type PublicationContext } from '../playback/publication-policy.js';
import { decideEligibility } from './eligibility.js';
import type { EligibilityDecision } from './authorization.js';
import type { AuthorizationRecord } from './authorization.js';
import { providerAdapterRegistry, type ProviderAdapterRegistry } from './adapter.registry.js';
import type { PlaybackType } from '@tdt/contracts';

export interface SourceEligibilityInput {
  /** The publication context the existing policy already builds. */
  readonly publication: PublicationContext;
  /** The persisted authorization decision, or `null` if none is recorded. */
  readonly authorization: AuthorizationRecord | null;
  /** Playback type, used to pick the adapter that must corroborate the right. */
  readonly type: PlaybackType;
  readonly now?: Date | undefined;
  readonly requestedTerritory?: string | null | undefined;
  /** Override for tests; defaults to the process-wide registry. */
  readonly registry?: ProviderAdapterRegistry | undefined;
}

export type SourceEligibility =
  | { readonly playable: true; readonly eligibility: EligibilityDecision }
  | {
      readonly playable: false;
      /** Why the existing policy refused, when it did. */
      readonly publicationReason: string | null;
      /** Why the authorization gate refused, when it did. */
      readonly authorizationReason: string | null;
      /**
       * What the matching adapter additionally said, when it also refused.
       * Diagnostic only: it never replaces `authorizationReason`.
       */
      readonly adapterReason?: string;
      readonly eligibility: EligibilityDecision;
    };

/**
 * Decides whether one stored source may actually be played. Every failure path
 * denies; there is no branch that grants playback without a recorded right.
 */
export function decideSourceEligibility(input: SourceEligibilityInput): SourceEligibility {
  const registry = input.registry ?? providerAdapterRegistry;

  // Existing policy first: an unauthorised-by-policy source stays refused, and we
  // still evaluate eligibility so the report can say *both* reasons.
  const publication = decidePublication(input.publication);
  const eligibility = decideEligibility({
    record: input.authorization,
    now: input.now,
    forInAppPlayback: true,
    requestedTerritory: input.requestedTerritory ?? null,
  });

  if (!publication.public) {
    return {
      playable: false,
      publicationReason: publication.reason,
      authorizationReason: eligibility.eligible ? null : eligibility.reason,
      eligibility,
    };
  }

  if (!eligibility.eligible) {
    /*
     * The authorization gate is the primary cause and names it precisely. We
     * still consult the adapter so an operator sees the whole picture, but its
     * reason never replaces the real one — otherwise a denied source would be
     * reported as "adapter rejected" and the refusal would lose its meaning.
     * With no record at all there is nothing for an adapter to corroborate.
     */
    const adapterNote =
      eligibility.record === null ? null : (registry.verify(eligibility.record, input.type).reason ?? 'adapter-rejected');
    return {
      playable: false,
      publicationReason: null,
      authorizationReason: eligibility.reason,
      eligibility,
      ...(adapterNote === null ? {} : { adapterReason: adapterNote }),
    };
  }

  // The adapter must corroborate the class: a record cannot grant a method its
  // integration does not implement (e.g. YouTube terms cannot authorise HLS).
  // `eligible: true` always carries a record; assert it so the invariant is local.
  if (eligibility.record === null) {
    return {
      playable: false,
      publicationReason: null,
      authorizationReason: 'no-authorization-record',
      eligibility,
    };
  }
  const adapter = registry.verify(eligibility.record, input.type);
  if (!adapter.satisfied) {
    return { playable: false, publicationReason: null, authorizationReason: adapter.reason ?? 'adapter-rejected', eligibility };
  }

  return { playable: true, eligibility };
}

/** Boolean convenience for list/status paths. */
export function isSourcePlayable(input: SourceEligibilityInput): boolean {
  return decideSourceEligibility(input).playable;
}
