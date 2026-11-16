/**
 * Stable public slug generation for the channel catalogue.
 *
 * A slug is lowercase ASCII, at most 120 characters, deterministic, and — for
 * collision handling — independent of the order in which names are processed:
 * the collision suffix is derived from the name itself (a SHA-256 prefix), not
 * from a counter or an array position.
 *
 * Pure: the only import is `node:crypto`'s `createHash`, which is
 * deterministic. No I/O, no network, no randomness, no `Date.now`.
 */
import { createHash } from 'node:crypto';

/** Combining diacritics, removed after NFD decomposition. */
const DIACRITICS = /[\u0300-\u036f]/g;

/** Letters with no single-char ASCII equivalent; transliterated before folding. */
const TRANSLITERATIONS: ReadonlyArray<readonly [string, string]> = [
  ['ß', 'ss'],
  ['æ', 'ae'],
  ['Æ', 'AE'],
  ['œ', 'oe'],
  ['Œ', 'OE'],
  ['ø', 'o'],
  ['Ø', 'O'],
  ['ð', 'd'],
  ['Ð', 'D'],
  ['þ', 'th'],
  ['Þ', 'Th'],
  ['ł', 'l'],
  ['Ł', 'L'],
  ['đ', 'd'],
  ['Đ', 'D'],
  ['ı', 'i'],
];

/** Maximum public slug length (MODULE-CONTRACT-02B §0.5). */
const MAX_SLUG_LENGTH = 120;

/**
 * Produces the base slug: NFD → strip marks → transliterate → lowercase →
 * non-alphanumeric runs become `-`. Always lowercase ASCII and ≤ 120 chars.
 *
 * Does NOT add a collision suffix; use `uniqueSlug` for that.
 */
export function slugify(name: string): string {
  if (typeof name !== 'string') {
    return '';
  }
  let text = name.normalize('NFD').replace(DIACRITICS, '');
  for (const [from, to] of TRANSLITERATIONS) {
    text = text.split(from).join(to);
  }
  text = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (text.length > MAX_SLUG_LENGTH) {
    text = text.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '');
  }
  return text;
}

/** Deterministic 8-hex suffix derived from the exact input string. */
function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

/**
 * Returns a slug that is unique against `taken`.
 *
 * The base is `slugify(name)` (falling back to `canal` when empty). On a
 * collision, the base is truncated and a SHA-256 prefix of the exact name is
 * appended, so the same name always yields the same suffix regardless of the
 * order in which other names were processed. The `taken` set still guarantees
 * uniqueness.
 */
export function uniqueSlug(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name) || 'canal';
  if (!taken.has(base)) {
    return base;
  }
  const suffix = shortHash(name);
  const head = base.slice(0, MAX_SLUG_LENGTH - 1 - suffix.length);
  let candidate = `${head}-${suffix}`;
  let n = 0;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${head}-${suffix}-${n}`.slice(0, MAX_SLUG_LENGTH);
  }
  return candidate;
}

/** A deterministic, name-derived collision slug (`base` truncated to fit). */
function suffixed(base: string, name: string): string {
  const suffix = shortHash(name);
  const head = base.slice(0, MAX_SLUG_LENGTH - 1 - suffix.length);
  return `${head}-${suffix}`;
}

/**
 * Assigns a unique slug to every name in one deterministic pass.
 *
 * Names are deduplicated and sorted, so the whole assignment depends only on
 * the set of names, never on the order of the input array. Within a group of
 * names that slugify to the same base, the lexicographically smallest name
 * keeps the bare base and every other name gets a name-derived hash suffix.
 */
export function assignSlugs(names: readonly string[]): Map<string, string> {
  const unique = [...new Set(names)].sort();
  const groups = new Map<string, string[]>();
  for (const name of unique) {
    const base = slugify(name) || 'canal';
    const group = groups.get(base);
    if (group === undefined) {
      groups.set(base, [name]);
    } else {
      group.push(name);
    }
  }
  const result = new Map<string, string>();
  for (const [base, group] of groups) {
    for (let i = 0; i < group.length; i += 1) {
      const name = group[i];
      if (name === undefined) {
        continue;
      }
      result.set(name, i === 0 ? base : suffixed(base, name));
    }
  }
  return result;
}
