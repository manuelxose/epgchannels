/**
 * Deterministic text and identity normalisation for the channel catalogue.
 *
 * Every function here is pure: same input → same output, forever. No I/O, no
 * network, no randomness, no `Date.now`, no locale-dependent behaviour.
 *
 * The single invariant these functions serve: two different regional or local
 * stations must never be silently merged. Normalisation is therefore
 * conservative — it strips decoration (quality tags, flags, numbering) but
 * never strips a city/region qualifier, and unknown country/language values
 * return `null` instead of being guessed.
 */

/** Known provider suffixes that are hints, not identity (e.g. `Cine_pluto`). */
const PROVIDER_HINTS = new Set([
  'pluto',
  'samsung',
  'samsungtvplus',
  'roku',
  'tubi',
  'plex',
  'pbs',
  'stirr',
  'xumo',
  'sling',
  'fubo',
  'hulu',
  'philo',
  'frndly',
  'redbox',
  'haystack',
  'rakuten',
  'vizio',
  'livenews',
  'newsnet',
]);

/** Combining diacritics, removed after NFKD decomposition. */
const COMBINING_MARKS = /\p{M}/gu;

/**
 * Common mojibake produced by decoding UTF-8 bytes as Windows-1252/Latin-1.
 * Longer sequences must be replaced before shorter ones, so they are applied
 * longest-first. These replacements are deterministic and recover the intended
 * character exactly; they never invent a character.
 */
const MOJIBAKE: ReadonlyArray<readonly [string, string]> = [
  // Windows-1252 smart quotes / dashes (3 code units).
  ['\u00E2\u20AC\u0153', '"'],
  ['\u00E2\u20AC\u2122', "'"],
  ['\u00E2\u20AC\u201C', '"'],
  ['\u00E2\u20AC\u201D', '"'],
  ['\u00E2\u20AC\u2018', "'"],
  ['\u00E2\u20AC\u2019', "'"],
  ['\u00E2\u20AC\u2013', '\u2013'],
  ['\u00E2\u20AC\u2014', '\u2014'],
  ['\u00E2\u20AC\u00A6', '\u2026'],
  ['\u00E2\u20AC\u00A2', '\u00A2'],
  // Generic double-encoded closing quote (2 code units).
  ['\u00E2\u20AC', '"'],
  // Latin-1 mojibake of UTF-8 accented letters: `Ã` + symbol → the real letter.
  ['\u00C3\u00A9', '\u00E9'], // é
  ['\u00C3\u00A8', '\u00E8'], // è
  ['\u00C3\u00AA', '\u00EA'], // ê
  ['\u00C3\u00AB', '\u00EB'], // ë
  ['\u00C3\u00AD', '\u00ED'], // í
  ['\u00C3\u00AF', '\u00EF'], // ï
  ['\u00C3\u00B1', '\u00F1'], // ñ
  ['\u00C3\u00B3', '\u00F3'], // ó
  ['\u00C3\u00B2', '\u00F2'], // ò
  ['\u00C3\u00B4', '\u00F4'], // ô
  ['\u00C3\u00B6', '\u00F6'], // ö
  ['\u00C3\u00B5', '\u00F5'], // õ
  ['\u00C3\u00BA', '\u00FA'], // ú
  ['\u00C3\u00B9', '\u00F9'], // ù
  ['\u00C3\u00BB', '\u00FB'], // û
  ['\u00C3\u00BC', '\u00FC'], // ü
  ['\u00C3\u00A1', '\u00E1'], // á
  ['\u00C3\u00A0', '\u00E0'], // à
  ['\u00C3\u00A2', '\u00E2'], // â
  ['\u00C3\u00A3', '\u00E3'], // ã
  ['\u00C3\u00A4', '\u00E4'], // ä
  ['\u00C3\u00A5', '\u00E5'], // å
  ['\u00C3\u00A6', '\u00E6'], // æ
  ['\u00C3\u00A7', '\u00E7'], // ç
  ['\u00C3\u00B8', '\u00F8'], // ø
  ['\u00C3\u00B0', '\u00F0'], // ð
  ['\u00C3\u00BE', '\u00FE'], // þ
  ['\u00C3\u00BF', '\u00FF'], // ÿ
  ['\u00C3\u009F', '\u00DF'], // ß
  // Uppercase forms.
  ['\u00C3\u0089', '\u00C9'], // É
  ['\u00C3\u0088', '\u00C8'], // È
  ['\u00C3\u008A', '\u00CA'], // Ê
  ['\u00C3\u008B', '\u00CB'], // Ë
  ['\u00C3\u008D', '\u00CD'], // Í
  ['\u00C3\u008F', '\u00CF'], // Ï
  ['\u00C3\u0091', '\u00D1'], // Ñ
  ['\u00C3\u0093', '\u00D3'], // Ó
  ['\u00C3\u0092', '\u00D2'], // Ò
  ['\u00C3\u0094', '\u00D4'], // Ô
  ['\u00C3\u0096', '\u00D6'], // Ö
  ['\u00C3\u0095', '\u00D5'], // Õ
  ['\u00C3\u009A', '\u00DA'], // Ú
  ['\u00C3\u0099', '\u00D9'], // Ù
  ['\u00C3\u009B', '\u00DB'], // Û
  ['\u00C3\u009C', '\u00DC'], // Ü
  ['\u00C3\u0081', '\u00C1'], // Á
  ['\u00C3\u0080', '\u00C0'], // À
  ['\u00C3\u0082', '\u00C2'], // Â
  ['\u00C3\u0083', '\u00C3'], // Ã
  ['\u00C3\u0084', '\u00C4'], // Ä
  ['\u00C3\u0085', '\u00C5'], // Å
  ['\u00C3\u0086', '\u00C6'], // Æ
  ['\u00C3\u0087', '\u00C7'], // Ç
  ['\u00C3\u0098', '\u00D8'], // Ø
  // Non-breaking space and symbols encoded as `Â` + character.
  ['\u00C2\u00A0', ' '],
  ['\u00C2\u00AE', '\u00AE'],
  ['\u00C2\u00A9', '\u00A9'],
  ['\u00C2\u00B0', '\u00B0'],
  ['\u00C2\u00B7', '\u00B7'],
];

