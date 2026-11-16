/**
 * Normalisation invariants: folding, channel-name decoration removal, country
 * and language normalisation, and the stable identity key.
 */
import { describe, expect, it } from 'vitest';
import {
  foldText,
  identityKey,
  normalizeChannelName,
  normalizeCountry,
  normalizeLanguage,
  stripProviderHint,
} from './normalize.js';

describe('foldText', () => {
  it('folds accented Spanish to lowercase ASCII', () => {
    expect(foldText('España')).toBe('espana');
    expect(foldText('Càmeres')).toBe('cameres');
    expect(foldText('Canal Sur')).toBe('canal sur');
  });

  it('collapses internal whitespace and trims', () => {
    expect(foldText('  Canal   SUR  ')).toBe('canal sur');
  });

  it('repairs common UTF-8/Latin-1 mojibake deterministically', () => {
    expect(foldText('EspaÃ±a')).toBe('espana');
    expect(foldText('CÃ³rdoba')).toBe('cordoba');
  });

  it('drops an undecodable replacement character without guessing', () => {
    expect(foldText('C\uFFFDmeres')).toBe('cmeres');
  });
});

describe('normalizeChannelName', () => {
  it('strips quality parentheses', () => {
    expect(normalizeChannelName('La 1 (1080p)')).toBe('la 1');
    expect(normalizeChannelName('La 1 (720p)')).toBe('la 1');
    expect(normalizeChannelName('La 1 (576p)')).toBe('la 1');
  });

  it('strips known flag brackets', () => {
    expect(normalizeChannelName('Canal [Geo-blocked]')).toBe('canal');
    expect(normalizeChannelName('Canal [Not 24/7]')).toBe('canal');
  });

  it('strips HD/SD/FHD/UHD suffixes', () => {
    expect(normalizeChannelName('Canal HD')).toBe('canal');
    expect(normalizeChannelName('Canal SD')).toBe('canal');
    expect(normalizeChannelName('Canal FHD')).toBe('canal');
    expect(normalizeChannelName('Canal UHD')).toBe('canal');
  });

  it('strips a safe leading channel number but keeps numeric names', () => {
    expect(normalizeChannelName('1. La 1')).toBe('la 1');
    expect(normalizeChannelName('01 - La 1')).toBe('la 1');
    // "24 Horas" is a name, not a channel number.
    expect(normalizeChannelName('24 Horas')).toBe('24 horas');
  });

  it('strips the Free-TV trailing `?`', () => {
    expect(normalizeChannelName('La 1?')).toBe('la 1');
  });

  it('never strips a city/region qualifier', () => {
    expect(normalizeChannelName('Canal Sur (Andalucía)')).toContain('andalucia');
    expect(normalizeChannelName('Canal [Córdoba]')).toContain('cordoba');
  });

  it('strips a provider-hint suffix (hint, not identity)', () => {
    expect(normalizeChannelName('Cine_pluto')).toBe(normalizeChannelName('Cine'));
    expect(normalizeChannelName('Cine_samsung')).toBe('cine');
  });
});

describe('normalizeCountry', () => {
  const table: ReadonlyArray<readonly [string | null | undefined, string | null]> = [
    ['ES', 'ES'],
    ['es', 'ES'],
    ['Spain', 'ES'],
    ['España', 'ES'],
    ['ESP', 'ES'],
    ['Espanya', 'ES'],
    ['United States', 'US'],
    ['US', 'US'],
    ['UK', 'GB'],
    ['GB', 'GB'],
    ['XK', 'XK'],
  ];

  for (const [input, expected] of table) {
    it(`normalizes ${JSON.stringify(input)} -> ${expected}`, () => {
      expect(normalizeCountry(input)).toBe(expected);
    });
  }

  it('returns null for unknown values instead of guessing', () => {
    expect(normalizeCountry('Atlantis')).toBeNull();
    expect(normalizeCountry('NotACountry')).toBeNull();
    expect(normalizeCountry('INT')).toBeNull();
    expect(normalizeCountry(null)).toBeNull();
    expect(normalizeCountry(undefined)).toBeNull();
    expect(normalizeCountry('')).toBeNull();
  });
});

describe('normalizeLanguage', () => {
  it('normalizes BCP-47 primary subtags', () => {
    expect(normalizeLanguage('es')).toBe('es');
    expect(normalizeLanguage('es-ES')).toBe('es');
    expect(normalizeLanguage('es_ES')).toBe('es');
    expect(normalizeLanguage('en-US')).toBe('en');
    expect(normalizeLanguage('ca')).toBe('ca');
  });

  it('normalizes English and Spanish language names', () => {
    expect(normalizeLanguage('Spanish')).toBe('es');
    expect(normalizeLanguage('Español')).toBe('es');
    expect(normalizeLanguage('English')).toBe('en');
    expect(normalizeLanguage('Inglés')).toBe('en');
  });

  it('normalizes ISO 639-2/3 codes', () => {
    expect(normalizeLanguage('spa')).toBe('es');
    expect(normalizeLanguage('eng')).toBe('en');
  });

  it('returns null for unknown values instead of guessing', () => {
    expect(normalizeLanguage('Klingon')).toBeNull();
    expect(normalizeLanguage(null)).toBeNull();
    expect(normalizeLanguage(undefined)).toBeNull();
    expect(normalizeLanguage('')).toBeNull();
  });
});

describe('identityKey', () => {
  it('is `cc:normalizedname`', () => {
    expect(identityKey('ES', 'La 1')).toBe('es:la-1');
    expect(identityKey('ES', normalizeChannelName('La 1 (1080p)'))).toBe('es:la-1');
  });

  it('uses an empty prefix for an unknown country', () => {
    expect(identityKey(null, 'La 1')).toBe(':la-1');
  });

  it('ignores provider-hint suffixes', () => {
    expect(identityKey('US', 'Cine_pluto')).toBe(identityKey('US', 'Cine'));
  });
});

describe('stripProviderHint', () => {
  it('strips only known trailing provider hints', () => {
    expect(stripProviderHint('Cine_pluto')).toBe('Cine');
    expect(stripProviderHint('Cine_samsung')).toBe('Cine');
    expect(stripProviderHint('Cine')).toBe('Cine');
  });
});
