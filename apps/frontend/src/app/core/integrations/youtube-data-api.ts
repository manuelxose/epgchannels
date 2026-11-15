/**
 * Channel → live video resolution through the official YouTube Data API v3.
 *
 * The catalogue publishes 205 of its 215 YouTube options as
 * `/channel/<UC…>/live`: a page that names a channel, not a video. Embedding that
 * page in our own shell cannot be observed (YouTube's live-stream embed is an
 * internal document), so this service resolves the channel's *current public
 * live video* with the documented API and then plays that video through the
 * official IFrame player, where every state is observable.
 *
 * Allowed, documented calls only:
 *   1. `search.list?channelId&eventType=live&type=video&part=snippet&maxResults=N`
 *      → the channel's active public live broadcasts (video id, title, time);
 *   2. `videos.list?id&part=status,snippet,liveStreamingDetails`
 *      → `status.embeddable`, the live status and which channel owns it.
 *
 * Nothing else is contacted: no manifests, no player responses, no private
 * tokens, no undocumented endpoints. A request needs a Google API key supplied
 * by the host application (`YoutubeDataApiConfig.apiKey`); without one the
 * service reports `no-api` and the UI falls back to the plain official link
 * instead of inventing an answer.
 *
 * Quota is bounded here, not by hope: every call is counted against an explicit
 * budget (default 10_000 units/day, the documented default allocation), results
 * are cached per channel with a short TTL and negative results are cached too
 * so a channel that is not live does not burn the budget on every visit.
 */
import { normalizeChannelId, normalizeVideoId } from './youtube-target';

export const YOUTUBE_DATA_API = 'https://www.googleapis.com/youtube/v3';

/** Documented quota cost of `search.list` (100 units; its 100 calls/day figure is derived from this). */
export const SEARCH_COST = 100;
/** Documented quota cost of `videos.list`. */
export const VIDEOS_COST = 1;
/**
 * Documented default allocation: 10 000 units/day. `search.list` at 100 units per
 * call therefore allows ~100 calls, which is where the "100 searches/day" figure
 * comes from: it is ONE bucket, not a separate one.
 */
export const DEFAULT_UNITS_PER_DAY = 10_000;
/** Documented default: `search.list` may be called 100 times per day. */
export const SEARCH_DAILY_LIMIT = 100;

/** `status.embeddable`, as published by the API. */
export interface YoutubeVideoStatus {
  readonly videoId: string;
  readonly embeddable: boolean;
  /** `live` / `upcoming` / `none`, from `snippet.liveBroadcastContent`. */
  readonly liveBroadcastContent: 'live' | 'upcoming' | 'none' | 'unknown';
  readonly channelId?: string;
  readonly title?: string;
  readonly actualStart?: string;
}

export type YoutubeResolution =
  /** A public, embeddable LIVE video owned by that channel is playing now. */
  | { readonly kind: 'live'; readonly videoId: string; readonly channelId: string; readonly title?: string; readonly embeddable: true }
  /** The channel has a live broadcast, but its uploader forbids embedding. */
  | { readonly kind: 'not-embeddable'; readonly videoId: string; readonly channelId: string; readonly title?: string }
  /** The channel is not broadcasting now (the documented answer: no live video). */
  | { readonly kind: 'offline'; readonly channelId: string }
  /** The host application has not configured a Data API key. */
  | { readonly kind: 'no-api'; readonly channelId: string }
  /** The API answered with an error we can describe (quota, auth, network). */
  | { readonly kind: 'error'; readonly channelId: string; readonly message: string; readonly retryable: boolean };

export interface YoutubeDataApiConfig {
  readonly apiKey?: string;
  /** Injectable for tests; defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Cache lifetime for a positive resolution. Default 60 s (live video ids change). */
  readonly liveTtlMs?: number;
  /** Cache lifetime for "not live" / "not embeddable". Default 3 min. */
  readonly offlineTtlMs?: number;
  /** Maximum `search.list` calls per rolling day. Default 100 (documented bucket). */
  readonly searchPerDay?: number;
  /** Maximum Data API units per rolling day. Default 10 000. */
  readonly unitsPerDay?: number;
  /** Injected clock, so tests are deterministic. */
  readonly now?: () => number;
}

