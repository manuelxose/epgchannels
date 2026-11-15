/**
 * Authentication and secret-handling primitives.
 *
 * These properties are the reason an administrative credential cannot leak into
 * a browser bundle or a database dump.
 */
import { describe, expect, it } from 'vitest';
import { createSessionToken, hashPassword, secretMatches, sha256, verifyPassword, canBootstrap } from './admin.auth.js';
import { normalizeForSearch, searchForms, searchText } from '../../shared/search.js';
import { canonicalSlug, slugify } from '../../shared/slug.js';
import { resolveRegionCode } from '../../shared/taxonomy.js';
import { isHostBlocked } from '../../infrastructure/egress.js';

describe('password hashing', () => {
  it('stores a salted scrypt hash, never the password', async () => {
    const hash = await hashPassword('Correct-Horse-Battery-9');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(hash).not.toContain('Correct-Horse');
    expect(hash.split('$')).toHaveLength(3);
  });

  it('produces a different salt for the same password', async () => {
    const a = await hashPassword('Correct-Horse-Battery-9');
    const b = await hashPassword('Correct-Horse-Battery-9');
    expect(a).not.toBe(b);
    expect(await verifyPassword('Correct-Horse-Battery-9', a)).toBe(true);
    expect(await verifyPassword('Correct-Horse-Battery-9', b)).toBe(true);
  });

  it('rejects a wrong password and a malformed hash', async () => {
    const hash = await hashPassword('Correct-Horse-Battery-9');
    expect(await verifyPassword('correct-horse-battery-9', hash)).toBe(false);
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$zz$zz')).toBe(false);
  });
});

describe('sessions', () => {
  it('never stores the usable token', () => {
    const { token, tokenSha256 } = createSessionToken();
    expect(token).not.toBe(tokenSha256);
    expect(tokenSha256).toBe(sha256(token));
    expect(tokenSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('issues a unique token per login', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => createSessionToken().token));
    expect(tokens.size).toBe(50);
  });

  it('compares secrets in constant time and rejects an unset secret', () => {
    const expected = sha256('service-key');
    expect(secretMatches('service-key', expected)).toBe(true);
    expect(secretMatches('service-kez', expected)).toBe(false);
    expect(secretMatches('service-key', undefined)).toBe(false);
  });

  it('allows bootstrap only while no administrator exists', () => {
    expect(canBootstrap(0)).toBe(true);
    expect(canBootstrap(1)).toBe(false);
  });
});

describe('slug policy', () => {
  it('derives a semantic, ASCII, lowercase slug', () => {
    expect(slugify('La 1')).toBe('la-1');
    expect(slugify('Comunitat Valenciana TV')).toBe('comunitat-valenciana-tv');
    expect(slugify('Aragón TV')).toBe('aragon-tv');
    expect(slugify('  ¿Qué?  ')).toBe('que');
  });

  it('prefers the consumer canonical slug so there is only one public URL', () => {
    expect(canonicalSlug('La 1', 'la-uno')).toBe('la-uno');
    expect(canonicalSlug('La 1')).toBe('la-1');
    expect(canonicalSlug('La 1', 'x')).toBe('la-1');
  });
});

describe('search normalisation', () => {
  it('is accent- and case-insensitive', () => {
    expect(normalizeForSearch('Aragón')).toBe('aragon');
    expect(normalizeForSearch('LA 1')).toBe('la 1');
  });

  it('indexes glued and article-free forms', () => {
    const forms = searchForms('la 1');
    expect(forms).toContain('la1');
    expect(searchText('Canal Sur', 'Andalucía')).toContain('andalucia');
  });
});

describe('regions', () => {
  it('resolves the published labels onto ISO 3166-2:ES codes', () => {
    expect(resolveRegionCode('C. de Madrid')).toBe('MD');
    expect(resolveRegionCode('C. Valenciana')).toBe('VC');
    expect(resolveRegionCode('Castilla-La Mancha')).toBe('CM');
    expect(resolveRegionCode('País Vasco')).toBe('PV');
  });

  it('returns null rather than guessing an unknown or international label', () => {
    expect(resolveRegionCode('Int. Europa')).toBeNull();
    expect(resolveRegionCode('')).toBeNull();
    expect(resolveRegionCode(undefined)).toBeNull();
  });
});

describe('egress host block list', () => {
  it('blocks a host and its subdomains, and nothing else', () => {
    const blocked = ['tdtchannels.com', '*.example.com'];
    expect(isHostBlocked('tdtchannels.com', blocked)).toBe(true);
    expect(isHostBlocked('www.tdtchannels.com', blocked)).toBe(true);
    expect(isHostBlocked('api.example.com', blocked)).toBe(true);
    expect(isHostBlocked('example.com', blocked)).toBe(true);
    expect(isHostBlocked('rtve.es', blocked)).toBe(false);
    expect(isHostBlocked('nottdtchannels.com', blocked)).toBe(false);
  });
});
