/**
 * Catalogue aggregation: the counts the public international surface publishes.
 *
 * Every count here is produced by MongoDB (`$match` on the indexed published
 * filter, then `$group`), never by loading the collection into memory. That is a
 * requirement, not a preference: the catalogue is the collection that grows with
 * the number of channels, and these endpoints answer on every catalogue load.
 *
 * The public predicate is exactly the one `ChannelsService.buildFilter` applies —
 * published and not merged into another record — so these counts and the
 * `/channels` listing can never disagree.
 *
 * One count is not a stored column: `playable`. Playback status is *derived*
 * (authorization → compatibility → health → quality) by `PlaybackService`, so it
 * is computed with that same service over bounded id batches. Channel documents
 * are only ever loaded for a batch that already matched the indexed filter, never
 * for the whole catalogue at once.
 */
import type {
  CountryEntry,
} from '@tdt/contracts';
import { attributionSchema, countryEntrySchema } from '@tdt/contracts';
import { z } from 'zod';
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { ChannelDoc } from '../../infrastructure/schema.js';
import { SPAIN_REGIONS, regionByCode } from '../../shared/taxonomy.js';
import type { PlaybackService } from '../playback/playback.service.js';
import { INTERNATIONAL_COUNTRY_CODE, countryDisplayName, languageDisplayName } from './country-names.js';

/**
 * One row of `/languages`.
 *
 * Declared here rather than reusing `languageEntrySchema`: that schema types
 * `code` as `localeCodeSchema` (`^[a-z]{2,3}(-[A-Z]{2})?$`), which rejects
 * `multi` — yet its own doc comment says `multi` appears, and the measured live
 * catalogue publishes it for all 118 international channels. Widening the field
 * is the honest fix; the divergence is reported to the captain. Every other field
 * matches the published schema exactly.
 */
export interface PublicLanguageEntry {
  /** The tag as the catalogue declares it: `es`, `ca`, `multi`. */
  readonly code: string;
  readonly name: string;
  readonly channelCount: number;
  readonly playableCount: number;
}

/**
 * One row of `/countries/:code/regions`.
 *
 * Additive to the published contracts (which cover `/countries` and `/languages`
 * but not this endpoint): the same fields as the existing `/regions` row, plus
 * the flag that marks the `INTL` row folding channels with no region assigned, so
 * a client never offers an aggregate as a filter value.
 */
export interface CountryRegionEntry {
  readonly country: string;
  readonly code: string;
  readonly name: string;
  readonly channelCount: number;
  readonly playableCount: number;
  readonly aggregate: boolean;
}

export const countryRegionEntrySchema = z.object({
  country: z.string().min(2).max(3),
  code: z.string().min(1).max(16),
  name: z.string().min(1),
  channelCount: z.number().int().min(0),
  playableCount: z.number().int().min(0),
  aggregate: z.boolean(),
});

/** `/countries/:code/regions` — the country row (published schema) plus its regions. */
export const countryRegionsResponseSchema = z.object({
  country: countryEntrySchema,
  data: z.array(countryRegionEntrySchema),
  attribution: attributionSchema,
});

/**
 * `/languages` response.
 *
 * The row shape matches the published `languageEntrySchema` field for field; only
 * `code` is widened from `localeCodeSchema` to `string`, because the measured
 * catalogue publishes `multi` and `localeCodeSchema` rejects it.
 */
export const publicLanguageListResponseSchema = z.object({
  data: z.array(
    z.object({
      code: z.string().min(2).max(12),
      name: z.string().min(1).max(120),
      channelCount: z.number().int().min(0),
      playableCount: z.number().int().min(0),
    }),
  ),
  attribution: attributionSchema,
});

/** The one public predicate every catalogue count and listing shares. */
export const PUBLIC_CHANNEL_MATCH: Readonly<Record<string, unknown>> = {
  editorialStatus: 'published',
  mergedInto: null,
};

/** `und` is "language not determined"; `multi` is "several languages at once". */
export const UNDETERMINED_LANGUAGE = 'und';
export const MULTIPLE_LANGUAGES = 'multi';

/** Docs loaded and judged per round trip when a derived count is needed. */
export const PLAYABLE_SCAN_BATCH = 500;

/** Primary subtag of a BCP-47 tag, lowercase: `es-ES` → `es`. */
export function primaryLanguage(tag: string): string {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return primary.length > 0 ? primary : UNDETERMINED_LANGUAGE;
}

/** Regex-escapes a literal so a user-supplied `q` cannot become a pattern. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface GroupRow {
  readonly _id: string;
  readonly channelCount: number;
  /** Distinct region codes present in this group (empty when none is assigned). */
  readonly regionKeys: readonly string[];
}

/** The raw `$group` row, before the country/region keys are cleaned up. */
interface RawGroupRow {
  readonly _id: string | null;
  readonly channelCount: number;
  readonly regionKeys: (string | null)[];
}