const MOJIBAKE_SORTED: ReadonlyArray<readonly [string, string]> = [...MOJIBAKE].sort(
  (a, b) => b[0].length - a[0].length,
);

/** Applies literal replacements (longest first); never uses regex on the input. */
function applyLiteralReplacements(
  input: string,
  pairs: ReadonlyArray<readonly [string, string]>,
): string {
  let out = input;
  for (const [from, to] of pairs) {
    out = out.split(from).join(to);
  }
  return out;
}

/** Strips a trailing provider-hint suffix (`_pluto`, `-samsung`, `.roku`, …). */
export function stripProviderHint(text: string): string {
  let out = text;
  const match = /^(.*?)[._\-]([a-z0-9]+)$/i.exec(out);
  if (match) {
    const hint = match[2]?.toLowerCase();
    if (hint !== undefined && PROVIDER_HINTS.has(hint)) {
      out = match[1] ?? out;
    }
  }
  return out;
}

/**
 * Folds free text to a canonical comparison form: mojibake repair, NFKD,
 * combining-mark removal, lowercase, whitespace collapse and trim.
 *
 * Does NOT strip punctuation, quality tags, channel numbers or region
 * qualifiers — those belong to `normalizeChannelName`.
 */
export function foldText(value: string): string {
  if (typeof value !== 'string') {
    return '';
  }
  let out = applyLiteralReplacements(value, MOJIBAKE_SORTED);
  // A U+FFFD replacement character is an undecodable byte; it cannot be
  // recovered deterministically, so it is removed rather than guessed.
  out = out.replace(/\uFFFD/g, '');
  out = out.normalize('NFKD');
  out = out.replace(COMBINING_MARKS, '');
  out = out.toLowerCase();
  out = out.replace(/\s+/g, ' ');
  return out.trim();
}

