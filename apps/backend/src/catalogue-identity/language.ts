/**
 * Country -> most likely primary language, used ONLY as a last resort when the
 * upstream declares no language at all.
 *
 * Why this file is deliberately small: a full 250-country table would be
 * invented data. Every entry here is a country whose dominant broadcast
 * language is not genuinely contested, and the result is recorded as
 * `languageSource: 'country-inferred'` so a reviewer can see it was not stated
 * by the source. Anything absent stays `und` — an honest "unknown" beats a
 * confident guess, which is the same rule that governs country and identity.
 *
 * A handful of countries are intentionally excluded because they are bilingual
 * or had no stable answer (BE, CA, CH, IN, ZA, …): they fall through to `und`.
 */
export const COUNTRY_PRIMARY_LANGUAGE: Readonly<Record<string, string>> = {
  AD: 'ca',
  AR: 'es',
  AT: 'de',
  AU: 'en',
  BR: 'pt',
  CL: 'es',
  CO: 'es',
  CZ: 'cs',
  DE: 'de',
  DK: 'da',
  ES: 'es',
  FI: 'fi',
  FR: 'fr',
  GB: 'en',
  GR: 'el',
  HR: 'hr',
  HU: 'hu',
  IE: 'en',
  IL: 'he',
  IS: 'is',
  IT: 'it',
  JP: 'ja',
  KR: 'ko',
  LT: 'lt',
  LV: 'lv',
  MX: 'es',
  NL: 'nl',
  NO: 'no',
  NZ: 'en',
  PE: 'es',
  PL: 'pl',
  PT: 'pt',
  RO: 'ro',
  RS: 'sr',
  RU: 'ru',
  SE: 'sv',
  SI: 'sl',
  SK: 'sk',
  TR: 'tr',
  UA: 'uk',
  US: 'en',
  UY: 'es',
  VE: 'es',
};

/**
 * Resolves the language to record for a candidate.
 *
 * The upstream's own value always wins. Only when it is absent or unusable does
 * this return a country-derived value, and the caller records that as an
 * inference rather than a fact.
 */
export function inferLanguageFromCountry(country: string | null): { language: string; inferred: boolean } {
  if (country === null) return { language: 'und', inferred: false };
  const mapped = COUNTRY_PRIMARY_LANGUAGE[country];
  if (mapped === undefined) return { language: 'und', inferred: false };
  return { language: mapped, inferred: true };
}
