/**
 * Public slug policy.
 *
 * A slug is a public identity: it is derived once, is stable for the lifetime of
 * the record, and is never silently changed. The generator can take a hint (an
 * existing consumer's canonical slug, e.g. GuíaTV's) so the same channel never
 * ends up with two public URLs.
 */

/** Combining diacritics, removed after NFD decomposition. */
const DIACRITICS = /[\u0300-\u036f]/g;

/** Named entities and symbols that would otherwise vanish (`ß`, `&`, `·`, `'`). */
const TRANSLITERATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[ñÑ]/g, 'n'],
  [/[&]/g, ' y '],
  [/[·•]/g, ' '],
  [/['’`´]/g, ''],
  [/[“”«»"]/g, ''],
  [/[#/\\|_\-]+/g, ' '],
  [/[+]/g, ' plus '],
];

export function slugify(input: string): string {
  let text = input.normalize('NFD').replace(DIACRITICS, '');
  for (const [pattern, replacement] of TRANSLITERATIONS) {
    text = text.replace(pattern, replacement);
  }
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 120)
    .replace(/-+$/g, '');
}

/**
 * Prefers the consumer's canonical slug when it is already a valid slug, so a
 * channel GuíaTV already publishes keeps exactly one public URL. Otherwise the
 * name is slugified.
 */
export function canonicalSlug(name: string, preferred?: string): string {
  const candidate = preferred ? slugify(preferred) : '';
  if (candidate.length >= 3) {
    return candidate;
  }
  const derived = slugify(name);
  if (derived.length >= 3) {
    return derived;
  }
  // A very short name still needs a usable identity; never an empty slug.
  const fallback = `canal-${slugify(name) || 'sin-nombre'}`;
  return fallback.slice(0, 120);
}
