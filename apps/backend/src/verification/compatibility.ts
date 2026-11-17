/**
 * The compatibility axis: what a browser actually did, and nothing else.
 *
 * This module exists because "it failed to verify" and "the browser cannot play
 * it" are routinely confused. They are different axes, and the confusion is not
 * hypothetical: the verification vocabulary reports `unsupported-format` both for
 * a body that is not a manifest AND for a request we refused before sending it
 * (`scheme-not-allowed`, `content-type-not-allowed` both map to it in
 * `validator.ts`). A purely HTTP-side failure therefore says nothing at all about
 * a browser.
 *
 * The only input that can produce a verdict here is the engine's layer-6
 * reproduction probe: `ValidationResult` with `depthReached === 'browser'`, whose
 * `failure.category` is one of the three browser categories. Everything else —
 * including every transport, manifest, playlist and segment failure, and the
 * `browser`-depth outcome that only means "a probe ran and it worked" — maps to
 * `unknown`, never to `incompatible`.
 *
 * Keeping this in `verification/` means the playback selector consumes a fact
 * produced by the engine rather than re-deriving one, and that the closed set
 * below is the single place a new browser verdict can be introduced.
 */
import type { PlaybackCompatibility } from '@tdt/contracts';

/**
 * The shape this module reads. It is `ValidationResult` from `validator.ts`,
 * restated structurally so this file adds no import cycle: the playback selector
 * and the validator both depend on the axis, never on each other.
 */
export interface ReproductionResult {
  readonly depthReached: string;
  readonly failure: { readonly category: string } | null;
  readonly observedAt: Date;
}

/**
 * Failure categories that may only ever come from the reproduction probe.
 *
 * They are enumerated from the contract vocabulary (`failures.ts`), where their
 * cause is `browser`. They are *not* read from a message string: a message is
 * prose that changes whenever someone rewords a log line.
 */
const BROWSER_PROBE_CATEGORIES = ['browser-incompatible', 'codec-failure', 'cors-limitation'] as const;

type BrowserProbeCategory = (typeof BROWSER_PROBE_CATEGORIES)[number];

function isBrowserProbeCategory(value: string | null | undefined): value is BrowserProbeCategory {
  return value === 'browser-incompatible' || value === 'codec-failure' || value === 'cors-limitation';
}

/**
 * The depth a reproduction verdict comes from. `validator.ts` reaches it only
 * after manifest and segment evidence, and only with an injected probe whose
 * failure carries a browser category.
 */
export const REPRODUCTION_DEPTH = 'browser';

export interface CompatibilityProbeInput {
  /** The reproduction result the engine kept for this source, if any. */
  readonly probe: ReproductionResult | null;
  /** Browser/engine label the probe ran on (`chromium`, `webkit`, …). */
  readonly browser: string;
}

/**
 * Resolves the compatibility axis from a recorded reproduction result.
 *
 * Rules, in order:
 *
 * 1. No probe at all, or a probe that ends before the reproduction depth ⇒
 *    `unknown`. Absence is never "compatible" and never "incompatible".
 * 2. A probe at the reproduction depth whose failure is one of the three browser
 *    categories ⇒ `incompatible`, carrying that measured reason.
 * 3. A probe at the reproduction depth with no failure ⇒ `reproduced`.
 * 4. Anything else (an `unknown-error` at browser depth, a category outside the
 *    closed set) ⇒ `unknown`. An unrecognised failure is not evidence.
 */
export function resolveCompatibility(input: CompatibilityProbeInput): PlaybackCompatibility {
  const probe = input.probe;
  if (probe === null || probe.depthReached !== REPRODUCTION_DEPTH) {
    return { state: 'unknown' };
  }
  const category = probe.failure?.category ?? null;
  if (probe.failure === null) {
    return {
      state: 'reproduced',
      browser: input.browser,
      depth: probe.depthReached,
      observedAt: probe.observedAt.toISOString(),
    };
  }
  if (!isBrowserProbeCategory(category)) {
    // A browser-depth failure that is not a reproduction verdict (an internal
    // error we could not attribute) proves nothing about the browser.
    return { state: 'unknown' };
  }
  return {
    state: 'incompatible',
    reason: category,
    browser: input.browser,
    observedAt: probe.observedAt.toISOString(),
  };
}