const QUALITY_PAREN = /\(\s*(?:2160p|1080p|720p|576p|480p|360p|4k|8k|uhd|fhd|hd|sd|hevc|h\.26[45])\s*\)\s*$/i;
/** Trailing `HD`/`SD`/`FHD`/`UHD`/`4K`/`8K` word suffix, requiring a separator. */
const QUALITY_WORD = /(?:\s+|[\s(])(?:uhd|fhd|hd|sd|4k|8k)\s*\)?\s*$/i;
/** Known flag brackets only — a bracketed city/region must never be stripped. */
const FLAG_BRACKET = /\[\s*(?:geo-blocked|geo blocked|geo|not 24\/7|24\/7|not 24h|24h)\s*\]/gi;
const LEADING_NUMBER = /^\s*\d{1,4}\s*(?:[.)\-–—:·])\s*/;
const TRAILING_QUESTION = /[?]+$/;

/** True when a token is a quality/format decoration, not a region qualifier. */
function isQualityToken(token: string): boolean {
  return /^(?:2160p|1080p|720p|576p|480p|360p|4k|8k|uhd|fhd|hd|sd|hevc|h\.26[45])$/i.test(
    token.trim(),
  );
}

/** True when a bracketed token is a flag, not a region qualifier. */
function isFlagToken(token: string): boolean {
  return /^(?:geo-blocked|not 24\/7|24\/7|geo|geo blocked|geo-block)$/i.test(token.trim());
}

/**
 * Normalizes a raw channel name to a canonical comparison form.
 *
 * Strips: quality parentheses (`(1080p)`/`(720p)`/`(576p)`/`(4k)`…), bracketed
 * flags (`[Geo-blocked]`, `[Not 24/7]`), trailing `HD`/`SD`/`FHD`/`UHD`
 * suffixes, a safe leading channel number (`1. `, `01 - `) and the `?` suffix
 * observed in Free-TV names, then folds Unicode (accented Spanish, mojibake).
 *
 * Does NOT strip a city/region qualifier (e.g. `(Andalucía)`): that must stay
 * visible so a regional or local variant is never silently merged.
 */
export function normalizeChannelName(name: string): string {
  if (typeof name !== 'string') {
    return '';
  }
  let out = name;
  // Remove bracketed flag groups first (they are pure decoration).
  out = out.replace(FLAG_BRACKET, ' ');
  // Remove a trailing quality parenthesis.
  out = out.replace(QUALITY_PAREN, ' ');
  // Remove a trailing HD/SD/FHD/UHD word suffix.
  out = out.replace(QUALITY_WORD, ' ');
  // Remove a safe leading channel number (requires an explicit separator).
  out = out.replace(LEADING_NUMBER, ' ');
  // Remove the trailing `?` that Free-TV uses where accents were mangled.
  out = out.replace(TRAILING_QUESTION, ' ');
  // Provider suffixes (`_pluto`, `_samsung`) are hints, not identity.
  out = stripProviderHint(out);
  out = foldText(out);
  // If decoration removal emptied the name, fall back to folding the raw name.
  if (out === '') {
    return foldText(stripProviderHint(name));
  }
  return out;
}

/**
 * ISO 3166-1 alpha-2 → alpha-3 pairs (official set) plus `XK` (Kosovo,
 * user-assigned) which appears in the streaming corpus.
 */