/** `playable` over an explicit, bounded set of ids. */
async function playableIdSet(
  database: DatabaseHandle,
  playback: PlaybackService,
  filter: Record<string, unknown>,
): Promise<Set<string>> {
  const collection = database.collection<ChannelDoc>(COLLECTIONS.channels);
  const ids = new Set<string>();
  let batch: string[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const full = await collection.find({ _id: { $in: batch } }).toArray();
    const statuses = await playback.statusesFor(full);
    for (const [id, status] of statuses) if (status === 'available') ids.add(id);
    batch = [];
  };

  for await (const doc of collection.find(filter, { projection: { _id: 1 } }).batchSize(PLAYABLE_SCAN_BATCH)) {
    batch.push(doc._id);
    if (batch.length >= PLAYABLE_SCAN_BATCH) await flush();
  }
  await flush();
  return ids;
}

/** Per-country counts: the `/countries` rows and the `/regions` counts. */
export class CountryAggregates {
  constructor(
    private readonly database: DatabaseHandle,
    private readonly playback: PlaybackService,
  ) {}

  private channels() {
    return this.database.collection<ChannelDoc>(COLLECTIONS.channels);
  }

  /** One `$group` pass over the published catalogue, ordered for display. */
  private async groups(): Promise<GroupRow[]> {
    const rows = await this.channels()
      .aggregate<RawGroupRow>([
        { $match: PUBLIC_CHANNEL_MATCH },
        {
          $group: {
            _id: '$country',
            channelCount: { $sum: 1 },
            regionKeys: { $addToSet: '$region.code' },
          },
        },
        { $sort: { channelCount: -1, _id: 1 } },
      ])
      .toArray();
    return rows
      .filter((row): row is RawGroupRow & { _id: string } => typeof row._id === 'string' && row._id.length > 0)
      .map((row) => ({
        _id: row._id,
        channelCount: row.channelCount,
        regionKeys: [
          ...new Set(row.regionKeys.filter((code): code is string => typeof code === 'string' && code.length > 0)),
        ].sort(),
      }));
  }

  private async entryOf(group: GroupRow): Promise<CountryEntry> {
    const ids = await playableIdSet(this.database, this.playback, {
      ...PUBLIC_CHANNEL_MATCH,
      country: group._id,
    });
    return {
      code: group._id,
      name: countryDisplayName(group._id),
      international: group._id === INTERNATIONAL_COUNTRY_CODE,
      channelCount: group.channelCount,
      playableCount: ids.size,
      regionCount: group.regionKeys.length,
    };
  }

  /** `/countries` — every country value the published catalogue actually has. */
  async entries(): Promise<CountryEntry[]> {
    const entries: CountryEntry[] = [];
    for (const group of await this.groups()) {
      entries.push(await this.entryOf(group));
    }
    return entries;
  }

  /** One country row, or null when the catalogue has no channel for it. */
  async entry(country: string): Promise<CountryEntry | null> {
    const group = (await this.groups()).find((row) => row._id === country);
    return group ? this.entryOf(group) : null;
  }

  /**
   * `/countries/:code/regions` — grouped by region code in the database.
   *
   * The rows add up to the country total: channels with no region are folded into
   * the documented `INTL` aggregate, which is marked `aggregate: true` so a client
   * never offers it as a filter value.
   */
  async regions(country: string): Promise<{ entry: CountryEntry; data: CountryRegionEntry[] } | null> {
    const entry = await this.entry(country);
    if (!entry) return null;
    const rows = await this.channels()
      .aggregate<{ _id: string | null; channelCount: number }>([
        { $match: { ...PUBLIC_CHANNEL_MATCH, country } },
        { $group: { _id: '$region.code', channelCount: { $sum: 1 } } },
      ])
      .toArray();
    const counts = new Map<string, number>();
    let withoutRegion = 0;
    for (const row of rows) {
      if (typeof row._id === 'string' && row._id.length > 0) counts.set(row._id, row.channelCount);
      else withoutRegion += row.channelCount;
    }

    const ordered: Array<{ code: string; name: string }> = [];
    // Our published table first: its order is the order consumers already see.
    for (const region of SPAIN_REGIONS) {
      if (counts.has(region.code)) {
        ordered.push({ code: region.code, name: region.name });
        counts.delete(region.code);
      }
    }
    // A code the table does not name still exists in the data: report it as-is.
    for (const code of [...counts.keys()].sort()) {
      ordered.push({ code, name: regionByCode(code)?.name ?? code });
    }

    const data: CountryRegionEntry[] = [];
    for (const region of ordered) {
      const channelCount = (await this.regionCounts(country)).get(region.code) ?? 0;
      data.push({
        country,
        code: region.code,
        name: region.name,
        channelCount,
        playableCount: await this.playableIn(country, region.code),
        aggregate: false,
      });
    }
    if (withoutRegion > 0) {
      data.push({
        country,
        code: 'INTL',
        name: 'Sin región asignada',
        channelCount: withoutRegion,
        playableCount: await this.playableWithoutRegion(country),
        aggregate: true,
      });
    }
    return { entry, data };
  }

