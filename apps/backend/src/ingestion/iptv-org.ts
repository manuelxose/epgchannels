/**
 * iptv-org channel database reader (TDT-API-02FG, ronda iptv-org).
 *
 * The stream playlists only carry a `tvg-id`; everything a person wants to READ
 * — the channel's real name, its country, its genre, its website — lives in
 * `iptv-org/database`'s `data/channels.csv`. This module reads that file, with no
 * network access and no database, and answers three questions the ingestion
 * needs:
 *
 * 1. Which database row belongs to a `tvg-id`? (`resolveByTvgId`)
 * 2. Is that row publishable at all? (closed, NSFW → not a catalogue entry)
 * 3. What category, per our own taxonomy, does it fall into?
 *
 * The workbook is a plain comma-separated file with quoted fields; the parser
 * below is deliberately small and strict, because a silent mis-parse here would
 * attach the wrong name (and the wrong country) to thousands of channels.
 */
import { z } from 'zod';

/** One row of `data/channels.csv`. Empty cells are `''`. */
export const databaseRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  alt_names: z.string(),
  network: z.string(),
  owners: z.string(),
  country: z.string(),
  categories: z.string(),
  is_nsfw: z.string(),
  launched: z.string(),
  closed: z.string(),
  replaced_by: z.string(),
  website: z.string(),
});
export type DatabaseRow = z.infer<typeof databaseRowSchema>;

export interface DatabaseIndex {
  readonly rows: readonly DatabaseRow[];
  /** `id` → row, keyed by the exact database id (no `@quality` suffix). */
  readonly byId: ReadonlyMap<string, DatabaseRow>;
  /** Rows that may be published: not closed, not NSFW. */
  readonly publishable: readonly DatabaseRow[];
  readonly stats: {
    readonly rows: number;
    readonly closed: number;
    readonly nsfw: number;
    readonly countries: number;
  };
}

/**
 * Parses one CSV line, honouring double quotes and the `""` escape.
 *
 * iptv-org's file has no embedded newlines, so a line-based reader is exact
 * here; this is stated rather than assumed: the parser would mis-handle a quoted
 * newline, and the reader below refuses a row whose field count does not match
 * the header instead of shifting columns silently.
 */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

/** Parses the whole file. A malformed row is reported, never guessed. */
export function parseChannelsCsv(text: string): {
  rows: DatabaseRow[];
  rejected: Array<{ line: number; reason: string }>;
} {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const header = splitCsvLine(lines[0] ?? '');
  const required = Object.keys(databaseRowSchema.shape);
  const missing = required.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new Error(`channels.csv is missing columns: ${missing.join(', ')}`);
  }
  const rows: DatabaseRow[] = [];
  const rejected: Array<{ line: number; reason: string }> = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === '') continue;
    const values = splitCsvLine(line);
    if (values.length !== header.length) {
      rejected.push({ line: index + 1, reason: `expected ${header.length} columns, got ${values.length}` });
      continue;
    }
    const record: Record<string, string> = {};
    for (let column = 0; column < header.length; column += 1) {
      record[header[column] as string] = values[column] ?? '';
    }
    const parsed = databaseRowSchema.safeParse(record);
    if (!parsed.success) {
      rejected.push({ line: index + 1, reason: parsed.error.issues[0]?.message ?? 'invalid row' });
      continue;
    }
    rows.push(parsed.data);
  }
  return { rows, rejected };
}

/** Builds the lookup index used by the ingestion. */
export function buildDatabaseIndex(rows: readonly DatabaseRow[]): DatabaseIndex {
  const byId = new Map<string, DatabaseRow>();
  for (const row of rows) byId.set(row.id, row);
  const publishable = rows.filter((row) => !isClosed(row) && !isNsfw(row));
  return {
    rows,
    byId,
    publishable,
    stats: {
      rows: rows.length,
      closed: rows.filter(isClosed).length,
      nsfw: rows.filter(isNsfw).length,
      countries: new Set(rows.map((row) => row.country).filter((code) => code !== '')).size,
    },
  };
}

/**
 * `tvg-id` → database id. iptv-org writes qualities as `Name.cc@SD`, while the
 * database key is `Name.cc`; the suffix is the only difference, and a `tvg-id`
 * that already matches is accepted as is.
 */
export function resolveByTvgId(index: DatabaseIndex, tvgId: string): DatabaseRow | null {
  const trimmed = tvgId.trim();
  if (trimmed === '') return null;
  const exact = index.byId.get(trimmed);
  if (exact !== undefined) return exact;
  const at = trimmed.indexOf('@');
  const base = at === -1 ? trimmed : trimmed.slice(0, at);
  return index.byId.get(base) ?? null;
}

export function isClosed(row: Pick<DatabaseRow, 'closed'>): boolean {
  return row.closed.trim() !== '';
}

export function isNsfw(row: Pick<DatabaseRow, 'is_nsfw'>): boolean {
  return row.is_nsfw.trim().toUpperCase() === 'TRUE';
}

/** ISO 3166-1 alpha-2 in upper case, or `null` when the database has no country. */
export function countryOf(row: Pick<DatabaseRow, 'country'>): string | null {
  const code = row.country.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/**
 * iptv-org categories → our taxonomy.
 *
 * The mapping is explicit: a category we do not know falls to `otros` instead of
 * being guessed from the name. `general` is our `generalista`, and the several
 * sport/news styles collapse to the two editorial categories we actually use.
 */
const CATEGORY_MAP: Readonly<Record<string, string>> = {
  general: 'generalista',
  news: 'informativos',
  sports: 'deportes',
  kids: 'infantil',
  music: 'musica',
  culture: 'cultura',
  education: 'cultura',
  documentary: 'documentales',
  movies: 'cine-series',
  series: 'cine-series',
  entertainment: 'entretenimiento',
  religion: 'religion',
  local: 'local',
  auto: 'otros',
  shop: 'otros',
  business: 'otros',
  comedy: 'entretenimiento',
  lifestyle: 'entretenimiento',
  travel: 'otros',
  weather: 'informativos',
  science: 'documentales',
  cooking: 'entretenimiento',
  family: 'entretenimiento',
  reality: 'entretenimiento',
};

/** The first category we understand, mapped to our taxonomy; `otros` otherwise. */
export function categoryOf(row: Pick<DatabaseRow, 'categories'>): string {
  for (const raw of row.categories.split(';')) {
    const mapped = CATEGORY_MAP[raw.trim().toLowerCase()];
    if (mapped !== undefined) return mapped;
  }
  return 'otros';
}

/** True when the row declares at least one category we map. */
export function hasKnownCategory(row: Pick<DatabaseRow, 'categories'>): boolean {
  return row.categories
    .split(';')
    .some((raw) => CATEGORY_MAP[raw.trim().toLowerCase()] !== undefined);
}

/** Primary language tag when iptv-org declares one (`[,language]`), else null. */
export function languageOf(attributes: Readonly<Record<string, string>>): string | null {
  const declared = (attributes['tvg-language'] ?? '').trim();
  if (declared === '') return null;
  const first = declared.split(',')[0]?.trim() ?? '';
  return first === '' ? null : first.toLowerCase();
}
