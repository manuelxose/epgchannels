/**
 * Canonical domain taxonomy and region table.
 *
 * These are our own editorial decisions. The region codes are ISO 3166-2:ES
 * subdivisions because that is a published, citable standard, not a private
 * naming scheme.
 */

import type { ChannelCategory, ChannelKind } from '@tdt/contracts';

export const CATEGORY_LABELS: Readonly<Record<ChannelCategory, string>> = {
  generalista: 'Generalistas',
  informativos: 'Informativos',
  deportes: 'Deportes',
  infantil: 'Infantiles',
  musica: 'Música',
  cultura: 'Cultura',
  'cine-series': 'Cine y series',
  documentales: 'Documentales',
  entretenimiento: 'Entretenimiento',
  religion: 'Religiosos',
  local: 'Locales',
  autonomica: 'Autonómicas',
  internacional: 'Internacionales',
  otros: 'Otros',
};

export const CATEGORY_ORDER: readonly ChannelCategory[] = [
  'generalista',
  'informativos',
  'deportes',
  'infantil',
  'musica',
  'cultura',
  'cine-series',
  'documentales',
  'entretenimiento',
  'religion',
  'local',
  'autonomica',
  'internacional',
  'otros',
];

export const KIND_LABELS: Readonly<Record<ChannelKind, string>> = {
  linear: 'Lineal',
  online: 'Solo internet',
  eventual: 'Emisión eventual',
  'guide-only': 'Solo guía',
};

export interface RegionDefinition {
  /** ISO 3166-1 alpha-2 country. */
  readonly country: string;
  /** ISO 3166-2 subdivision code without the country prefix (`MD`, `CT`, …). */
  readonly code: string;
  readonly name: string;
}

/**
 * Spanish autonomous communities and cities, ISO 3166-2:ES.
 * `INTL` is the documented aggregate for channels without a Spanish region.
 */
export const SPAIN_REGIONS: readonly RegionDefinition[] = [
  { country: 'ES', code: 'AN', name: 'Andalucía' },
  { country: 'ES', code: 'AR', name: 'Aragón' },
  { country: 'ES', code: 'AS', name: 'Principado de Asturias' },
  { country: 'ES', code: 'CB', name: 'Cantabria' },
  { country: 'ES', code: 'CE', name: 'Ceuta' },
  { country: 'ES', code: 'CL', name: 'Castilla y León' },
  { country: 'ES', code: 'CM', name: 'Castilla-La Mancha' },
  { country: 'ES', code: 'CN', name: 'Canarias' },
  { country: 'ES', code: 'CT', name: 'Cataluña' },
  { country: 'ES', code: 'EX', name: 'Extremadura' },
  { country: 'ES', code: 'GA', name: 'Galicia' },
  { country: 'ES', code: 'IB', name: 'Illes Balears' },
  { country: 'ES', code: 'MC', name: 'Región de Murcia' },
  { country: 'ES', code: 'MD', name: 'Comunidad de Madrid' },
  { country: 'ES', code: 'ML', name: 'Melilla' },
  { country: 'ES', code: 'NC', name: 'Comunidad Foral de Navarra' },
  { country: 'ES', code: 'PV', name: 'País Vasco' },
  { country: 'ES', code: 'RI', name: 'La Rioja' },
  { country: 'ES', code: 'VC', name: 'Comunitat Valenciana' },
];

const REGION_BY_NORMALISED_NAME = new Map<string, RegionDefinition>(
  SPAIN_REGIONS.map((region) => [normalizeRegionName(region.name), region]),
);

/** Extra spellings found in operational notes, mapped to the ISO region. */
const REGION_SYNONYMS: Readonly<Record<string, string>> = {
  'c madrid': 'MD',
  'comunidad de madrid': 'MD',
  madrid: 'MD',
  'c valenciana': 'VC',
  'comunidad valenciana': 'VC',
  valencia: 'VC',
  'comunidad foral de navarra': 'NC',
  'c foral de navarra': 'NC',
  navarra: 'NC',
  'principado de asturias': 'AS',
  'p de asturias': 'AS',
  asturias: 'AS',
  'region de murcia': 'MC',
  'r de murcia': 'MC',
  murcia: 'MC',
  'illes balears': 'IB',
  baleares: 'IB',
  'pais vasco': 'PV',
  euskadi: 'PV',
  cataluna: 'CT',
  'castilla la mancha': 'CM',
  'la rioja': 'RI',
  galicia: 'GA',
  andalucia: 'AN',
  aragon: 'AR',
  canarias: 'CN',
  cantabria: 'CB',
  'castilla y leon': 'CL',
  extremadura: 'EX',
  ceuta: 'CE',
  melilla: 'ML',
};

/**
 * Folds a region label to its comparison key: lowercase, no diacritics, and the
 * administrative abbreviations written both with and without their dot
 * (C. de Madrid / C de Madrid) become the same key.
 */
function normalizeRegionName(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolves a free-text region label to an ISO 3166-2:ES code, or null. */
export function resolveRegionCode(label: string | undefined): string | null {
  if (!label) return null;
  const normalized = normalizeRegionName(label);
  if (!normalized) return null;
  const direct = REGION_BY_NORMALISED_NAME.get(normalized);
  if (direct) return direct.code;
  // Administrative abbreviations ("C.", "P.", "R.", "C. Foral de") are written
  // with a dot or a space across sources; after this fold both read the same.
  const alias = REGION_SYNONYMS[normalized];
  if (alias) return alias;
  const collapsed = normalized.replace(/\bc\b/g, 'comunidad').replace(/\bp\b/g, 'principado').replace(/\br\b/g, 'region');
  const collapsedAlias = REGION_SYNONYMS[collapsed];
  return collapsedAlias ?? null;
}

export function regionByCode(code: string): RegionDefinition | undefined {
  return SPAIN_REGIONS.find((region) => region.code === code);
}

/** Region slugs used in admin/filters (`comunidad-de-madrid`). */
export function regionSlug(region: RegionDefinition): string {
  return `${region.country}-${region.code}`.toLowerCase();
}