const COUNTRY_PAIRS: ReadonlyArray<readonly [string, string]> = [
  'AD:AND', 'AE:ARE', 'AF:AFG', 'AG:ATG', 'AI:AIA', 'AL:ALB', 'AM:ARM', 'AO:AGO', 'AQ:ATA',
  'AR:ARG', 'AS:ASM', 'AT:AUT', 'AU:AUS', 'AW:ABW', 'AX:ALA', 'AZ:AZE', 'BA:BIH', 'BB:BRB',
  'BD:BGD', 'BE:BEL', 'BF:BFA', 'BG:BGR', 'BH:BHR', 'BI:BDI', 'BJ:BEN', 'BL:BLM', 'BM:BMU',
  'BN:BRN', 'BO:BOL', 'BQ:BES', 'BR:BRA', 'BS:BHS', 'BT:BTN', 'BV:BVT', 'BW:BWA', 'BY:BLR',
  'BZ:BLZ', 'CA:CAN', 'CC:CCK', 'CD:COD', 'CF:CAF', 'CG:COG', 'CH:CHE', 'CI:CIV', 'CK:COK',
  'CL:CHL', 'CM:CMR', 'CN:CHN', 'CO:COL', 'CR:CRI', 'CU:CUB', 'CV:CPV', 'CW:CUW', 'CX:CXR',
  'CY:CYP', 'CZ:CZE', 'DE:DEU', 'DJ:DJI', 'DK:DNK', 'DM:DMA', 'DO:DOM', 'DZ:DZA', 'EC:ECU',
  'EE:EST', 'EG:EGY', 'EH:ESH', 'ER:ERI', 'ES:ESP', 'ET:ETH', 'FI:FIN', 'FJ:FJI', 'FK:FLK',
  'FM:FSM', 'FO:FRO', 'FR:FRA', 'GA:GAB', 'GB:GBR', 'GD:GRD', 'GE:GEO', 'GF:GUF', 'GG:GGY',
  'GH:GHA', 'GI:GIB', 'GL:GRL', 'GM:GMB', 'GN:GIN', 'GP:GLP', 'GQ:GNQ', 'GR:GRC', 'GS:SGS',
  'GT:GTM', 'GU:GUM', 'GW:GNB', 'GY:GUY', 'HK:HKG', 'HM:HMD', 'HN:HND', 'HR:HRV', 'HT:HTI',
  'HU:HUN', 'ID:IDN', 'IE:IRL', 'IL:ISR', 'IM:IMN', 'IN:IND', 'IO:IOT', 'IQ:IRQ', 'IR:IRN',
  'IS:ISL', 'IT:ITA', 'JE:JEY', 'JM:JAM', 'JO:JOR', 'JP:JPN', 'KE:KEN', 'KG:KGZ', 'KH:KHM',
  'KI:KIR', 'KM:COM', 'KN:KNA', 'KP:PRK', 'KR:KOR', 'KW:KWT', 'KY:CYM', 'KZ:KAZ', 'LA:LAO',
  'LB:LBN', 'LC:LCA', 'LI:LIE', 'LK:LKA', 'LR:LBR', 'LS:LSO', 'LT:LTU', 'LU:LUX', 'LV:LVA',
  'LY:LBY', 'MA:MAR', 'MC:MCO', 'MD:MDA', 'ME:MNE', 'MF:MAF', 'MG:MDG', 'MH:MHL', 'MK:MKD',
  'ML:MLI', 'MM:MMR', 'MN:MNG', 'MO:MAC', 'MP:MNP', 'MQ:MTQ', 'MR:MRT', 'MS:MSR', 'MT:MLT',
  'MU:MUS', 'MV:MDV', 'MW:MWI', 'MX:MEX', 'MY:MYS', 'MZ:MOZ', 'NA:NAM', 'NC:NCL', 'NE:NER',
  'NF:NFK', 'NG:NGA', 'NI:NIC', 'NL:NLD', 'NO:NOR', 'NP:NPL', 'NR:NRU', 'NU:NIU', 'NZ:NZL',
  'OM:OMN', 'PA:PAN', 'PE:PER', 'PF:PYF', 'PG:PNG', 'PH:PHL', 'PK:PAK', 'PL:POL', 'PM:SPM',
  'PN:PCN', 'PR:PRI', 'PS:PSE', 'PT:PRT', 'PW:PLW', 'PY:PRY', 'QA:QAT', 'RE:REU', 'RO:ROU',
  'RS:SRB', 'RU:RUS', 'RW:RWA', 'SA:SAU', 'SB:SLB', 'SC:SYC', 'SD:SDN', 'SE:SWE', 'SG:SGP',
  'SH:SHN', 'SI:SVN', 'SJ:SJM', 'SK:SVK', 'SL:SLE', 'SM:SMR', 'SN:SEN', 'SO:SOM', 'SR:SUR',
  'SS:SSD', 'ST:STP', 'SV:SLV', 'SX:SXM', 'SY:SYR', 'SZ:SWZ', 'TC:TCA', 'TD:TCD', 'TF:ATF',
  'TG:TGO', 'TH:THA', 'TJ:TJK', 'TK:TKL', 'TL:TLS', 'TM:TKM', 'TN:TUN', 'TO:TON', 'TR:TUR',
  'TT:TTO', 'TV:TUV', 'TW:TWN', 'TZ:TZA', 'UA:UKR', 'UG:UGA', 'UM:UMI', 'US:USA', 'UY:URY',
  'UZ:UZB', 'VA:VAT', 'VC:VCT', 'VE:VEN', 'VG:VGB', 'VI:VIR', 'VN:VNM', 'VU:VUT', 'WF:WLF',
  'WS:WSM', 'YE:YEM', 'YT:MYT', 'ZA:ZAF', 'ZM:ZMB', 'ZW:ZWE', 'XK:XXK',
].map((pair) => pair.split(':') as [string, string]);

