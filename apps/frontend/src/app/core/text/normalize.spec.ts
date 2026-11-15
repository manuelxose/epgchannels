import { describe, expect, it } from 'vitest';
import { matchesQuery, normalizeForSearch, searchForms, slugify, uniqueId } from './normalize';

/** What the catalogue search index stores for a channel. */
const index = (name: string): string => searchForms(normalizeForSearch(name)).join(' ');

describe('normalizeForSearch', () => {
  it('lowercases and strips accents', () => {
    expect(normalizeForSearch('Aragón')).toBe('aragon');
    expect(normalizeForSearch('Illes Balears')).toBe('illes balears');
    expect(normalizeForSearch('3CatInfo')).toBe('3catinfo');
  });

  it('collapses punctuation and whitespace', () => {
    expect(normalizeForSearch('  La  1 !! ')).toBe('la 1');
    expect(normalizeForSearch('Boing-2')).toBe('boing 2');
    expect(normalizeForSearch('RTL 102.5 Bro&Sis Italia')).toBe('rtl 102 5 bro sis italia');
  });

  it('is stable for empty and symbol-only input', () => {
    expect(normalizeForSearch('')).toBe('');
    expect(normalizeForSearch('***')).toBe('');
  });
});

describe('slugify', () => {
  it('produces url-safe identifiers', () => {
    expect(slugify('La 1')).toBe('la-1');
    expect(slugify('Demo 24 Horas')).toBe('demo-24-horas');
    expect(slugify('C. de Madrid')).toBe('c-de-madrid');
    expect(slugify('¡Qué noche!')).toBe('que-noche');
  });
});

describe('uniqueId', () => {
  it('returns the base slug when free', () => {
    expect(uniqueId('Nuevo Canal', new Set())).toBe('nuevo-canal');
  });

  it('appends an incrementing suffix on collision', () => {
    expect(uniqueId('Nuevo Canal', new Set(['nuevo-canal']))).toBe('nuevo-canal-2');
    expect(uniqueId('Nuevo Canal', new Set(['nuevo-canal', 'nuevo-canal-2']))).toBe('nuevo-canal-3');
  });

  it('never yields an empty id', () => {
    expect(uniqueId('!!!', new Set())).toBe('canal');
  });
});

describe('searchForms', () => {
  it('keeps the original tokens and adds contiguous glued runs', () => {
    expect(searchForms('la 1')).toEqual(['la', '1', 'la1']);
    expect(searchForms('canal sur andalucia')).toEqual([
      'canal',
      'sur',
      'andalucia',
      'canalsur',
      'canalsurandalucia',
      'surandalucia',
    ]);
  });

  it('has no forms for empty text', () => {
    expect(searchForms('')).toEqual([]);
  });
});

describe('matchesQuery', () => {
  it('matches every token regardless of order', () => {
    expect(matchesQuery(index('Demo 24 Horas'), 'horas demo')).toBe(true);
    expect(matchesQuery(index('Demo 24 Horas'), '24h')).toBe(true);
  });

  it('matches everything for an empty query', () => {
    expect(matchesQuery(index('cualquier cosa'), '')).toBe(true);
    expect(matchesQuery('', '')).toBe(true);
  });

  it('matches a multi-token channel name from a single-token query (P1)', () => {
    expect(index('La 1')).toContain('la1');
    expect(matchesQuery(index('La 1'), normalizeForSearch('la1'))).toBe(true);
    expect(matchesQuery(index('La 1'), normalizeForSearch('La 1'))).toBe(true);
    expect(matchesQuery(index('La 2'), normalizeForSearch('la2'))).toBe(true);
    expect(matchesQuery(index('Demo 24 Horas'), normalizeForSearch('24horas'))).toBe(true);
  });

  it('matches a single-token channel name from a multi-token query (P1)', () => {
    expect(matchesQuery(index('La1'), normalizeForSearch('la 1'))).toBe(true);
    expect(matchesQuery(index('La1'), normalizeForSearch('la1'))).toBe(true);
    // digit/digit splits cannot be resolved without the separator ('3' + 'c' + 'at')
    expect(matchesQuery(index('3CatInfo'), normalizeForSearch('3cat'))).toBe(true);
  });

  it('keeps accents and punctuation insensitive', () => {
    expect(matchesQuery(index('La 1 Aragón'), normalizeForSearch('aragon'))).toBe(true);
    expect(matchesQuery(index('La 1 Aragón'), normalizeForSearch('la1 aragon'))).toBe(true);
    expect(matchesQuery(index('Canal Sur Andalucía'), normalizeForSearch('canalsur'))).toBe(true);
    expect(matchesQuery(index('Canal Sur Andalucía'), normalizeForSearch('canal sur and'))).toBe(true);
    expect(matchesQuery(index('¡Qué noche!'), normalizeForSearch('que'))).toBe(true);
  });

  it('does not match absent tokens or foreign channels', () => {
    expect(matchesQuery(index('Demo 24 Horas'), 'diarios')).toBe(false);
    expect(matchesQuery(index('La 1'), normalizeForSearch('la 2'))).toBe(false);
    expect(matchesQuery(index('Demo 24 Horas'), 'canal sur')).toBe(false);
    expect(matchesQuery('', 'la1')).toBe(false);
  });
});
