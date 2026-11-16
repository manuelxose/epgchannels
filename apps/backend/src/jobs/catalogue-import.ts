/**
 * Import pipeline: turns a **caller-supplied** reference catalogue snapshot into
 * our own canonical records.
 *
 * This module never fetches anything. The snapshot is an operator-supplied file
 * (already captured by whatever means the operator is licensed to use), and
 * every record it produces carries provenance pointing back to its digest.
 *
 * What it does *not* do:
 * - it does not copy editorial prose: descriptions start empty and are ours;
 * - it does not publish anything unreviewed: a source whose emitter has no
 *   recorded decision is created as `draft` with permission `unlicensed`, so the
 *   publication policy will not expose it;
 * - it does not drop anything silently: every input record yields either a
 *   channel or a documented exclusion.
 */
import type { EmitterEntry } from '../modules/providers/emitters.js';
import { emitterFor } from '../modules/providers/emitters.js';
import { resolveRegionCode } from '../shared/taxonomy.js';

export type ImportExclusionReason =
  | 'not-a-record'
  | 'missing-name'
  | 'duplicate-slug';

export interface ReferenceOption {
  readonly format: string;
  readonly url: string;
  readonly geo: boolean;
}

export interface ReferenceChannelRecord {
  readonly index: number;
  /** Stable key inside the snapshot: `Country/Ambit/Name`. */
  readonly legacyId: string;
  readonly name: string;
  readonly webUrl: string | null;
  readonly logoUrl: string | null;
  readonly epgId: string | null;
  /** Raw published tags (`GEO`, `EMB`, `UAG`, …), kept as reference metadata. */
  readonly tags: readonly string[];
  readonly options: readonly ReferenceOption[];
  readonly countryCode: 'ES' | 'INT';
  readonly countryLabel: string;
  readonly ambit: string;
  readonly regionCode: string | null;
  readonly suggestedCategory: string;
}

export interface ReferenceSnapshot {
  readonly updated: number | null;
  readonly countries: readonly {
    readonly name: string;
    readonly ambits: readonly { readonly name: string; readonly channels: readonly unknown[] }[];
  }[];
}

const FORMAT_ALIASES: Readonly<Record<string, string>> = {
  m3u8: 'hls',
  hls: 'hls',
  mpd: 'dash',
  dash: 'dash',
  youtube: 'youtube',
  iframe: 'official-embed',
  mp4: 'external',
  stream: 'hls',
};

/**
 * Which playback type a source really is.
 *
 * The declared format cannot be trusted on its own: the reference catalogue
 * labels a Twitch player URL as `m3u8`, and playing a `/embed` page through our
 * HLS engine fails because the page is HTML, not a playlist (audited: 26 sources).
 *
 * So the ADDRESS decides, and only addresses that really are an HLS playlist
 * stay `hls`. Everything else that is a third-party player page becomes
 * `official-embed`: it is still the emitter's public player, presented as such.
 */
export function effectiveSourceType(declaredFormat: string, url: string): string {
  const type = FORMAT_ALIASES[declaredFormat] ?? declaredFormat;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return type;
  }
  const path = parsed.pathname.toLowerCase();

  // An explicit manifest extension is the strongest signal.
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';

  /*
   * YouTube has its own type and its own engine, and its channel pages are
   * resolved to a live video. It must never be folded into the generic embed:
   * `youtube` carries permissions and playback rules that `official-embed` does not.
   */
  const hostname = parsed.hostname.toLowerCase();
  const isYoutube = /(?:^|\.)youtube(?:-nocookie)?\.com$/.test(hostname) || hostname === 'youtu.be';
  if (isYoutube) return 'youtube';

  // Any other third-party player page (`player.twitch.tv/?channel=…`, `/embed/…`)
  // is an embed, whatever format the source declared it as.
  const isPlayerHost = /(?:^|\.)(?:twitch\.tv|dailymotion\.com|vimeo\.com)$/.test(hostname);
  if (isPlayerHost) return 'official-embed';

  return type;
}

