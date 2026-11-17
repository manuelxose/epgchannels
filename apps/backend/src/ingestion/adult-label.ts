/**
 * Adult-content labelling for the iptv-org catalogue (TDT-API-02FG).
 *
 * The product owner decided that every iptv-org source enters the catalogue with
 * no additional restrictions, including the 375 rows flagged `is_nsfw`. That is
 * a product decision and this module does not second-guess it.
 *
 * What it does is narrower, and it is a labelling rule, not a filter: an adult
 * channel carries the word in its own name and in its own category, so it is
 * findable on purpose and recognisable on sight — never mixed into a family
 * listing by accident. Nothing is removed, nothing is hidden, nothing is
 * withheld from playback.
 *
 * It is applied once, idempotently: the marker is not repeated when re-imported.
 */
export const ADULT_CATEGORY = 'adultos' as const;

/** Name suffix added to an adult channel, once. */
export const ADULT_NAME_MARKER = '· adulto';

/** `true` when the name already carries the marker. */
export function isLabelledAdult(name: string): boolean {
  return name.includes(ADULT_NAME_MARKER);
}

/** The channel name with the adult marker applied exactly once. */
export function labelAdultName(name: string): string {
  const trimmed = name.trim();
  return isLabelledAdult(trimmed) ? trimmed : `${trimmed} ${ADULT_NAME_MARKER}`;
}
