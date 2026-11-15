/**
 * Text normalisation shared by search, slugs and identifier derivation.
 *
 * Search must behave identically for "La 1", "la1" and "LA 1" and for accented
 * input such as "Aragón" / "aragon", so every comparison goes through
 * `normalizeForSearch`. `matchesQuery` additionally joins adjacent tokens in
 * both directions, so "la1" finds "La 1" and a channel called "La1" is found by
 * "la 1".
 */

const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Lowercase, strip diacritics, collapse everything that is not a letter or
 * digit. Keeps the result stable across browsers (no locale-dependent casing).
 */
export function normalizeForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Whitespace-free form used for identifiers and slugs. */
export function slugify(value: string): string {
  return normalizeForSearch(value).replace(/\s+/g, '-');
}

/**
 * Compact key used to de-duplicate channel identifiers when two entries share a
 * display name. Falls back to a numeric suffix supplied by the caller.
 */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const root = slugify(base) || 'canal';
  if (!taken.has(root)) {
    return root;
  }
  let index = 2;
  while (taken.has(`${root}-${index}`)) {
    index += 1;
  }
  return `${root}-${index}`;
}

/** Upper bound for glued variants stored per channel: real names never approach it. */
const MAX_GLUED_FORMS = 512;

/**
 * Every contiguous token run glued into one form (`['la','1','tv']` ->
 * `la1`, `la1tv`, `1tv`). Single pairs are not enough: "canalsur" spans
 * "Canal" + "Sur" + "Andalucía" and must still match.
 */
function gluedForms(tokens: readonly string[]): string[] {
  const forms: string[] = [];
  for (let start = 0; start < tokens.length && forms.length < MAX_GLUED_FORMS; start += 1) {
    let run = '';
    for (let end = start; end < tokens.length && forms.length < MAX_GLUED_FORMS; end += 1) {
      run += tokens[end];
      if (end > start) forms.push(run);
    }
  }
  return forms;
}

/**
 * Search forms of a normalised text. Use this on the haystack side, once per
 * channel: the original tokens plus every glued run, so a channel called "La 1"
 * is also found as "la1". A derived form never starts with a different word.
 */
export function searchForms(text: string): string[] {
  const tokens = text.split(' ').filter(Boolean);
  return tokens.length === 0 ? [] : [...tokens, ...gluedForms(tokens)];
}

/**
 * True when `haystack` can absorb every token of `query`: a query token matches
 * a form by prefix, or two query tokens match one "name digit" word such as
 * "la1", which is how "la 1" finds "La1". Feed it the channel text that was
 * indexed with `searchForms(...).join(' ')` so "la1" also finds "La 1".
 * Both inputs must already be normalised.
 */
export function matchesQuery(haystack: string, query: string): boolean {
  if (!query) {
    return true;
  }
  const forms = haystack.split(' ').filter(Boolean);
  const tokens = query.split(' ').filter(Boolean);
  const absorbs = (token: string): boolean => forms.some((form) => form.startsWith(token));
  if (tokens.every(absorbs)) {
    return true;
  }
  // Pairing only glues a letter run with a digit run ("la" + "1", "24" + "h"),
  // which is the one split no channel name can carry on its own.
  return tokens.some((token, index) => {
    const next = tokens[index + 1];
    if (next === undefined || !/^[a-z]+$/.test(token) || !/^\d+$/.test(next)) {
      return false;
    }
    const rest = [...tokens.slice(0, index), token + next, ...tokens.slice(index + 2)];
    return rest.every(absorbs);
  });
}

/** Collator that orders Spanish text naturally (accents and case-aware). */
export const SPANISH_COLLATOR = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