const ALPHA2 = new Set(COUNTRY_PAIRS.map(([alpha2]) => alpha2));
const ALPHA3_TO_A2: Record<string, string> = Object.fromEntries(
  COUNTRY_PAIRS.map(([alpha2, alpha3]) => [alpha3, alpha2]),
);

/**
 * Curated country-name aliases (English / Spanish / Catalan, plus common
 * shorthands). Pipe-separated per row; folded into lookup keys at module load.
 * This is an alias set, not the exhaustive code table above: an unknown name
 * returns `null` and is never guessed.
 */
const COUNTRY_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['ES', 'Spain|España|Espanya|Espana|Kingdom of Spain|Reino de España|Regne d’Espanya'],
  ['US', 'United States|United States of America|Estados Unidos|Estats Units|America|USA|United States of America'],
  ['GB', 'United Kingdom|Great Britain|Reino Unido|Regne Unit|UK|Britain|Bretanya|England|Escocia|Scotland|Wales|Gales'],
  ['XK', 'Kosovo|Kósovo|Kosova|República de Kosovo|Republic of Kosovo'],
  ['AD', 'Andorra|Principat d’Andorra|Principado de Andorra|Principality of Andorra'],
  ['AR', 'Argentina|República Argentina|Argentine Republic'],
  ['AU', 'Australia|Austràlia|Australia'],
  ['AT', 'Austria|Austria|Àustria'],
  ['BE', 'Belgium|Bélgica|Bèlgica|Belgique'],
  ['BO', 'Bolivia|Bolívia|Estado Plurinacional de Bolivia'],
  ['BR', 'Brazil|Brasil|Brasil'],
  ['CA', 'Canada|Canadá|Canadà|Canada'],
  ['CL', 'Chile|Chile|Xile'],
  ['CN', 'China|China|Xina'],
  ['CO', 'Colombia|Colombia|Colòmbia'],
  ['CR', 'Costa Rica|Costa Rica|Costa Rica'],
  ['CU', 'Cuba|Cuba|Cuba'],
  ['CY', 'Cyprus|Chipre|Xipre'],
  ['CZ', 'Czechia|Czech Republic|Chequia|República Checa|Txèquia|República Txeca'],
  ['DE', 'Germany|Alemania|Alemanya|Deutschland'],
  ['DK', 'Denmark|Dinamarca|Dinamarca'],
  ['DO', 'Dominican Republic|República Dominicana|República Dominicana'],
  ['EC', 'Ecuador|Ecuador|Equador'],
  ['EG', 'Egypt|Egipto|Egipte'],
  ['FI', 'Finland|Finlandia|Finlàndia'],
  ['FR', 'France|Francia|França|Francia'],
  ['GR', 'Greece|Grecia|Grècia'],
  ['GT', 'Guatemala|Guatemala|Guatemala'],
  ['HN', 'Honduras|Honduras|Hondures'],
  ['HR', 'Croatia|Croacia|Croàcia'],
  ['HU', 'Hungary|Hungría|Hongria'],
  ['IE', 'Ireland|Irlanda|Irlanda|Éire'],
  ['IL', 'Israel|Israel|Israel'],
  ['IN', 'India|India|Índia'],
  ['IS', 'Iceland|Islandia|Islàndia'],
  ['IT', 'Italy|Italia|Itàlia|Italia'],
  ['JP', 'Japan|Japón|Japó'],
  ['KR', 'South Korea|Corea del Sur|Corea del Sud|Korea'],
  ['LT', 'Lithuania|Lituania|Lituània'],
  ['LU', 'Luxembourg|Luxemburgo|Luxemburg'],
  ['LV', 'Latvia|Letonia|Letònia'],
  ['MA', 'Morocco|Marruecos|Marroc'],
  ['MC', 'Monaco|Mónaco|Mònaco'],
  ['MD', 'Moldova|Moldavia|Moldàvia'],
  ['ME', 'Montenegro|Montenegro|Montenegro'],
  ['MK', 'North Macedonia|Macedonia del Norte|Macedònia del Nord|Macedonia'],
  ['MT', 'Malta|Malta|Malta'],
  ['MX', 'Mexico|México|Mèxic|Mexico|Mejico'],
  ['NI', 'Nicaragua|Nicaragua|Nicaragua'],
  ['NL', 'Netherlands|Países Bajos|Països Baixos|Holland|Holanda'],
  ['NO', 'Norway|Noruega|Noruega'],
  ['NZ', 'New Zealand|Nueva Zelanda|Nova Zelanda'],
  ['PA', 'Panama|Panamá|Panamà|Panama'],
  ['PE', 'Peru|Perú|Peru|Peru'],
  ['PL', 'Poland|Polonia|Polònia'],
  ['PR', 'Puerto Rico|Puerto Rico|Puerto Rico'],
  ['PT', 'Portugal|Portugal|Portugal'],
  ['PY', 'Paraguay|Paraguay|Paraguai'],
  ['RO', 'Romania|Rumania|Rumanía|Romania|Romania'],
  ['RS', 'Serbia|Serbia|Sèrbia'],
  ['RU', 'Russia|Rusia|Rússia'],
  ['SE', 'Sweden|Suecia|Suècia'],
  ['SI', 'Slovenia|Eslovenia|Eslovènia'],
  ['SK', 'Slovakia|Eslovaquia|Eslovàquia'],
  ['SV', 'El Salvador|El Salvador|El Salvador'],
  ['TR', 'Turkey|Turquía|Turquia|Türkiye'],
  ['TW', 'Taiwan|Taiwán|Taiwan|Taiwan'],
  ['UA', 'Ukraine|Ucrania|Ucraïna'],
  ['UY', 'Uruguay|Uruguay|Uruguai'],
  ['VE', 'Venezuela|Venezuela|Veneçuela'],
  ['ZA', 'South Africa|Sudáfrica|Sud-àfrica'],
  ['CH', 'Switzerland|Suiza|Suïssa|Suisse'],
];

