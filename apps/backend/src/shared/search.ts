/**
 * Spanish-language search normalisation.
 *
 * Ported from the frontend's own `core/text/normalize.ts` so server-side search
 * ranks and matches exactly what the old client-side filter did: accents,
 * articles and common abbreviations are folded, and the abbreviation expansion
 * ("tve" → "television espanola") is derived, never guessed at query time.
 */
import { slugify } from './slug.js';

const FOLD: Readonly<Record<string, string>> = {
  á: 'a',
  à: 'a',
  ä: 'a',
  â: 'a',
  é: 'e',
  è: 'e',
  ë: 'e',
  ê: 'e',
  í: 'i',
  ì: 'i',
  ï: 'i',
  î: 'i',
  ó: 'o',
  ò: 'o',
  ö: 'o',
  ô: 'o',
  ú: 'u',
  ù: 'u',
  ü: 'u',
  û: 'u',
  ñ: 'n',
  ç: 'c',
  ß: 'ss',
};

/** Leading articles that carry no search signal. */
const LEADING_ARTICLES = new Set(['el', 'la', 'los', 'las', 'l', 'le', 'les', 'the', 'a']);

/** Long-form expansions of abbreviations that appear in channel names. */
const EXPANSIONS: Readonly<Record<string, string>> = {
  tve: 'television espanola',
  rtve: 'radio television espanola',
  tdt: 'television digital terrestre',
  cadena: 'cadena',
  int: 'internacional',
  tv: 'television',
  hd: 'alta definicion',
  uhd: 'ultra alta definicion',
  canal: 'canal',
  es: 'espana',
};

export function normalizeForSearch(input: string): string {
  const folded = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split('')
    .map((char) => FOLD[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return folded;
}

/** Search forms of a channel name: as written, without articles, expanded, slug. */
export function searchForms(input: string): string[] {
  const base = normalizeForSearch(input);
  const forms = new Set<string>([base, slugify(base)]);
  const tokens = base.split(' ').filter(Boolean);
  const first = tokens[0];
  const trimmed = first !== undefined && tokens.length > 1 && LEADING_ARTICLES.has(first) ? tokens.slice(1).join(' ') : base;
  forms.add(trimmed);
  const expanded = tokens
    .map((token) => EXPANSIONS[token] ?? token)
    .join(' ');
  forms.add(expanded);
  // Every prefix of the first tokens keeps "la 1" findable from partial input,
  // and the glued runs make "la1" find "La 1" (the same rule the client search
  // used, so server-side and client-side search agree).
  tokens.slice(0, 3).forEach((_token, index) => forms.add(tokens.slice(0, index + 1).join(' ')));
  const derived = tokens.join('');
  forms.add(derived);
  tokens.forEach((token) => forms.add(token));
  return [...forms].filter((form) => form.length > 0);
}

/** A single searchable string stored beside each channel for text indexes. */
export function searchText(...parts: string[]): string {
  const unique = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    for (const form of searchForms(part)) {
      unique.add(form);
    }
  }
  return [...unique].join(' ');
}

/** True when `needle` matches `haystack` at a token boundary or inside a token. */
export function matchesQuery(haystack: string, needle: string): boolean {
  const query = normalizeForSearch(needle);
  if (!query) return true;
  return haystack.includes(query);
}
