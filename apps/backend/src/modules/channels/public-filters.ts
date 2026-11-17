/**
 * Public catalogue filters, widened to the vocabulary the catalogue really uses.
 *
 * The base contract types `country` as `countryCodeSchema` (strict ISO 3166-1
 * alpha-2) and `language` as `localeCodeSchema` (BCP-47). The measured live
 * catalogue publishes `country: 'INT'` for all 118 international channels and
 * `languageTag: 'multi'` for the same ones — and the Angular client filters by
 * exactly those values, so the strict schemas rejected a real, supported query
 * with 400 (measured before this change):
 *
 *   GET /channels?country=INT     → 400 "ISO 3166-1 alpha-2 country code"
 *   GET /channels?language=multi  → 400 "BCP-47 language tag (lowercase language)"
 *
 * This is accepts-widening only: every value the old schemas accepted is still
 * accepted with the same meaning, and both filters match the stored column
 * exactly (`country`, `languageTag`), so nothing is normalised behind the
 * caller's back. The response contracts are untouched.
 */
import { z } from 'zod';
import { channelListQuerySchema } from '@tdt/contracts';

/** The documented aggregate country code for channels outside Spain. */
export const INTERNATIONAL_COUNTRY = 'INT';

/** A catalogue country value: an ISO alpha-2 code, or the `INT` aggregate. */
export const catalogueCountryFilterSchema = z
  .string()
  .trim()
  .regex(
    /^(?:[A-Z]{2}|INT)$/,
    'ISO 3166-1 alpha-2 country code, o INT para el agregado internacional.',
  );

/**
 * A catalogue language value: a BCP-47 tag, or the coverage marker the catalogue
 * stores for channels that publish in several languages at once.
 */
export const catalogueLanguageFilterSchema = z
  .string()
  .trim()
  .regex(/^(?:[a-z]{2,3}(?:-[A-Z]{2})?|multi)$/, 'Etiqueta BCP-47 en minúsculas, o multi.');

/** `/channels` query: identical to the contract, with the two filters widened. */
export const publicChannelListQuerySchema = channelListQuerySchema.extend({
  country: catalogueCountryFilterSchema.optional(),
  language: catalogueLanguageFilterSchema.optional(),
});
export type PublicChannelListQuery = z.infer<typeof publicChannelListQuerySchema>;
