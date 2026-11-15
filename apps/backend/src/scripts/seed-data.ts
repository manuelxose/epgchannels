/**
 * Compiled-in seed data: facts, not content.
 *
 * Only identifiers and licence facts live here, so `migrate` can register the
 * editorial guide source on a fresh database without any external file.
 */

export const EPG_SOURCE_SEED = {
  id: '00000000-0000-4000-8000-00000000e001',
  name: 'Redacción TDT Platform',
  kind: 'editorial',
  licence: 'editorial',
  attribution: 'Programación introducida por la redacción de TDT Platform a partir de fuentes oficiales citadas.',
} as const;
