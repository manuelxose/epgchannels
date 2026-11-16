/**
 * Stable slug invariants: lowercase ASCII, ≤ 120 characters, deterministic and
 * order-independent collision suffixing.
 */
import { describe, expect, it } from 'vitest';
import { assignSlugs, slugify, uniqueSlug } from './slug.js';

describe('slugify', () => {
  it('produces lowercase ASCII and strips accents', () => {
    expect(slugify('La 1')).toBe('la-1');
    expect(slugify('España')).toBe('espana');
    expect(slugify('Canal Ñuño')).toBe('canal-nuno');
  });

  it('never exceeds 120 characters', () => {
    const long = `${'a'.repeat(300)} Canal`;
    expect(slugify(long).length).toBeLessThanOrEqual(120);
    expect(slugify(long)).toMatch(/^[a-z0-9-]*$/);
  });

  it('returns a plain ASCII slug for punctuation-heavy names', () => {
    expect(slugify('Canal Sur!')).toBe('canal-sur');
    expect(slugify('Canal Sur?')).toBe('canal-sur');
  });
});

describe('uniqueSlug', () => {
  it('returns the base slug when there is no collision', () => {
    expect(uniqueSlug('Canal Sur', new Set())).toBe('canal-sur');
  });

  it('appends a deterministic suffix on collision', () => {
    const first = uniqueSlug('Canal Sur!', new Set());
    const second = uniqueSlug('Canal Sur?', new Set([first]));
    expect(first).toBe('canal-sur');
    expect(second).toMatch(/^canal-sur-[0-9a-f]{8}$/);
    expect(second.length).toBeLessThanOrEqual(120);
  });

  it('is independent of the order in which names are processed', () => {
    const names = ['Canal Sur!', 'Canal Sur?', 'Canal Sur#'];
    const forward = assignSlugs(names);
    const reversed = assignSlugs([...names].reverse());
    expect(forward).toEqual(reversed);
    // Every name still receives a distinct slug.
    expect(new Set(forward.values()).size).toBe(names.length);
  });

  it('derives the collision suffix from the name, not from position', () => {
    const taken = new Set(['canal-sur']);
    const a = uniqueSlug('Canal Sur?', taken);
    const b = uniqueSlug('Canal Sur?', taken);
    expect(a).toBe(b);
    expect(a).toMatch(/^canal-sur-[0-9a-f]{8}$/);
  });
});