interface CacheEntry {
  readonly value: YoutubeResolution;
  readonly expiresAt: number;
}

const LIVE_TTL_MS = 60_000;
const OFFLINE_TTL_MS = 180_000;

/**
 * Resolves live videos for channels. One instance owns its own cache and quota
 * ledger so a host can tune or reset it, and tests get determinism.
 */
export class YoutubeDataApi {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<YoutubeResolution>>();
  private dayKey = '';
  private searchUsed = 0;
  private unitsUsed = 0;
  /** Set when YouTube itself reports the project quota is exhausted. */
  private serverQuotaExhaustedAt: number | undefined;

  constructor(private readonly config: YoutubeDataApiConfig = {}) {}

  /** True when a key is configured; the UI must not promise resolution otherwise. */
  get available(): boolean {
    return Boolean(this.config.apiKey);
  }

  private now(): number {
    return (this.config.now ?? Date.now)();
  }

  /**
   * The YouTube quota day is documented to reset at midnight **Pacific Time**,
   * not UTC. The key is therefore the Pacific calendar date.
   */
  private rollQuota(): void {
    const pacific = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(this.now()));
    if (pacific !== this.dayKey) {
      this.dayKey = pacific;
      this.searchUsed = 0;
      this.unitsUsed = 0;
      this.serverQuotaExhaustedAt = undefined;
    }
  }

  private budgetLeft(search: boolean): boolean {
    this.rollQuota();
    // A quota the server already told us is exhausted stays exhausted for the
    // rest of the quota day: asking again cannot succeed and only wastes calls.
    if (this.serverQuotaExhaustedAt !== undefined) {
      return false;
    }
    const cost = search ? SEARCH_COST : VIDEOS_COST;
    if (this.unitsUsed + cost > (this.config.unitsPerDay ?? DEFAULT_UNITS_PER_DAY)) {
      return false;
    }
    // `search.list` is additionally bounded by its documented daily call limit.
    if (search) {
      return this.searchUsed + 1 <= (this.config.searchPerDay ?? SEARCH_DAILY_LIMIT);
    }
    return true;
  }

  private charge(search: boolean): void {
    this.rollQuota();
    if (search) {
      this.searchUsed += 1;
    }
    this.unitsUsed += search ? SEARCH_COST : VIDEOS_COST;
  }

  /** Diagnostic view of the ledger, used by the UI and tests. */
  quota(): { readonly searchUsed: number; readonly unitsUsed: number } {
    this.rollQuota();
    return { searchUsed: this.searchUsed, unitsUsed: this.unitsUsed };
  }

  private async getJson(url: string): Promise<unknown> {
    const fetchImpl = this.config.fetchImpl ?? globalThis.fetch;
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new YoutubeApiError(response.status, describeApiError(response.status, body), readErrorReason(body));
    }
    return body;
  }

  /**
   * Resolves the channel's current live video. Cached, de-duplicated and
   * budget-checked; never throws for an expected refusal.
   */
  async resolveChannelLive(channelIdInput: string): Promise<YoutubeResolution> {
    const channelId = normalizeChannelId(channelIdInput);
    if (!channelId) {
      return { kind: 'error', channelId: String(channelIdInput), message: 'Identificador de canal no válido.', retryable: false };
    }
    const cached = this.cache.get(channelId);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value;
    }
    if (cached) {
      // Drop the expired entry on read so the map cannot grow monotonically for
      // the lifetime of the page (a long session visits many channels).
      this.cache.delete(channelId);
    }
    const pending = this.inflight.get(channelId);
    if (pending) {
      return pending;
    }
    /*
     * The cache is written BEFORE the in-flight entry is dropped: dropping it
     * first left a window where a caller saw neither an in-flight promise nor a
     * cached value and started a duplicate request for the same channel.
     */
    const resolution = (async (): Promise<YoutubeResolution> => {
      try {
        const value = await this.fetchChannelLive(channelId);
        const ttl =
          value.kind === 'live'
            ? (this.config.liveTtlMs ?? LIVE_TTL_MS)
            : value.kind === 'error'
              ? 0
              : (this.config.offlineTtlMs ?? OFFLINE_TTL_MS);
        if (ttl > 0) {
          this.cache.set(channelId, { value, expiresAt: this.now() + ttl });
        }
        return value;
      } finally {
        this.inflight.delete(channelId);
      }
    })();
    this.inflight.set(channelId, resolution);
    return resolution;
  }

  private async fetchChannelLive(channelId: string): Promise<YoutubeResolution> {
    if (!this.config.apiKey) {
      return { kind: 'no-api', channelId };
    }
    if (!this.budgetLeft(true)) {
      return {
        kind: 'error',
        channelId,
        message: 'Se ha agotado la cuota diaria de consultas a YouTube; a partir de ahora se ofrece el enlace oficial.',
        retryable: false,
      };
    }
    try {
      // 1. The channel's active public live broadcasts. `videoEmbeddable` is
      //    deliberately NOT set: search cannot distinguish "no live" from "a
      //    live that forbids embedding", and that difference is the whole point
      //    of the next step. `videos.list` reports `status.embeddable`.
      const search = new URL(`${YOUTUBE_DATA_API}/search`);
      search.searchParams.set('part', 'snippet');
      search.searchParams.set('channelId', channelId);
      search.searchParams.set('eventType', 'live');
      search.searchParams.set('type', 'video');
      search.searchParams.set('maxResults', '5');
      search.searchParams.set('key', this.config.apiKey);
      this.charge(true);
      const searchBody = await this.getJson(search.toString());
      const candidates = readSearchItems(searchBody);
      if (candidates.length === 0) {
        return { kind: 'offline', channelId };
      }

      // 2. Confirm embeddability and ownership for the candidates we found.
      if (!this.budgetLeft(false)) {
        return {
          kind: 'error',
          channelId,
          message: 'Se ha agotado la cuota diaria de consultas a YouTube; a partir de ahora se ofrece el enlace oficial.',
          retryable: false,
        };
      }
      const videos = new URL(`${YOUTUBE_DATA_API}/videos`);
      videos.searchParams.set('part', 'status,snippet,liveStreamingDetails');
      videos.searchParams.set('id', candidates.map((entry) => entry.videoId).join(','));
      videos.searchParams.set('key', this.config.apiKey);
      this.charge(false);
      const videosBody = await this.getJson(videos.toString());
      const statuses = readVideoStatuses(videosBody);
      /*
       * `videos.list` returning nothing for ids the search just returned means we
       * cannot judge them (not that the channel is offline): report unknown, so
       * the UI offers the channel's page instead of claiming it is not live.
       */
      if (statuses.length === 0) {
        return {
          kind: 'error',
          channelId,
          message: 'YouTube no ha devuelto información de la emisión del canal.',
          retryable: true,
        };
      }

      // The right emission is the channel's own, public, live and embeddable one.
      const own = statuses.filter((status) => status.channelId === channelId);
      const matching = own.filter((status) => status.liveBroadcastContent === 'live');
      const embeddable = matching.find((status) => status.embeddable);
      if (embeddable) {
        return {
          kind: 'live',
          videoId: embeddable.videoId,
          channelId,
          title: embeddable.title,
          embeddable: true,
        };
      }
      if (matching.length > 0) {
        // It IS live; its owner forbids embedding. That is a refusal, not "offline".
        const first = matching[0];
        return {
          kind: 'not-embeddable',
          videoId: first.videoId,
          channelId,
          title: first.title,
        };
      }
      /*
       * Nothing live. Only report `offline` when YouTube actually told us the
       * broadcast content state; an unrecognised state means we do not know, and
       * claiming "the channel is not live" on unknown data is exactly the kind of
       * answer this milestone forbids.
       */
      if (own.length > 0 && own.every((status) => status.liveBroadcastContent === 'unknown')) {
        return {
          kind: 'error',
          channelId,
          message: 'YouTube no ha indicado si el canal está emitiendo.',
          retryable: true,
        };
      }
      return { kind: 'offline', channelId };
    } catch (error) {
      if (error instanceof YoutubeApiError && isQuotaError(error)) {
        // The server is authoritative: stop asking for the rest of the quota day.
        this.serverQuotaExhaustedAt = this.now();
      }
      const message =
        error instanceof YoutubeApiError ? error.message : 'No se ha podido consultar a YouTube en este momento.';
      const retryable = error instanceof YoutubeApiError ? error.retryable : true;
      return { kind: 'error', channelId, message, retryable };
    }
  }

  /** Forgets every cached resolution (used when the user retries explicitly). */
  invalidate(channelId?: string): void {
    if (channelId) {
      this.cache.delete(channelId);
    } else {
      this.cache.clear();
    }
  }
}