const COUNTRY_NAME_TO_A2: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [alpha2, names] of COUNTRY_NAMES) {
    for (const name of names.split('|')) {
      const key = foldText(name);
      if (key !== '') {
        map[key] = alpha2;
      }
    }
  }
  return map;
})();

/**
 * Normalizes a country input to ISO 3166-1 alpha-2 (uppercase) or `null`.
 *
 * Accepts alpha-2 (`ES`, `es`), alpha-3 (`ESP`), and English/Spanish/Catalan
 * names (`Spain`, `España`, `Espanya`). Returns `null` for unknown values —
 * it never guesses and never invents a country.
 */
export function normalizeCountry(input: string | null | undefined): string | null {
  if (typeof input !== 'string') {
    return null;
  }
  const value = input.trim();
  if (value === '') {
    return null;
  }
  const upper = value.toUpperCase();
  if (ALPHA2.has(upper)) {
    return upper;
  }
  const viaAlpha3 = ALPHA3_TO_A2[upper];
  if (viaAlpha3 !== undefined) {
    return viaAlpha3;
  }
  const folded = foldText(value);
  if (folded === '') {
    return null;
  }
  return COUNTRY_NAME_TO_A2[folded] ?? null;
}

/** ISO 639-1 primary codes we recognize; unknown codes return `null`. */
const LANGUAGE_CODES = new Set(
  'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'.split(
    ' ',
  ),
);