/** Ambit → our canonical category. Editorial decision, applied once. */
export function categoryForAmbit(countryLabel: string, ambit: string, regionCode: string | null): string {
  const normalized = ambit
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (countryLabel.toLowerCase() !== 'spain' && countryLabel.toLowerCase() !== 'españa') {
    return 'internacional';
  }
  if (normalized.startsWith('generalista')) return 'generalista';
  if (normalized.startsWith('informativ')) return 'informativos';
  if (normalized.startsWith('deportiv')) return 'deportes';
  if (normalized.startsWith('infantil')) return 'infantil';
  if (normalized.startsWith('musical')) return 'musica';
  if (normalized.startsWith('religios')) return 'religion';
  if (normalized.startsWith('eventual')) return 'otros';
  if (normalized.startsWith('streaming')) return 'otros';
  if (regionCode !== null) return 'autonomica';
  return 'otros';
}

/** Placeholder-token URLs need client data we refuse to synthesise. */
export function hasPlaceholderToken(url: string): boolean {
  return /\[[A-Z0-9_]+\]/.test(url);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asHttpUrl(value: unknown): string | null {
  const text = asString(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Extracts our channel records from a reference snapshot. Pure. */
export function extractReferenceChannels(
  snapshot: unknown,
): { records: ReferenceChannelRecord[]; rejected: number } {
  const records: ReferenceChannelRecord[] = [];
  let rejected = 0;
  if (typeof snapshot !== 'object' || snapshot === null) {
    return { records, rejected: 1 };
  }
  const countries = (snapshot as { countries?: unknown }).countries;
  if (!Array.isArray(countries)) {
    return { records, rejected: 1 };
  }
  for (const countryRaw of countries) {
    if (typeof countryRaw !== 'object' || countryRaw === null) {
      rejected += 1;
      continue;
    }
    const country = countryRaw as Record<string, unknown>;
    const countryLabel = asString(country['name']) ?? 'International';
    const ambits = country['ambits'];
    if (!Array.isArray(ambits)) {
      rejected += 1;
      continue;
    }
    for (const ambitRaw of ambits) {
      if (typeof ambitRaw !== 'object' || ambitRaw === null) {
        rejected += 1;
        continue;
      }
      const ambit = ambitRaw as Record<string, unknown>;
      const ambitName = asString(ambit['name']);
      const channels = ambit['channels'];
      if (!ambitName || !Array.isArray(channels)) {
        rejected += 1;
        continue;
      }
      const isSpain = countryLabel.toLowerCase() === 'spain' || countryLabel.toLowerCase() === 'españa';
      // `Int. Europa` and similar international ambits name the region.
      const regionCode = resolveRegionCode(ambitName);
      for (const channelRaw of channels) {
        if (typeof channelRaw !== 'object' || channelRaw === null) {
          rejected += 1;
          continue;
        }
        const channel = channelRaw as Record<string, unknown>;
        const name = asString(channel['name']);
        if (!name) {
          rejected += 1;
          continue;
        }
        const rawOptions = Array.isArray(channel['options']) ? channel['options'] : [];
        const options: ReferenceOption[] = [];
        for (const optionRaw of rawOptions) {
          if (typeof optionRaw !== 'object' || optionRaw === null) continue;
          const option = optionRaw as Record<string, unknown>;
          const format = FORMAT_ALIASES[String(option['format'] ?? '').toLowerCase()];
          const url = asHttpUrl(option['url']);
          if (!format || !url) continue;
          options.push({ format, url, geo: asString(option['geo2'] as unknown) !== null });
        }
        const tags = Array.isArray(channel['extra_info'])
          ? channel['extra_info'].filter((tag): tag is string => typeof tag === 'string')
          : [];
        records.push({
          index: records.length,
          legacyId: `${countryLabel}/${ambitName}/${name}`,
          name,
          webUrl: asHttpUrl(channel['web']),
          logoUrl: asHttpUrl(channel['logo']),
          epgId: asString(channel['epg_id']),
          tags,
          options,
          countryCode: isSpain ? 'ES' : 'INT',
          countryLabel,
          ambit: ambitName,
          regionCode: isSpain ? regionCode : null,
          suggestedCategory: categoryForAmbit(countryLabel, ambitName, isSpain ? regionCode : null),
        });
      }
    }
  }
  return { records, rejected };
}

export interface ImportedSourcePlan {
  readonly provider: string;
  readonly type: string;
  readonly url: string;
  readonly officialPageUrl: string | null;
  readonly permission: string;
  readonly editorialStatus: 'draft' | 'published';
  readonly conditions: {
    embedAllowed: boolean;
    proxyAllowed: boolean;
    worldwide: boolean;
    restrictedRegions: string[];
    browserCompatibility: 'all' | 'desktop' | 'mobile';
    requiresForgedHeader: boolean;
    emitterAppOnly: boolean;
    notes: string | null;
  };
  readonly priority: number;
  readonly emitter: EmitterEntry;
  /** Why the source was kept as a draft (null when it is publishable). */
  readonly withheldReason: string | null;
}

export interface ChannelImportPlan {
  readonly record: ReferenceChannelRecord;
  readonly slugSeed: string;
  readonly sources: readonly ImportedSourcePlan[];
  /** True when at least one source is publishable right away. */
  readonly hasPublishedSource: boolean;
}

/**
 * Decides, per published option, whether it can be an *authorised public*
 * source. The rules are the documented integration conditions:
 *
 * - a YouTube/Twitch page is exposed only through the official player
 *   (`official-embed` semantics live in the `youtube` type);
 * - an option that needs the emitter's app (`UAG*`) or a Referer (`REF*`) is
 *   never integrated, because we do not forge client data;
 * - a placeholder-token URL (e.g. `[DEVICE_ID]`) needs client data we will not
 *   synthesise, so it is recorded and withheld;
 * - an emitter with no recorded decision yields a withheld draft, never a
 *   published source.
 */
export function planSources(record: ReferenceChannelRecord): ImportedSourcePlan[] {
  const plans: ImportedSourcePlan[] = [];
  const tags = record.tags;
  const requiresApp = tags.some((tag) => tag.startsWith('UAG'));
  const requiresReferer = tags.some((tag) => tag.startsWith('REF'));
  for (const option of record.options) {
    const emitter = emitterFor(option.url);
    const isPlatform = emitter.basis === 'platform-embed';
    const placeholder = hasPlaceholderToken(option.url);
    let withheld: string | null = null;
    if (requiresApp) withheld = 'emitter-app-only';
    else if (requiresReferer) withheld = 'requires-forged-header';
    else if (placeholder) withheld = 'credentials-required';
    else if (!emitter.exposeSources) {
      withheld = emitter.basis === 'reference-only' ? 'disallowed-integration' : 'unlicensed';
    }
    const publishable = withheld === null;
    plans.push({
      provider: isPlatform ? `platform:${emitter.host}` : `emitter:${emitter.host}`,
      type: effectiveSourceType(option.format, option.url),
      url: option.url,
      officialPageUrl: isPlatform || option.format === 'official-embed' ? (record.webUrl ?? option.url) : record.webUrl,
      permission: publishable
        ? isPlatform
          ? 'emitter-embeddable'
          : 'emitter-public-stream'
        : 'unlicensed',
      editorialStatus: publishable ? 'published' : 'draft',
      conditions: {
        embedAllowed: isPlatform || publishable,
        proxyAllowed: false,
        worldwide: !option.geo,
        restrictedRegions: option.geo ? ['ES'] : [],
        browserCompatibility: 'all',
        requiresForgedHeader: requiresReferer,
        emitterAppOnly: requiresApp,
        notes: null,
      },
      priority: isPlatform ? 200 : 100,
      emitter,
      withheldReason: withheld,
    });
  }
  return plans;
}

/** A channel with no usable option still exists, as an external reference. */
export function planExternalSource(record: ReferenceChannelRecord): ImportedSourcePlan | null {
  if (!record.webUrl) return null;
  const emitter = emitterFor(record.webUrl);
  const publishable = emitter.exposeSources;
  return {
    provider: `emitter:${emitter.host || 'unknown'}`,
    type: 'external',
    url: record.webUrl,
    officialPageUrl: record.webUrl,
    permission: publishable ? 'official-player-only' : 'unlicensed',
    editorialStatus: publishable ? 'published' : 'draft',
    conditions: {
      embedAllowed: false,
      proxyAllowed: false,
      worldwide: true,
      restrictedRegions: [],
      browserCompatibility: 'all',
      requiresForgedHeader: false,
      emitterAppOnly: false,
      notes: null,
    },
    priority: 500,
    emitter,
    withheldReason: publishable ? null : 'unlicensed',
  };
}

export function planChannel(record: ReferenceChannelRecord): ChannelImportPlan {
  const sources = planSources(record);
  const hasPublishedSource = sources.some((plan) => plan.editorialStatus === 'published');
  if (!hasPublishedSource) {
    const external = planExternalSource(record);
    if (external) sources.push(external);
  }
  return {
    record,
    slugSeed: record.name,
    sources,
    hasPublishedSource: sources.some((plan) => plan.editorialStatus === 'published'),
  };
}