class YoutubeApiError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly status: number,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'YoutubeApiError';
    this.retryable = status === 429 || status >= 500;
  }
}

/** A documented quota refusal (it will keep failing until the quota day resets). */
function isQuotaError(error: YoutubeApiError): boolean {
  return error.status === 403 && (error.reason === 'quotaExceeded' || error.reason === 'dailyLimitExceeded');
}

function describeApiError(status: number, body: unknown): string {
  const reason = readErrorReason(body);
  if (status === 403 && (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded')) {
    return 'Se ha agotado la cuota diaria de YouTube.';
  }
  if (status === 400 || status === 401 || status === 403) {
    return 'YouTube ha rechazado la consulta (clave de API o permisos).';
  }
  if (status === 429) {
    return 'YouTube está limitando las consultas; prueba de nuevo en unos minutos.';
  }
  return 'YouTube no ha respondido correctamente.';
}

function readErrorReason(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const error = (body as { error?: { errors?: { reason?: unknown }[] } }).error;
  const reason = error?.errors?.[0]?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

function readSearchItems(body: unknown): { videoId: string }[] {
  if (typeof body !== 'object' || body === null) {
    return [];
  }
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return [];
  }
  const found: { videoId: string }[] = [];
  for (const item of items) {
    const videoId = normalizeVideoId((item as { id?: { videoId?: unknown } })?.id?.videoId as string | undefined);
    if (videoId) {
      found.push({ videoId });
    }
  }
  return found;
}

function readVideoStatuses(body: unknown): YoutubeVideoStatus[] {
  if (typeof body !== 'object' || body === null) {
    return [];
  }
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return [];
  }
  const statuses: YoutubeVideoStatus[] = [];
  for (const item of items) {
    const record = item as {
      id?: unknown;
      status?: { embeddable?: unknown };
      snippet?: { channelId?: unknown; title?: unknown; liveBroadcastContent?: unknown };
      liveStreamingDetails?: { actualStartTime?: unknown };
    };
    const videoId = normalizeVideoId(typeof record.id === 'string' ? record.id : undefined);
    if (!videoId) {
      continue;
    }
    const content = record.snippet?.liveBroadcastContent;
    statuses.push({
      videoId,
      // Absent is not "embeddable": embedding is only claimed when the API says so.
      embeddable: record.status?.embeddable === true,
      liveBroadcastContent:
        content === 'live' || content === 'upcoming' || content === 'none' ? content : 'unknown',
      channelId: typeof record.snippet?.channelId === 'string' ? record.snippet.channelId : undefined,
      title: typeof record.snippet?.title === 'string' ? record.snippet.title : undefined,
      actualStart:
        typeof record.liveStreamingDetails?.actualStartTime === 'string'
          ? record.liveStreamingDetails.actualStartTime
          : undefined,
    });
  }
  return statuses;
}
