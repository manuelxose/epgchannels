/**
 * Display names for the country codes the PUBLIC catalogue can carry.
 *
 * The catalogue's `country` field is the compatibility value documented in
 * `infrastructure/schema.ts`: the ISO 3166-1 alpha-2 code for Spain and the
 * aggregate `INT` for every other country. So the only answers needed here are
 * `ES` and the aggregate — the code itself is returned for anything else, which
 * is honest (a code is never a fabrication) and keeps this table from growing
 * into a dataset nobody asked for.
 *
 * Display names are Spanish, matching the rest of the API's user-facing text.
 */

/** The documented aggregate for channels outside Spain. */
export const INTERNATIONAL_COUNTRY_CODE = 'INT';

const NAMES: Readonly<Record<string, string>> = {
  ES: 'España',
  [INTERNATIONAL_COUNTRY_CODE]: 'Internacionales',
};

/** Display name for a catalogue country code; the code itself when unnamed. */
export function countryDisplayName(code: string): string {
  return NAMES[code] ?? code;
}

/**
 * Spanish language names for the labels the catalogue publishes.
 *
 * Same rule as the country table: a label without a name is shown as its own
 * code rather than as a guess. `multi` and `und` are *coverage* markers, not
 * languages, and are never presented as one.
 */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  es: 'Español',
  ca: 'Català',
  gl: 'Galego',
  eu: 'Euskara',
  en: 'English',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  pt: 'Português',
  ar: 'العربية',
  ro: 'Română',
  zh: '中文',
  ja: '日本語',
  nl: 'Nederlands',
  ru: 'Русский',
  pl: 'Polski',
  tr: 'Türkçe',
  sv: 'Svenska',
  da: 'Dansk',
  no: 'Norsk',
  fi: 'Suomi',
  el: 'Ελληνικά',
  he: 'עברית',
  ko: '한국어',
  hi: 'हिन्दी',
  cs: 'Čeština',
  hu: 'Magyar',
  uk: 'Українська',
  sr: 'Српски',
  hr: 'Hrvatski',
  sk: 'Slovenčina',
  sl: 'Slovenščina',
  lt: 'Lietuvių',
  lv: 'Latviešu',
  is: 'Íslenska',
};

/** Display name for a language label; the label itself when it has none. */
export function languageDisplayName(code: string): string {
  const folded = code.toLowerCase();
  /*
   * `multi` and `und` are the catalogue's coverage markers, not languages. They
   * are named as such so a client never renders "multi" as if it were a spoken
   * language next to "Español".
   */
  if (folded === 'multi') return 'Varios idiomas';
  if (folded === 'und') return 'Idioma sin determinar';
  return LANGUAGE_NAMES[folded] ?? code;
}