  private async regionCounts(country: string): Promise<Map<string, number>> {
    const rows = await this.channels()
      .aggregate<{ _id: string | null; channelCount: number }>([
        { $match: { ...PUBLIC_CHANNEL_MATCH, country } },
        { $group: { _id: '$region.code', channelCount: { $sum: 1 } } },
      ])
      .toArray();
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (typeof row._id === 'string' && row._id.length > 0) counts.set(row._id, row.channelCount);
    }
    return counts;
  }

  private async playableIn(country: string, regionCode: string): Promise<number> {
    const ids = await playableIdSet(this.database, this.playback, {
      ...PUBLIC_CHANNEL_MATCH,
      country,
      'region.code': regionCode,
    });
    return ids.size;
  }

  private async playableWithoutRegion(country: string): Promise<number> {
    const ids = await playableIdSet(this.database, this.playback, {
      ...PUBLIC_CHANNEL_MATCH,
      country,
      'region.code': { $in: [null, '', undefined] },
    });
    return ids.size;
  }
}

/** `/languages`. */
export class LanguageAggregates {
  constructor(
    private readonly database: DatabaseHandle,
    private readonly playback: PlaybackService,
  ) {}

  private channels() {
    return this.database.collection<ChannelDoc>(COLLECTIONS.channels);
  }

  async list(): Promise<PublicLanguageEntry[]> {
    const rows = await this.channels()
      .aggregate<{ _id: string | null; channelCount: number }>([
        { $match: PUBLIC_CHANNEL_MATCH },
        { $group: { _id: '$languageTag', channelCount: { $sum: 1 } } },
      ])
      .toArray();

    const languages: PublicLanguageEntry[] = [];
    for (const row of rows) {
      /*
       * The measured live vocabulary for `languageTag` is `es` (294 published
       * channels) and `multi` (118 international channels). `multi` is not a
       * BCP-47 tag, and hiding those 118 channels from the language axis would
       * be a worse answer than publishing the tag the catalogue really uses.
       */
      const tag = (row._id ?? '').trim().toLowerCase();
      if (tag.length === 0) continue;
      const ids = await playableIdSet(this.database, this.playback, {
        ...PUBLIC_CHANNEL_MATCH,
        languageTag: row._id,
      });
      languages.push({
        code: tag,
        name: languageDisplayName(primaryLanguage(tag)),
        channelCount: row.channelCount,
        playableCount: ids.size,
      });
    }
    // Declared languages first (most present first), the coverage markers last.
    const isMarker = (code: string): boolean => code === MULTIPLE_LANGUAGES || code === UNDETERMINED_LANGUAGE;
    languages.sort(
      (a, b) =>
        Number(isMarker(a.code)) - Number(isMarker(b.code)) ||
        b.channelCount - a.channelCount ||
        a.code.localeCompare(b.code),
    );
    return languages;
  }
}

/** What the playable sweep observed for one requested page. */
export interface PlayableWindow {
  /** The page window, in scan order. */
  readonly pageIds: readonly string[];
  /**
   * Playable channels seen so far, in order.
   *
   * Exact when `complete` is true. When the sweep stopped early (it does so as
   * soon as the window plus one is known) this is still a truthful *lower bound*
   * — it counts only channels it actually judged — which is why the caller can
   * report it as `total` and still say `hasNext` without contradicting itself.
   */
  readonly playableSeen: number;
  /** True when the sweep reached the end of the candidate stream. */
  readonly complete: boolean;
}

/**
 * Walks candidates in order and keeps only the playable ones, stopping as soon as
 * the requested window plus one is known (so `total`/`hasNext` can be answered
 * without scanning the whole filtered catalogue on a first-page request).
 */
export async function scanPlayableWindow(
  database: DatabaseHandle,
  playback: PlaybackService,
  candidates: AsyncIterable<{ _id: string }>,
  page: number,
  pageSize: number,
): Promise<PlayableWindow> {
  const start = (page - 1) * pageSize;
  const wanted = start + pageSize;
  const collected: string[] = [];
  let batch: string[] = [];
  const collection = database.collection<ChannelDoc>(COLLECTIONS.channels);

  const flush = async (): Promise<boolean> => {
    if (batch.length === 0) return true;
    const full = await collection.find({ _id: { $in: batch } }).toArray();
    const statuses = await playback.statusesFor(full);
    const playable = new Set([...statuses].filter(([, status]) => status === 'available').map(([id]) => id));
    for (const id of batch) {
      if (!playable.has(id)) continue;
      collected.push(id);
      // One past the window is enough to answer `hasNext` truthfully.
      if (collected.length > wanted) return false;
    }
    batch = [];
    return true;
  };

  for await (const candidate of candidates) {
    batch.push(candidate._id);
    if (batch.length >= PLAYABLE_SCAN_BATCH) {
      if (!(await flush())) {
        return { pageIds: collected.slice(start, wanted), playableSeen: collected.length, complete: false };
      }
    }
  }
  const complete = await flush();
  return {
    pageIds: collected.slice(start, wanted),
    playableSeen: collected.length,
    complete,
  };
}
