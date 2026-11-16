/**
 * Country code ↔ name table used to read upstream country hints.
 *
 * Upstreams mix ISO alpha-2 codes (`ES`), English names (`Spain`) and local
 * names (`España`, `Deutschland`). The table is deliberately small and explicit:
 * adding a country is an edit here, never an inference. It does not validate
 * that a code is officially assigned and is not a general-purpose dataset.
 */

interface CountryRow {
  code: string;
  english: string;
  aliases: readonly string[];
}

const ROWS: readonly CountryRow[] = [
  { code: 'AD', english: 'Andorra', aliases: ['andorra'] },
  { code: 'AE', english: 'United Arab Emirates', aliases: ['emiratos arabes unidos', 'uae', 'dubai'] },
  { code: 'AF', english: 'Afghanistan', aliases: ['afganistan'] },
  { code: 'AG', english: 'Antigua and Barbuda', aliases: [] },
  { code: 'AL', english: 'Albania', aliases: ['shqiperia'] },
  { code: 'AM', english: 'Armenia', aliases: ['hayastan'] },
  { code: 'AO', english: 'Angola', aliases: [] },
  { code: 'AR', english: 'Argentina', aliases: [] },
  { code: 'AT', english: 'Austria', aliases: ['osterreich'] },
  { code: 'AU', english: 'Australia', aliases: [] },
  { code: 'AW', english: 'Aruba', aliases: [] },
  { code: 'AZ', english: 'Azerbaijan', aliases: [] },
  { code: 'BA', english: 'Bosnia and Herzegovina', aliases: ['bosnia'] },
  { code: 'BB', english: 'Barbados', aliases: [] },
  { code: 'BD', english: 'Bangladesh', aliases: [] },
  { code: 'BE', english: 'Belgium', aliases: ['belgique', 'belgie'] },
  { code: 'BF', english: 'Burkina Faso', aliases: [] },
  { code: 'BG', english: 'Bulgaria', aliases: [] },
  { code: 'BH', english: 'Bahrain', aliases: [] },
  { code: 'BI', english: 'Burundi', aliases: [] },
  { code: 'BJ', english: 'Benin', aliases: [] },
  { code: 'BO', english: 'Bolivia', aliases: [] },
  { code: 'BR', english: 'Brazil', aliases: ['brasil'] },
  { code: 'BS', english: 'Bahamas', aliases: [] },
  { code: 'BY', english: 'Belarus', aliases: [] },
  { code: 'BZ', english: 'Belize', aliases: [] },
  { code: 'CA', english: 'Canada', aliases: [] },
  { code: 'CD', english: 'DR Congo', aliases: ['democratic republic of the congo', 'congo kinshasa'] },
  { code: 'CH', english: 'Switzerland', aliases: ['suisse', 'svizzera', 'schweiz'] },
  { code: 'CI', english: "Cote d'Ivoire", aliases: ['cote divoire', 'ivory coast'] },
  { code: 'CL', english: 'Chile', aliases: [] },
  { code: 'CM', english: 'Cameroon', aliases: ['cameroun'] },
  { code: 'CN', english: 'China', aliases: [] },
  { code: 'CO', english: 'Colombia', aliases: [] },
  { code: 'CR', english: 'Costa Rica', aliases: [] },
  { code: 'CU', english: 'Cuba', aliases: [] },
  { code: 'CY', english: 'Cyprus', aliases: [] },
  { code: 'CZ', english: 'Czechia', aliases: ['czech republic', 'cesko'] },
  { code: 'DE', english: 'Germany', aliases: ['deutschland', 'alemania'] },
  { code: 'DK', english: 'Denmark', aliases: ['danmark'] },
  { code: 'DO', english: 'Dominican Republic', aliases: ['republica dominicana'] },
  { code: 'DZ', english: 'Algeria', aliases: ['argelia'] },
  { code: 'EC', english: 'Ecuador', aliases: [] },
  { code: 'EE', english: 'Estonia', aliases: [] },
  { code: 'EG', english: 'Egypt', aliases: ['egipto'] },
  { code: 'ES', english: 'Spain', aliases: ['espana', 'espanya', 'españa', 'espainia'] },
  { code: 'ET', english: 'Ethiopia', aliases: [] },
  { code: 'FI', english: 'Finland', aliases: ['suomi'] },
  { code: 'FJ', english: 'Fiji', aliases: [] },
  { code: 'FO', english: 'Faroe Islands', aliases: [] },
  { code: 'FR', english: 'France', aliases: ['francia', 'frankreich'] },
  { code: 'GB', english: 'United Kingdom', aliases: ['uk', 'great britain', 'england', 'scotland', 'wales', 'northern ireland', 'reino unido'] },
  { code: 'GE', english: 'Georgia', aliases: [] },
  { code: 'GH', english: 'Ghana', aliases: [] },
  { code: 'GI', english: 'Gibraltar', aliases: [] },
  { code: 'GR', english: 'Greece', aliases: ['grecia', 'hellas'] },
  { code: 'GT', english: 'Guatemala', aliases: [] },
  { code: 'GY', english: 'Guyana', aliases: [] },
  { code: 'HK', english: 'Hong Kong', aliases: [] },
  { code: 'HN', english: 'Honduras', aliases: [] },
  { code: 'HR', english: 'Croatia', aliases: ['hrvatska'] },
  { code: 'HT', english: 'Haiti', aliases: [] },
  { code: 'HU', english: 'Hungary', aliases: ['magyarorszag'] },
  { code: 'ID', english: 'Indonesia', aliases: [] },
  { code: 'IE', english: 'Ireland', aliases: ['eire'] },
  { code: 'IL', english: 'Israel', aliases: [] },
  { code: 'IN', english: 'India', aliases: ['bharat'] },
  { code: 'IQ', english: 'Iraq', aliases: [] },
  { code: 'IR', english: 'Iran', aliases: [] },
  { code: 'IS', english: 'Iceland', aliases: ['islandia'] },
  { code: 'IT', english: 'Italy', aliases: ['italia'] },
  { code: 'JM', english: 'Jamaica', aliases: [] },
  { code: 'JO', english: 'Jordan', aliases: ['jordania'] },
  { code: 'JP', english: 'Japan', aliases: ['nippon', 'nihon'] },
  { code: 'KE', english: 'Kenya', aliases: [] },
  { code: 'KG', english: 'Kyrgyzstan', aliases: [] },
  { code: 'KH', english: 'Cambodia', aliases: [] },
  { code: 'KR', english: 'South Korea', aliases: ['korea', 'republic of korea'] },
  { code: 'KW', english: 'Kuwait', aliases: [] },
  { code: 'KZ', english: 'Kazakhstan', aliases: [] },
  { code: 'LB', english: 'Lebanon', aliases: ['libano'] },
  { code: 'LK', english: 'Sri Lanka', aliases: [] },
  { code: 'LT', english: 'Lithuania', aliases: ['lietuva'] },
  { code: 'LU', english: 'Luxembourg', aliases: ['luxemburgo'] },
  { code: 'LV', english: 'Latvia', aliases: ['latvija'] },
  { code: 'LY', english: 'Libya', aliases: ['libia'] },
  { code: 'MA', english: 'Morocco', aliases: ['marruecos', 'maroc'] },
  { code: 'MC', english: 'Monaco', aliases: ['monaco'] },
  { code: 'MD', english: 'Moldova', aliases: [] },
  { code: 'ME', english: 'Montenegro', aliases: [] },
  { code: 'MK', english: 'North Macedonia', aliases: ['macedonia'] },
  { code: 'ML', english: 'Mali', aliases: [] },
  { code: 'MT', english: 'Malta', aliases: [] },
  { code: 'MX', english: 'Mexico', aliases: ['mejico'] },
  { code: 'MY', english: 'Malaysia', aliases: [] },
  { code: 'MZ', english: 'Mozambique', aliases: [] },
  { code: 'NG', english: 'Nigeria', aliases: [] },
  { code: 'NL', english: 'Netherlands', aliases: ['holland', 'paises bajos', 'nederland'] },
  { code: 'NO', english: 'Norway', aliases: ['norge'] },
  { code: 'NP', english: 'Nepal', aliases: [] },
  { code: 'NZ', english: 'New Zealand', aliases: ['nueva zelanda'] },
  { code: 'OM', english: 'Oman', aliases: [] },
  { code: 'PA', english: 'Panama', aliases: [] },
  { code: 'PE', english: 'Peru', aliases: ['perú'] },
  { code: 'PH', english: 'Philippines', aliases: ['filipinas'] },
  { code: 'PK', english: 'Pakistan', aliases: [] },
  { code: 'PL', english: 'Poland', aliases: ['polska'] },
  { code: 'PS', english: 'Palestine', aliases: [] },
  { code: 'PT', english: 'Portugal', aliases: [] },
  { code: 'PY', english: 'Paraguay', aliases: [] },
  { code: 'QA', english: 'Qatar', aliases: [] },
  { code: 'RO', english: 'Romania', aliases: ['rumania'] },
  { code: 'RS', english: 'Serbia', aliases: ['srbija'] },
  { code: 'RU', english: 'Russia', aliases: ['russian federation', 'россия'] },
  { code: 'RW', english: 'Rwanda', aliases: [] },
  { code: 'SA', english: 'Saudi Arabia', aliases: ['arabia saudita'] },
  { code: 'SD', english: 'Sudan', aliases: ['sudan'] },
  { code: 'SE', english: 'Sweden', aliases: ['sverige', 'suecia'] },
  { code: 'SG', english: 'Singapore', aliases: ['singapur'] },
  { code: 'SI', english: 'Slovenia', aliases: ['slovenija'] },
  { code: 'SK', english: 'Slovakia', aliases: ['slovensko'] },
  { code: 'SN', english: 'Senegal', aliases: ['senegal'] },
  { code: 'SO', english: 'Somalia', aliases: [] },
  { code: 'SV', english: 'El Salvador', aliases: [] },
  { code: 'SY', english: 'Syria', aliases: ['siria'] },
  { code: 'TG', english: 'Togo', aliases: ['togo'] },
  { code: 'TH', english: 'Thailand', aliases: ['tailandia'] },
  { code: 'TN', english: 'Tunisia', aliases: ['tunez'] },
  { code: 'TR', english: 'Turkey', aliases: ['turkiye', 'turquia'] },
  { code: 'TT', english: 'Trinidad and Tobago', aliases: [] },
  { code: 'TW', english: 'Taiwan', aliases: [] },
  { code: 'TZ', english: 'Tanzania', aliases: [] },
  { code: 'UA', english: 'Ukraine', aliases: ['ucrania'] },
  { code: 'UG', english: 'Uganda', aliases: [] },
  { code: 'US', english: 'United States', aliases: ['usa', 'estados unidos', 'united states of america'] },
  { code: 'UY', english: 'Uruguay', aliases: [] },
  { code: 'UZ', english: 'Uzbekistan', aliases: [] },
  { code: 'VE', english: 'Venezuela', aliases: [] },
  { code: 'VN', english: 'Vietnam', aliases: [] },
  { code: 'XK', english: 'Kosovo', aliases: [] },
  { code: 'ZA', english: 'South Africa', aliases: ['sudafrica'] },
  { code: 'ZM', english: 'Zambia', aliases: [] },
  { code: 'ZW', english: 'Zimbabwe', aliases: [] },
];

/** NFKD, strip combining marks, lowercase, collapse whitespace and separators. */
export function foldCountryKey(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const BY_CODE = new Map<string, CountryRow>();
const BY_FOLDED = new Map<string, CountryRow>();
for (const row of ROWS) {
  BY_CODE.set(row.code, row);
  BY_FOLDED.set(foldCountryKey(row.english), row);
  BY_FOLDED.set(row.code.toLowerCase(), row);
  for (const alias of row.aliases) {
    const key = foldCountryKey(alias);
    if (!BY_FOLDED.has(key)) BY_FOLDED.set(key, row);
  }
}

/** True when the (already uppercased) code is in the table. */
export function lookupCountryCode(code: string): boolean {
  return BY_CODE.has(code);
}

/** Resolves an English or local country name to ISO alpha-2, or null. */
export function lookupCountryName(name: string): string | null {
  return BY_FOLDED.get(foldCountryKey(name))?.code ?? null;
}
