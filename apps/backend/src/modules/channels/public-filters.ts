/**
 * Public catalogue filters, widened to the vocabulary the catalogue really uses,
 * and multi-valued (TDT-API-02FG, ronda de filtros).
 *
 * Two things live here:
 *
 * 1. **Vocabulary.** The base contract types `country` as `countryCodeSchema`
 *    (strict ISO 3166-1 alpha-2) and `language` as `localeCodeSchema` (BCP-47).
 *    The measured live catalogue publishes `country: 'INT'` and
 *    `languageTag: 'multi'`, and the Angular client filters by exactly those
 *    values, so the strict schemas rejected a real query with 400. This widens
 *    acceptance only: every value the old schemas accepted still means the same.
 *
 * 2. **Multiple values.** `?category=a&category=b`, `?country=ES&country=FR` —
 *    and the comma form `?category=a,b`. Within one filter the values are an OR
 *    (any of these categories); different filters are an AND, which is what a
 *    person means when they pick two categories and then a country. An empty
 *    selection is "all", never "none".
 */
import { z } from 'zod';
import { channelCategorySchema, channelListQuerySchema, type ChannelCategory } from '@tdt/contracts';

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

/**
 * One filter accepting either repeated parameters or a comma-separated list.
 *
 * Returns a deduplicated array, or `undefined` when nothing (or only blanks) was
 * given — "no filter" and "filter matching nothing" must never be the same thing.
 *
 * Validation lives in `superRefine`, never in `transform`. Measured on this zod
 * release: a `ZodError` thrown from inside a transform ESCAPES `safeParse` (it is
 * a parse-time error, not a refinement result), so `safeParse` threw, the route's
 * `safeParse` branch never ran, and a malformed value surfaced as HTTP 500
 * instead of 400. `superRefine` reports through the context and is collected
 * normally; an unexpected throw there is caught and reported as an issue, so the
 * command never leaves the zod pipeline as an exception.
 */
function multiValue<T extends z.ZodType<string>>(item: T, max: number) {
  const base = z.union([z.string(), z.array(z.string())]).optional();
  const parts = (raw: unknown): string[] => {
    if (raw === undefined) return [];
    const list = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : [String(raw)];
    return list
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter((value) => value !== '');
  };
  return base
    .superRefine((raw, context) => {
      try {
        const values = [...new Set(parts(raw))];
        if (values.length > max) {
          context.addIssue({ code: 'custom', message: `Como mucho ${max} valores por filtro.` });
          return;
        }
        for (const value of values) {
          const parsed = item.safeParse(value);
          if (!parsed.success) {
            for (const issue of parsed.error.issues) context.addIssue(issue);
          }
        }
      } catch (error) {
        context.addIssue({
          code: 'custom',
          message: error instanceof Error ? error.message : 'Valor de filtro no válido.',
        });
      }
    })
    .transform((raw) => {
      const values = [...new Set(parts(raw))];
      return values.length === 0 ? undefined : values;
    });
}

/** `/channels` query: multi-valued filters over a widened catalogue vocabulary. */
export const publicChannelListQuerySchema = channelListQuerySchema
  .extend({
    country: multiValue(catalogueCountryFilterSchema, 60),
    language: multiValue(catalogueLanguageFilterSchema, 20),
    /*
     * Our taxonomy is a fixed enum. An unknown category is REJECTED (400), not
     * silently dropped: a filter that quietly matches everything is worse than an
     * error, and the integration test that guards malformed values expects 400.
     */
    category: multiValue(
      z
        .string()
        .trim()
        .refine(
          (value): value is ChannelCategory => (channelCategorySchema.options as readonly string[]).includes(value),
          'Categoría desconocida.',
        ),
      20,
    ),
    region: multiValue(z.string().trim().min(1).max(16), 30),
  })
  .transform((query) => ({
    ...query,
    /* The base schema's single values become one-element selections. */
    countries: query.country,
    languages: query.language,
    categories: query.category,
    regions: query.region,
  }));
export type PublicChannelListQuery = z.infer<typeof publicChannelListQuerySchema>;