/** ISO 639-2/3 → ISO 639-1 (common catalogue languages). */
const LANGUAGE_3_TO_1: Record<string, string> = {
  spa: 'es', eng: 'en', cat: 'ca', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de',
  ita: 'it', por: 'pt', nld: 'nl', dut: 'nl', glg: 'gl', eus: 'eu', baq: 'eu',
  ron: 'ro', rum: 'ro', ell: 'el', gre: 'el', pol: 'pl', rus: 'ru', ukr: 'uk',
  tur: 'tr', ara: 'ar', zho: 'zh', chi: 'zh', jpn: 'ja', kor: 'ko', hin: 'hi',
  ben: 'bn', urd: 'ur', ces: 'cs', cze: 'cs', slk: 'sk', slo: 'sk', hrv: 'hr',
  srp: 'sr', bul: 'bg', dan: 'da', fin: 'fi', swe: 'sv', nor: 'no', hun: 'hu',
};

/** English/Spanish/Catalan language names → ISO 639-1 primary. */
const LANGUAGE_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['Spanish|Español|Espanol|Castellano|Castellà|Castella', 'es'],
  ['English|Inglés|Ingles|Anglès|Angles', 'en'],
  ['Catalan|Català|Catala|Valencian|Valencià|Valenciano|Valencia', 'ca'],
  ['French|Francés|Frances|Français|Francès', 'fr'],
  ['German|Alemán|Aleman|Alemany|Deutsch', 'de'],
  ['Portuguese|Portugués|Portugues|Português|Portuguès', 'pt'],
  ['Italian|Italiano|Italià|Italia', 'it'],
  ['Galician|Gallego|Galego|Gallegu', 'gl'],
  ['Basque|Euskera|Euskara|Vasco|Vasc', 'eu'],
  ['Dutch|Neerlandés|Neerlandes|Neerlandès|Holandés', 'nl'],
  ['Greek|Griego|Grec', 'el'],
  ['Russian|Ruso|Rus', 'ru'],
  ['Arabic|Árabe|Arab|Àrab', 'ar'],
];

const LANGUAGE_NAME_TO_1: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [names, code] of LANGUAGE_NAMES) {
    for (const name of names.split('|')) {
      const key = foldText(name);
      if (key !== '') {
        map[key] = code;
      }
    }
  }
  return map;
})();

/**
 * Normalizes a language input to a lowercase BCP-47 primary subtag or `null`.
 *
 * Accepts primary subtags (`es`), full tags (`es-ES`, `es_ES`), ISO 639-2/3
 * codes (`spa`) and English/Spanish/Catalan names (`Spanish`, `Español`).
 * Returns `null` for unknown values instead of guessing.
 */
export function normalizeLanguage(input: string | null | undefined): string | null {
  if (typeof input !== 'string') {
    return null;
  }
  const value = input.trim();
  if (value === '') {
    return null;
  }
  const primary = /^([a-z]{2,3})(?:[-_].*)?$/.exec(value.toLowerCase())?.[1];
  const folded = foldText(value);
  const byName = folded === '' ? undefined : LANGUAGE_NAME_TO_1[folded];
  if (byName !== undefined) {
    return byName;
  }
  if (primary !== undefined) {
    if (LANGUAGE_CODES.has(primary)) {
      return primary;
    }
    const via3 = LANGUAGE_3_TO_1[primary];
    if (via3 !== undefined) {
      return via3;
    }
  }
  return null;
}

/**
 * Builds the stable reconciliation key `cc:normalizedname` (e.g. `es:la-1`).
 *
 * `country` is folded through `normalizeCountry`; a `null` country produces an
 * empty prefix (`:name`). The name is re-folded (idempotent) and internal
 * whitespace becomes `-`, so the same logical name always yields one key.
 */
export function identityKey(country: string | null, normalizedName: string): string {
  const cc = normalizeCountry(country)?.toLowerCase() ?? '';
  const name = foldText(stripProviderHint(normalizedName)).replace(/\s+/g, '-');
  return `${cc}:${name}`;
}
