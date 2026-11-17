import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { createEngine } from '../player/engine-factory';
import { YoutubeEngineError } from '../player/engine-factory';
import { youtubeChannelLiveUrl } from '../integrations/youtube-embed';
import { resolveYoutubeTarget } from '../integrations/youtube-target';
import { forgiveChannelEmbedAttempt } from '../integrations/youtube-runtime';
import { toEngineKind, type EngineFactory, type EngineKind } from '../player/engine';
import {
  classifyFailure,
  nextFallbackIndex,
  reducePlayerStatus,
  type FailureClass,
  type PlayerErrorInfo,
  type PlayerEvent,
  type PlayerStatus,
  type SourceFailureCause,
} from '../player/player-state';
import type { EngineEvent, MediaTrack, PlayerEngine, QualityLevel } from '../player/engine';
import { isEligibleSource, youtubeChannelSource, youtubeVideoSource } from '../models/catalog.model';
import type { Channel, MediaSource } from '../models/catalog.model';

export type EngineLabel = EngineKind | 'none';

/** One failed source and why, kept for the user report and diagnostics. */
export interface SourceFailureRecord {
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly sourceFormat: string;
  readonly cause: SourceFailureCause;
  readonly code: string;
  readonly message: string;
  readonly failureClass: FailureClass;
}

/** A source as offered to the picker: in-app attempts are separated from official embeds. */
export interface SourceOption {
  readonly source: MediaSource;
  readonly index: number;
  readonly eligible: boolean;
}

export interface PlayerSnapshot {
  readonly status: PlayerStatus;
  readonly engine: EngineLabel;
  readonly channel?: Channel;
  readonly source?: MediaSource;
  readonly sourceIndex: number;
  readonly qualities: readonly QualityLevel[];
  readonly currentQuality: number;
  readonly audioTracks: readonly MediaTrack[];
  readonly subtitleTracks: readonly MediaTrack[];
  readonly subtitleSelection: number | 'off' | undefined;
  readonly error?: PlayerErrorInfo;
  readonly attempts: number;
  /** Sources already failed in this load; never retried automatically. */
  readonly failedSources: readonly SourceFailureRecord[];
  /** Last fallback message shown to the user, if any. */
  readonly notice?: string;
  /**
   * Official page where the active channel can still be watched, when it could
   * not be checked or played in-app (e.g. its YouTube live page).
   */
  readonly watchableUrl?: string;
}

const MAX_AUTO_RETRIES = 2;
const RETRY_DELAYS_MS = [1_000, 3_000];

/**
 * Resolves a YouTube **channel** source to the video id of its current live
 * stream through the documented Data API. Injected so the controller stays free
 * of any network policy and tests can decide the answer.
 *
 * Returns the video id to play, or a refusal the UI can explain. `key` is the
 * deployment-provided Data API key (already injected by the host application), so
 * a deployment can enable resolution at runtime without rebuilding the bundle.
 */
export type YoutubeLiveResolver = (
  sourceUrl: string,
  url: string,
) => Promise<
  | { readonly kind: 'video'; readonly videoId: string }
  /**
   * Play the channel through YouTube's documented channel embed
   * (`/embed/live_stream?channel=…`): no API key and no scraping, but our app
   * cannot observe its playback state, so it is marked unobservable.
   */
  | { readonly kind: 'channel-embed'; readonly channelId: string }
  | { readonly kind: 'offline' }
  | { readonly kind: 'not-embeddable' }
  /**
   * The channel cannot be played in-app right now. `url` is where the user can
   * still watch it (its official live page, opened in YouTube). A channel whose
   * liveness we could NOT determine is always handled this way — never as
   * `offline`, which would be a claim about the world we had not earned.
   */
  | {
      readonly kind: 'unplayable';
      readonly message: string;
      readonly url?: string;
      /** How it is recorded: `offline` is a fact, the rest are uncertainties. */
      readonly cause?: 'offline' | 'not-embeddable' | 'unavailable';
    }
>;

/** No resolution configured: a channel page can then only be offered as a link. */
export const NO_YOUTUBE_RESOLVER: YoutubeLiveResolver = async () => ({ kind: 'unplayable' as const, message: '' });

/**
 * Default resolver: the documented Data API adapter, which reads the key the
 * deployment provides at runtime. Declared inline (rather than imported at the
 * top) so the controller's token and the adapter stay in one dependency
 * direction: the adapter imports the type, the controller never imports it
 * eagerly.
 */
export const YOUTUBE_LIVE_RESOLVER = new InjectionToken<YoutubeLiveResolver>('YOUTUBE_LIVE_RESOLVER', {
  providedIn: 'root',
  factory: () => NO_YOUTUBE_RESOLVER,
});

/**
 * Where a deployment injects its own runtime configuration without a rebuild:
 * `window.TDT_YOUTUBE_API_KEY` is read when the first channel is resolved.
 *
 * This is the safe way to ship the (restricted) key for the channels the
 * catalogue publishes as `/channel/<UC…>/live`, and it avoids a circular
 * dependency between the controller's injection token and the resolver adapter.
 */
export const YOUTUBE_RUNTIME_KEY = 'TDT_YOUTUBE_API_KEY';

/** Reads the deployment-provided key from the global object, if any. */
function runtimeYoutubeKey(): string | undefined {
  const value = (globalThis as { TDT_YOUTUBE_API_KEY?: unknown }).TDT_YOUTUBE_API_KEY;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Backend selector. Injected so tests can supply a fake engine and so a host
 * application can swap the playback backend without touching this controller.
 */
export const PLAYER_ENGINE_FACTORY = new InjectionToken<EngineFactory>('PLAYER_ENGINE_FACTORY', {
  providedIn: 'root',
  factory: () => (options, kind) => createEngine(options, kind),
});

/**
 * Why a geo-locked/encrypted/embed-only source is never handed to an engine.
 * The message names the actual reason so the picker can be honest per source.
 */
export function blockedErrorFor(source: MediaSource): PlayerErrorInfo {
  const why =
    source.format === 'youtube' || source.format === 'iframe'
      ? 'Esta emisión se ofrece en el reproductor oficial del emisor.'
      : source.geoRestricted
        ? 'Esta emisión está restringida a su país o zona por el emisor.'
        : source.format === 'progressive'
          ? 'Esta URL no es una emisión continua compatible con el reproductor.'
          : 'Esta fuente no puede reproducirse dentro de la aplicación.';
  return { code: 'BLOCKED_SOURCE', message: why, recoverable: false };
}

/**
 * True when the emitter publishes some official route the user can be sent to
 * (an official embed or the emitter's own page). Used to decide between a
 * terminal `blocked`/`unavailable` state and pointing at `external`.
 */
export function hasOfficialRoute(channel: Channel | undefined): boolean {
  if (!channel) {
    return false;
  }
  return Boolean(channel.embargoedSources?.length || channel.webUrl) || channel.availability === 'external';
}

/**
 * Map an engine failure onto the shared failure vocabulary, so the same
 * recovery rules apply to every backend.
 *
 * ENGINES use their own code prefixes; the controller classifies with
 * `classifyFailure`, which decides *whether* to retry and *where* to fall back.
 * Without this mapping a refusal to embed (`YOUTUBE_101`/`150`) fell into
 * `permanent` and, having no other source, ended in `external` — hiding the
 * real reason ("the owner forbids embedding") behind a generic redirect.
 */
export function failureCodeFor(error: PlayerErrorInfo): PlayerErrorInfo {
  const code = error.code.toUpperCase();
  if (code === 'YOUTUBE_101' || code === 'YOUTUBE_150') {
    return { ...error, code: 'BLOCKED_EMBED_FORBIDDEN' };
  }
  if (code === 'YOUTUBE_153') {
    return { ...error, code: 'BLOCKED_CLIENT_IDENTITY' };
  }
  if (code === 'YOUTUBE_100') {
    // The video is gone (removed, private, or the broadcast ended). A published
    // page of the emitter cannot recover a stream that no longer exists, so the
    // terminal state must be "unavailable", not a redirect.
    return { ...error, code: 'BLOCKED_YOUTUBE_GONE', recoverable: false };
  }
  if (code === 'YOUTUBE_2') {
    // YouTube rejected the request itself: not something a retry or a redirect
    // can fix, and never worth presenting as "look at the emitter's page".
    return { ...error, code: 'BLOCKED_YOUTUBE_INVALID_REQUEST', recoverable: false };
  }
  return error;
}

/** Codes for which a published emitter page cannot recover the stream. */
const NO_OFFICIAL_ROUTE_CODES: readonly string[] = ['BLOCKED_YOUTUBE_GONE'];

/** Classifies a failure so fallback can decide whether another source is worth trying. */
export function causeFor(error: PlayerErrorInfo, context: { engineFormat: string; failureClass: FailureClass }): SourceFailureCause {
  const code = error.code.toUpperCase();
  switch (context.failureClass) {
    case 'blocked':
      return 'blocked';
    case 'unsupported':
      return 'unsupported';
    case 'invalid':
      return 'format';
    default:
      break;
  }
  if (code.includes('CODEC') || code === 'APPEND_ERROR' || code === 'MEDIA_4') {
    return 'codec';
  }
  if (code === 'NO_FRAMES') {
    return 'no-frames';
  }
  if (code === 'SOURCE_STALLED') {
    return 'stalled';
  }
  if (code.startsWith('HLS_HTTP_4') || code.includes('MANIFEST_INVALID') || code === 'FORMAT_MISMATCH') {
    return 'unreachable';
  }
  if (context.engineFormat === 'hls' || context.engineFormat === 'dash') {
    return 'network';
  }
  return 'network';
}

/**
 * Owns the playback lifecycle: engine creation, event normalisation, bounded
 * recovery, bounded multi-source fallback (spec §5.4) and teardown. Exactly one
 * engine exists at a time; switching channel or source always destroys the
 * previous engine first.
 *
 * Recovery rules (deterministic, one owner per decision):
 * - `handleError` is the only place that decides what happens to an engine error;
 * - a `transient` failure retries the *same* source at most MAX_AUTO_RETRIES times;
 * - a `blocked` failure never retries and never falls back (refusal != fault);
 * - an `unsupported` failure stops (this browser cannot play the container);
 * - everything else (permanent / invalid / exhausted transient) records the
 *   failure and advances to the next eligible source exactly once;
 * - only `retry()` re-enables a source that was recorded as failed.
 */
@Injectable({ providedIn: 'root' })
export class PlayerController {
  private readonly engineFactory = inject(PLAYER_ENGINE_FACTORY);
  private readonly youtubeResolver = inject(YOUTUBE_LIVE_RESOLVER);
  private readonly statusState = signal<PlayerStatus>('idle');
  private readonly engineState = signal<EngineLabel>('none');
  private readonly channelState = signal<Channel | undefined>(undefined);
  private readonly sourceState = signal<MediaSource | undefined>(undefined);
  private readonly sourceIndexState = signal(0);
  private readonly qualitiesState = signal<readonly QualityLevel[]>([]);
  private readonly currentQualityState = signal(-1);
  private readonly audioState = signal<readonly MediaTrack[]>([]);
  private readonly subtitlesState = signal<readonly MediaTrack[]>([]);
  /**
   * The subtitle track the user selected, `'off'` for none, or `undefined`
   * while nobody has chosen.
   *
   * None of the engines reports its *current* text track back (they report only
   * the available list), so the selection is owned here. That keeps the UI's
   * `<select>` truthful instead of guessing from track order.
   */
  private readonly subtitleSelectionState = signal<number | 'off' | undefined>(undefined);
  private readonly errorState = signal<PlayerErrorInfo | undefined>(undefined);
  private readonly attemptsState = signal(0);
  private readonly failedState = signal<readonly SourceFailureRecord[]>([]);
  private readonly noticeState = signal<string | undefined>(undefined);
  /**
   * Where the user can still watch the active channel when we could not check or
   * reproduce it in-app (its official YouTube live page). Never invented: it is
   * always a URL the catalogue or the resolver actually returned.
   */
  /**
   * The channel a load is for, set before the ledger is reset. It lets the view's
   * re-attach effect (`ensureLive`) tell "same channel, put the player back" from
   * "nothing loaded yet".
   */
  private readonly lastChannelState = signal<Channel | undefined>(undefined);
  private readonly watchableState = signal<string | undefined>(undefined);
  private readonly isPlayingState = signal(false);
  private readonly autoplayBlockedState = signal(false);
  private readonly readyState = signal(false);
  /** Current volume/mute, always up to date for retries and source switches. */
  private readonly optionsState = signal({ volume: 0.8, muted: false });

  readonly snapshot = computed<PlayerSnapshot>(() => ({
    status: this.statusState(),
    engine: this.engineState(),
    channel: this.channelState(),
    source: this.sourceState(),
    sourceIndex: this.sourceIndexState(),
    qualities: this.qualitiesState(),
    currentQuality: this.currentQualityState(),
    audioTracks: this.audioState(),
    subtitleTracks: this.subtitlesState(),
    subtitleSelection: this.subtitleSelectionState(),
    error: this.errorState(),
    attempts: this.attemptsState(),
    failedSources: this.failedState(),
    notice: this.noticeState(),
    watchableUrl: this.watchableState(),
  }));

  readonly status = this.statusState.asReadonly();
  readonly isPlaying = this.isPlayingState.asReadonly();
  /** True when the browser blocked autoplay and the user must press play. */
  readonly autoplayBlocked = this.autoplayBlockedState.asReadonly();
  /** True once the media has reported enough data to start. */
  readonly ready = this.readyState.asReadonly();
  /** Source failures recorded for this load, in the order they happened. */
  readonly failures = this.failedState.asReadonly();
  /** Whether the active source can be attempted in app. */
  readonly activeSourceEligible = computed(() => {
    const source = this.sourceState();
    return Boolean(source && isEligibleSource(source));
  });

  private media: HTMLVideoElement | undefined;
  private mediaHost: HTMLElement | undefined;
  private engine: PlayerEngine | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  /** The in-flight engine creation of the current generation, if any. */
  private startPromise: Promise<void> | undefined;

  /** Binds the media element owned by the player component. */
  attachMedia(media: HTMLVideoElement): void {
    this.media = media;
  }

  /**
   * Binds the element the official YouTube player mounts its frame in. Optional:
   * without it a YouTube source is never started (nothing could show it).
   */
  attachHost(host: HTMLElement): void {
    this.mediaHost = host;
  }

  detachMedia(): void {
    this.clear();
    this.media = undefined;
    this.mediaHost = undefined;
  }

  /** Sources of the active channel, annotated with eligibility for the in-app player. */
  sourceOptions(): SourceOption[] {
    const channel = this.channelState();
    return (channel?.sources ?? []).map((source, index) => ({ source, index, eligible: isEligibleSource(source) }));
  }

  /** Index of the first eligible source, or 0 when none is eligible. */
  private firstEligibleIndex(channel: Channel): number {
    const index = channel.sources.findIndex(
      (source) => isEligibleSource(source) || youtubeChannelSource(source),
    );
    return index >= 0 ? index : 0;
  }

  /**
   * Loads `channel` starting at `source` (or at the first eligible source).
   * Always tears down the previous engine and resets the fallback ledger.
   * Resolves only once the engine creation (or its fallback) has settled, so
   * callers observe the real outcome instead of an intermediate `loading`.
   */
  /**
   * The view tells the controller it has rendered (or re-rendered) its host.
   *
   * This is the ONE signal that puts a running player back on screen. It is
   * called after the component's `load()` has settled, so it never races the
   * engine creation; and it is the same path for a first render and a return.
   */
  onHostReady(host: HTMLElement): void {
    this.mediaHost = host;
    if (this.engine?.isUnobservable) {
      this.ensureLive();
    }
  }

  async load(channel: Channel, source: MediaSource | undefined, options: { volume: number; muted: boolean }): Promise<void> {
    /*
     * A named source is a request, not a reset. Returning to the SAME channel and
     * source keeps the running engine: `clear()` below would destroy a healthy
     * player, and rebuilding it spends the channel's remaining attempts — which is
     * what turned "switch away and come back" into a permanent error.
     */
    const currentSource = this.sourceState();
    const currentChannel = this.channelState();
    if (
      source &&
      currentChannel?.id === channel?.id &&
      currentSource?.id === source.id &&
      this.engine &&
      this.statusState() !== 'idle'
    ) {
      this.channelState.set(channel);
      this.optionsState.set({ volume: options.volume, muted: options.muted });
      // The player is put back by `onHostReady`, once this load has settled.
      return;
    }
    this.clear();
    /*
     * `clear()` drops the channel unconditionally; the player component's own
     * visibility effect may run in this same flush and ask `ensureLive()` whether
     * there is a channel. Remembering it here keeps that answer honest, even
     * though it is released again before rendering.
     */
    this.lastChannelState.set(channel);
    if (!channel || !this.media) {
      return;
    }
    this.channelState.set(channel);
    this.optionsState.set({ volume: options.volume, muted: options.muted });
    const channelSources = channel.sources;
    /*
     * Never start an engine when the channel publishes nothing the in-app
     * player could attempt: the verified UI shows the official route instead.
     *
     * A YouTube *channel* page is a route the in-app player does attempt: it is
     * resolved to the channel's current live video (documented Data API) and
     * played by the official player. So it counts as attemptable here even
     * though no media engine can address it directly (`startAt` resolves it).
     */
    const attemptable = (candidate: MediaSource): boolean =>
      isEligibleSource(candidate) || youtubeChannelSource(candidate);
    if (!channelSources.some(attemptable)) {
      if (channelSources.length > 0) {
        // Every published route is geo-locked/encrypted/embed-only: say so per
        // source instead of pretending the channel simply has no emission.
        for (const candidate of channelSources) {
          this.recordFailure(candidate, blockedErrorFor(candidate), 'blocked');
        }
        this.transition(this.terminalNoFallbackStatus('blocked'));
        return;
      }
      // Nothing published at all: not a refusal, just no emission.
      this.transition(hasOfficialRoute(channel) ? 'external' : 'unavailable');
      return;
    }
    // A geo-locked source can never be handed to an engine, so start on it
    // anyway: startAt() records why and advances to the next eligible source.
    const requestedIndex = source ? channelSources.findIndex((candidate) => candidate.id === source.id) : -1;
    // The first eligible source is index 0 in the tests' contract and also what
    // a user expects when the requested one is unusable.
    await this.startAt(requestedIndex >= 0 ? requestedIndex : this.firstEligibleIndex(channel));
  }

  /** Restarts the active source, used by the visible retry action. */
  async retry(volume: number, muted: boolean): Promise<void> {
    const source = this.sourceState();
    if (!source) {
      return;
    }
    this.errorState.set(undefined);
    this.noticeState.set(undefined);
    /*
     * A retry on a channel embed is a RE-MOUNT of the player we already have, not
     * a new resolution. Rebuilding the engine only to discover that the resolver
     * has no attempts left turned "retry" into "show the error instantly", which
     * is exactly the intermittent behaviour the user reported.
     */
    if (this.recoverLiveEngine()) {
      return;
    }
    // A manual retry is a new user intent: reset the automatic-attempt budget
    // and allow the active source to be attempted again.
    this.attemptsState.set(0);
    this.failedState.update((records) => records.filter((record) => record.sourceId !== source.id));
    this.optionsState.set({ volume, muted });
    if (!isEligibleSource(source) && !youtubeChannelSource(source)) {
      // A blocked source is never handed to an engine: say so and stop.
      this.errorState.set({ code: 'BLOCKED_SOURCE', message: 'Esta fuente no se puede reproducir aquí (bloqueo regional o del emisor).', recoverable: false });
      this.stopForStatus('blocked');
      return;
    }
    await this.start(source, { volume, muted });
  }

  /**
   * Re-mounts the live channel embed when the user is still on it.
   *
   * Returns `true` when a recovery happened, so callers do not rebuild anything.
   * Bounded by the engine's own budget: when it is spent, the normal path runs and
   * the reason is shown.
   */
  private recoverLiveEngine(): boolean {
    const engine = this.engine;
    if (!engine?.recoverIfStuck) {
      return false;
    }
    if (!engine.recoverIfStuck()) {
      return false;
    }
    this.errorState.set(undefined);
    this.noticeState.set(undefined);
    this.failedState.set([]);
    this.isPlayingState.set(false);
    this.ensureLive();
    return true;
  }

  /**
   * Moves the live YouTube player into the element the new component provides.
   *
   * The engine owns its frame; the host element belongs to the view. On a route
   * return the frame is still connected to the OLD host, which is gone. Moving it
   * keeps the already-playing player instead of rebuilding it. Returns `false`
   * if there is nothing to move, so the caller falls back to a fresh start.
   */
  private attachEngineToCurrentHost(): boolean {
    const host = this.mediaHost;
    if (!host) {
      return false;
    }
    if (this.engine?.isUnobservable) {
      // The engine's own frame keeps playing: only its container changed.
      if (this.engine.reattachTo?.(host)) {
        this.readyState.set(true);
        return true;
      }
      return false;
    }
    return false;
  }

  /**
   * Tells the engine what the embedded player currently looks like. Called by the
   * UI on an interval with the result of its own (same-origin) inspection; it
   * never reads YouTube's content.
   */
  reportLiveEngineVisibility(paints: boolean | undefined): void {
    this.engine?.reportEmbedVisibility?.(paints);
  }

  /**
   * Puts an active channel embed back on screen after a view/route transition.
   *
   * The player lives in a component that is re-created when the user comes back to
   * the channel. Mounting the engine again is the whole point here — unlike
   * `load()`, which refuses to repeat a route whose attempts are spent.
   */
  ensureLive(): boolean {
    const engine = this.engine;
    const source = this.sourceState();
    if (!engine?.remount || !source || !this.media || !this.lastChannelState()) {
      return false;
    }
    if (!isEligibleSource(source) && !youtubeChannelSource(source)) {
      return false;
    }
    if (this.statusState() === 'playing') {
      return false;
    }
    /*
     * Coming back to the channel: forgive the mount attempt the previous visit
     * spent. This is what stops "switch away and back" from ending in a permanent
     * error on the third visit.
     */
    const target = resolveYoutubeTarget(source.url);
    if (target.ok && target.target.kind === 'channel') {
      forgiveChannelEmbedAttempt(target.target.channelId);
    }
    // Put the existing player back where the view renders it, then keep it.
    this.attachEngineToCurrentHost();
    engine.remount();
    this.transition('select-source');
    this.readyState.set(true);
    this.isPlayingState.set(false);
    return true;
  }

  /** Explicitly selects another source (picker). Resets the ledger for that source only. */
  async selectSource(index: number, volume: number, muted: boolean): Promise<void> {
    const channel = this.channelState();
    if (!channel || !channel.sources[index]) {
      return;
    }
    this.errorState.set(undefined);
    this.noticeState.set(undefined);
    this.optionsState.set({ volume, muted });
    await this.startAt(index);
  }

  private transition(event: PlayerEvent): void {
    this.statusState.update((status) => reducePlayerStatus(status, event));
  }

  private async startAt(index: number): Promise<void> {
    const channel = this.channelState();
    const source = channel?.sources[index];
    if (!source) {
      return;
    }
    this.sourceIndexState.set(index);
    this.sourceState.set(source);
    this.attemptsState.set(0);
    // A channel page is attemptable: `start()` resolves it to the live video and
    // mounts the official player. Only truly unusable routes are skipped here.
    if (!isEligibleSource(source) && !youtubeChannelSource(source)) {
      // The engine still in flight for this very source (creation started
      // before the decision to skip it) would otherwise install itself after
      // the skip and start playing a route we refused.
      this.destroyEngine();
      this.recordFailure(source, blockedErrorFor(source), 'blocked');
      // Blocked sources are never retried; try the next eligible one once.
      const next = this.nextEligibleAfter(source, 'transient');
      if (next !== undefined) {
        this.noticeState.set(`${source.label} no está disponible aquí. Se prueba con ${channel?.sources[next]?.label}.`);
        await this.startAt(next);
        return;
      }
      this.errorState.set({
        code: 'BLOCKED_SOURCE',
        message: 'Ninguna de las fuentes de este canal se puede reproducir aquí (bloqueo regional o del emisor).',
        recoverable: false,
      });
      this.stopForStatus(this.terminalNoFallbackStatus('blocked'));
      return;
    }
    await this.start(source, this.currentOptions());
  }

  /**
   * Resolves a channel/handle YouTube source to its current live video id.
   *
   * Returns the URL the engine must address when the channel now has a specific
   * video. Returns `undefined` after settling the channel itself — offline, not
   * embeddable, or unresolvable — because there is nothing to mount in any of
   * those cases.
   */
  private async resolveChannelSource(source: MediaSource, generation: number): Promise<string | undefined> {
    const resolution = await this.youtubeResolver(source.url, runtimeYoutubeKey() ?? '').catch(() => ({
      kind: 'unplayable' as const,
      message: 'No se ha podido comprobar la emisión de YouTube en este momento.',
      cause: 'unavailable' as const,
    }));
    if (generation !== this.generation) {
      return undefined;
    }
    if (resolution.kind === 'video') {
      // The engine addresses the resolved video, not the channel page.
      const resolvedSource: MediaSource = {
        ...source,
        url: `https://www.youtube.com/live/${resolution.videoId}`,
      };
      this.sourceState.set(resolvedSource);
      return resolvedSource.url;
    }
    if (resolution.kind === 'channel-embed') {
      /*
       * No API key: play the channel through YouTube's own documented channel
       * embed. The engine addresses the channel, not a video id, and marks the
       * result as unobservable — the UI then never claims `playing`.
       */
      const embedSource: MediaSource = {
        ...source,
        url: youtubeChannelLiveUrl(resolution.channelId),
      };
      this.sourceState.set(embedSource);
      return embedSource.url;
    }
    /*
     * Every other outcome is a failed in-app route, and it goes through the SAME
     * recovery path as any other failed source: the reason is recorded, and the
     * next attemptable source of the channel is tried before giving up. A
     * channel that publishes a YouTube page AND an HLS stream must still play
     * over HLS when the YouTube route cannot be resolved.
     *
     * A channel we could not check is recorded as `unavailable`, NOT as offline:
     * claiming "it is not broadcasting" is a statement about the world, and it is
     * exactly the kind of unearned claim this app must not make.
     */
    const failure: PlayerErrorInfo =
      resolution.kind === 'offline'
        ? {
            code: 'YOUTUBE_CHANNEL_OFFLINE',
            message: 'El canal no está emitiendo ahora.',
            recoverable: false,
          }
        : resolution.kind === 'not-embeddable'
          ? {
              code: 'YOUTUBE_NOT_EMBEDDABLE',
              message: 'El creador no permite ver esta retransmisión fuera de YouTube.',
              recoverable: false,
            }
          : {
              code: 'YOUTUBE_UNCERTAIN',
              message:
                resolution.message ||
                'No se puede comprobar si el canal está emitiendo; su emisión sigue disponible en YouTube.',
              recoverable: false,
            };
    this.errorState.set(failure);
    /*
     * A route we could not check leaves a way out: the channel's own live page.
     * It is carried by the source when the published URL is already a page (a
     * channel, a handle), so the UI can always offer "Ver en YouTube".
     */
    if (failure.code === 'YOUTUBE_UNCERTAIN' && resolution.kind === 'unplayable') {
      this.watchableState.set(('url' in resolution ? resolution.url : undefined) ?? source.url);
    }
    this.handleError(failure, source, this.currentOptions());
    return undefined;
  }

  private async start(source: MediaSource, options: { volume: number; muted: boolean }): Promise<void> {
    const media = this.media;
    if (!media) {
      return;
    }
    /*
     * Coming back to a channel must not rebuild what is already running.
     *
     * A route/view return recreates the player component but leaves this
     * controller (and its engine) alive. Rebuilding here tore down a healthy
     * player, spent the channel's attempt budget again and, once spent, showed
     * "no se ha podido reproducir" for a channel that had just worked — the exact
     * loop reported by the user. The engine is reused when the source is the same.
     */
    if (this.engine && this.sourceState()?.id === source.id && this.statusState() !== 'idle') {
      /*
       * An unobservable third-party player is re-attached by the view effect
       * (`ensureLive`), which runs after this load settles. Re-mounting it here
       * would consume another of the channel's mount attempts AND fight the view
       * for the same host — the loop the user reported.
       */
      if (this.engine.isUnobservable) {
        this.readyState.set(true);
        return;
      }
      // A media engine is simply handed the freshly rendered `<video>`.
      if (this.attachEngineToCurrentHost()) {
        return;
      }
    }
    /*
     * When a YouTube channel's player is re-mounted on a return, the route already
     * consumed an attempt. Rebuilding the engine only to find the resolver spent
     * produced the "a veces funciona y otras no" loop; so the spent attempt is
     * forgiven BEFORE the engine is rebuilt.
     */
    const target = resolveYoutubeTarget(source.url);
    if (this.engine?.isUnobservable && target.ok && target.target.kind === 'channel') {
      forgiveChannelEmbedAttempt(target.target.channelId);
    }
    // A start supersedes any engine creation still in flight: that one will see
    // a stale generation and release its engine instead of installing it.
    this.cancelPendingStart();
    const generation = ++this.generation;
    this.clearCascades();
    // Any retry creates a brand new engine, so the previous one must be torn down
    // first; otherwise two hls.js/dash.js instances would drive the same element.
    this.destroyEngine();
    this.errorState.set(undefined);
    this.transition('select-source');
    this.qualitiesState.set([]);
    this.currentQualityState.set(-1);
    this.audioState.set([]);
    this.subtitlesState.set([]);
    this.subtitleSelectionState.set(undefined);

    const onEvent = (event: EngineEvent): void => {
      if (generation !== this.generation) {
        return;
      }
      this.handleEngineEvent(event, source, options);
    };

    // Explicit narrowing: iframe/progressive-invalid never reach an engine.
    const engineKind = toEngineKind(source.format);
    if (!engineKind) {
      // Embeds and unknown formats never reach an engine: refer to the official player.
      this.errorState.set({ code: 'OFFICIAL_PLAYER_REQUIRED', message: 'Esta emisión solo se puede ver en el reproductor oficial del emisor.', recoverable: false });
      this.stopForStatus('external');
      return;
    }

    /*
     * A YouTube *channel* page names a channel, not a video. Resolve it through
     * the documented Data API to the channel's current live video before any
     * engine is created, so the official player drives a specific, observable
     * video. Every outcome is explained; none is guessed.
     */
    let engineUrl = source.url;
    if (engineKind === 'youtube' && !youtubeVideoSource(source)) {
      const resolvedUrl = await this.resolveChannelSource(source, generation);
      if (!resolvedUrl || generation !== this.generation) {
        return;
      }
      engineUrl = resolvedUrl;
    }

    const pending = (async (): Promise<void> => {
      let engine: PlayerEngine;
      try {
        engine = await this.engineFactory(
          {
            url: engineUrl,
            media,
            container: this.mediaHost,
            autoplay: true,
            startVolume: options.volume,
            muted: options.muted,
            onEvent,
          },
          engineKind,
        );
      } catch (error) {
        if (generation !== this.generation) {
          return;
        }
        /*
         * The factory throws once with the engine's own classification. A
         * refusal (a page we cannot address, the API that will not load) keeps
         * its code so `failureCodeFor` can present the real reason; only an
         * unclassified failure is a generic, retryable engine-start error.
         */
        if (error instanceof YoutubeEngineError) {
          this.handleError(
            { code: error.code, message: error.message, recoverable: error.recoverable },
            source,
            options,
          );
          return;
        }
        const message = error instanceof Error ? error.message : 'No se pudo iniciar el reproductor.';
        this.handleError({ code: 'ENGINE_START', message, recoverable: true }, source, options);
        return;
      }
      if (generation !== this.generation) {
        engine.destroy();
        return;
      }
      this.engine = engine;
      this.engineState.set(engine.kind);
      if (engine.kind === 'youtube') {
        // The official player owns its own playback start (autoplay + the
        // user's click). Its frame is not a media element: calling play() on the
        // `<video>` would neither start it nor prove anything, and the real
        // `playing` claim arrives on the engine's event stream.
        this.readyState.set(true);
        return;
      }
      await this.tryPlay();
    })();

    this.startPromise = pending;
    await pending;
    // A newer start may have taken ownership while this one was settling (a
    // fallback, a source pick, a retry). Waiting for it means a caller of
    // `start()`/`load()` never returns while an engine creation is still
    // running, so the outcome it observes is the real, final one.
    await this.startPromise;
    if (this.startPromise === pending) {
      this.startPromise = undefined;
    }
  }

  /**
   * Guards against a source that never produces frames: the element reports
   * canplay, play() resolves, but nothing is ever rendered (e.g. a 404 segment).
   * If no frame arrives within the window the source is failed visibly.
   */
  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      // Own the timer immediately: `handleError` clears cascades, and a timer
      // reference that cleared itself first would stop the retry/fallback
      // cascade after the first verdict.
      this.watchdogTimer = undefined;
      if (!this.media || this.media.videoWidth > 0) {
        return;
      }
      this.handleError(
        {
          code: 'NO_FRAMES',
          message: 'La emisión no ha empezado a reproducirse. La fuente puede no estar disponible.',
          recoverable: false,
        },
        this.sourceState() ?? ({ id: '', label: '', format: 'hls', url: '', geoRestricted: false } as MediaSource),
        this.currentOptions(),
      );
    }, 12_000);
  }

  /**
   * A source that stays in buffering for a long time is a stalled signal.
   * Resuming playback clears this timer, so it always begins at the start of a
   * fresh stall.
   */
  private armStallTimer(): void {
    this.clearStallTimer();
    this.stallTimer = setTimeout(() => {
      // Same ownership rule as the no-frame watchdog (see armWatchdog).
      this.stallTimer = undefined;
      if (this.statusState() !== 'buffering') {
        return;
      }
      this.handleError(
        {
          code: 'SOURCE_STALLED',
          message: 'La emisión se ha interrumpido y no se recupera. La fuente puede no estar disponible.',
          recoverable: false,
        },
        this.sourceState() ?? ({ id: '', label: '', format: 'hls', url: '', geoRestricted: false } as MediaSource),
        this.currentOptions(),
      );
    }, 20_000);
  }

  private clearStallTimer(): void {
    if (this.stallTimer !== undefined) {
      clearTimeout(this.stallTimer);
      this.stallTimer = undefined;
    }
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== undefined) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  /**
   * Re-arms the no-frame watchdog after `play()` resolved. An automatic retry
   * attaches a new engine and calls `play()` again, which clears the previous
   * timeout; without this re-check a source that keeps "playing" nothing would
   * never be judged.
   */
  private rearmWatchdogIfNoFrames(): void {
    const media = this.media;
    if (!media || media.videoWidth > 0 || this.watchdogTimer === undefined) {
      return;
    }
    this.clearWatchdog();
    this.armWatchdog();
  }

  private async tryPlay(): Promise<void> {
    if (!this.engine || !this.media) {
      return;
    }
    // A blocked source is skipped in the same turn it is selected, but its
    // engine creation may settle on a later microtask. Playing that stream
    // would claim success for a route we deliberately refused; the fallback
    // already owns the state machine at that point.
    const active = this.sourceState();
    if (active && !isEligibleSource(active)) {
      return;
    }
    this.armWatchdog();
    try {
      // Use the media element directly so no engine wrapper can swallow the
      // promise or return early while the element stays paused.
      await this.media.play();
      this.isPlayingState.set(true);
      this.autoplayBlockedState.set(false);
      // `play()` resolving only proves the request was accepted, not that the
      // stream renders: the source stays `loading` and the engine's real
      // `playing` event (or the no-frame watchdog) settles it. Claiming
      // `playing` here would report a healthy player over a dead stream.
      this.rearmWatchdogIfNoFrames();
    } catch (error) {
      this.isPlayingState.set(false);
      const name = error instanceof Error ? error.name : '';
      if (name === 'NotAllowedError') {
        // Browser autoplay policy: the stream is loaded and ready; the user must
        // start it explicitly. This is not an error condition.
        this.autoplayBlockedState.set(true);
        this.transition('can-play');
        return;
      }
      if (name === 'AbortError') {
        // Superseded by a newer load() call; the generation guard drops it.
        return;
      }
      this.handleError(
        { code: 'PLAY_REJECTED', message: 'La emisión no ha podido iniciarse.', recoverable: true },
        this.sourceState(),
        this.currentOptions(),
      );
    }
  }

  private handleEngineEvent(event: EngineEvent, source: MediaSource, options: { volume: number; muted: boolean }): void {
    switch (event.type) {
      case 'manifest-ready':
        this.qualitiesState.set(event.qualities);
        this.transition('manifest-ready');
        break;
      case 'quality-changed':
        this.currentQualityState.set(event.index);
        break;
      case 'tracks':
        this.audioState.set(event.audio);
        this.subtitlesState.set(event.subtitles);
        // A chosen track that the new source does not carry is dropped, so the
        // UI never shows a selection that no longer exists.
        if (typeof this.subtitleSelectionState() === 'number') {
          const selected = this.subtitleSelectionState() as number;
          if (!event.subtitles.some((track) => track.id === selected)) {
            this.subtitleSelectionState.set(undefined);
          }
        }
        break;
      case 'can-play':
        this.readyState.set(true);
        if (this.statusState() === 'loading') {
          this.transition('can-play');
        }
        break;
      case 'playing':
        // A late `playing` from a source already marked as failed must not
        // resurrect the UI: the error state stays until an explicit retry.
        if (this.statusState() === 'error' || this.statusState() === 'unavailable' || this.statusState() === 'blocked' || this.statusState() === 'unsupported') {
          break;
        }
        this.isPlayingState.set(true);
        this.errorState.set(undefined);
        this.noticeState.set(undefined);
        this.clearWatchdog();
        this.clearStallTimer();
        this.transition('playing');
        break;
      case 'waiting':
        if (this.statusState() === 'playing') {
          this.armStallTimer();
        }
        this.transition('waiting');
        break;
      case 'pause':
        this.isPlayingState.set(false);
        // hls.js emits a pause while re-attaching media; only a pause from a
        // non-loading state is a real, user-visible pause.
        if (this.statusState() === 'playing' || this.statusState() === 'buffering') {
          this.transition('pause');
        }
        break;
      case 'ended':
        this.isPlayingState.set(false);
        this.transition('ended');
        /*
         * Only a MEDIA engine can be restarted this way: it owns the `<video>`
         * element that `tryPlay()` drives. For the YouTube engine the stream is
         * the official player's own: an ended live means it stopped broadcasting,
         * and calling `play()` on our empty `<video>` would either reject
         * (`PLAY_REJECTED`) or trip the no-frames watchdog on a stream nobody
         * tried to play. The honest outcome is "not playing" and the player is
         * left where the platform put it.
         */
        if (this.engine?.kind !== 'youtube' && this.media && this.isLiveLike()) {
          this.media.currentTime = 0;
          void this.tryPlay();
        }
        break;
      case 'unsupported':
        this.errorState.set({ code: 'UNSUPPORTED', message: event.reason, recoverable: false });
        this.stopForStatus('unsupported');
        break;
      case 'error':
        this.handleError({ code: event.code, message: event.message, recoverable: event.recoverable }, source, options);
        break;
    }
  }

  /**
   * The single owner of an engine error (spec §5.4). Every branch is exclusive:
   * 1. `blocked` (DRM/geo/refusal): record, never retry this source, but do try
   *    another eligible source — a geo lock applies to one route, not the channel;
   * 2. `unsupported`: this browser cannot decode this container — stop retrying
   *    it and try another source (which may use a different format);
   * 3. `transient` with budget left: retry the same source after a delay;
   * 4. otherwise: record the failure and advance to the next eligible source
   *    exactly once, or end the channel as `unavailable` / `blocked` / `external`.
   * Only `retry()` (and a manual source pick) re-enables a recorded failure.
   */
  private handleError(
    reported: PlayerErrorInfo,
    source: MediaSource | undefined,
    options: { volume: number; muted: boolean },
  ): void {
    // Normalise the engine's own vocabulary first (see failureCodeFor).
    const error = failureCodeFor(reported);
    const failureClass = classifyFailure(error);
    const attempts = this.attemptsState();

    if (failureClass === 'transient' && attempts < MAX_AUTO_RETRIES && source) {
      this.attemptsState.set(attempts + 1);
      const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)];
      this.clearRetryTimer();
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        if (!this.media || this.sourceState()?.id !== source.id) {
          return;
        }
        void this.start(source, this.currentOptions());
      }, delay);
      return;
    }
    this.recordFailure(source, error, failureClass);
    // `nextFallbackIndex` only advances for a transient failure; a refuted route
    // (geo/DRM, undecodable container, dead source) must still try another
    // source, so it is asked with transient semantics. The current source is
    // excluded by index and by the failure ledger, so it is never retried.
    const next = this.nextEligibleAfter(source, 'transient');
    if (next !== undefined) {
      const nextSource = this.channelState()?.sources[next];
      this.noticeState.set(`${source?.label ?? 'La emisión'} no está disponible. Se prueba con ${nextSource?.label ?? 'otra fuente'}.`);
      // The fallback is decided synchronously: the failed engine is released
      // here, and starting the next source clears any cascading timers again.
      this.clearCascades();
      this.destroyEngine();
      void this.startAt(next);
      return;
    }
    this.finishWithoutFallback(error, source, failureClass);
  }

  /** Terminal handling of a failure no other source can cover. */
  private finishWithoutFallback(error: PlayerErrorInfo, _source: MediaSource | undefined, failureClass: FailureClass): void {
    // `stopForStatus` releases the engine and cancels pending timers even when
    // the target status already equals the current one, so no explicit
    // already-terminal branch is needed here.
    this.stopForStatus(this.terminalNoFallbackStatus(failureClass));
    this.errorState.set(error);
  }

  /**
   * Maps an exhaustion to the user-visible terminal state from the whole
   * failure ledger, not just the last failure:
   * - an emitter route means the user can still watch it there (`external`);
   * - a channel whose remaining routes are all refusals is `blocked`;
   * - a browser that cannot decode the published container is `unsupported`;
   * - otherwise the channel's sources are simply dead: `unavailable`.
   */
  private terminalNoFallbackStatus(failureClass: FailureClass): PlayerEvent {
    const classes = new Set(this.failedState().map((record) => record.failureClass));
    classes.add(failureClass);
    classes.delete('transient');
    // A stream that no longer exists is not "see it on the emitter's page", and
    // that outranks every class-based verdict below.
    const gone = this.failedState().some((record) => NO_OFFICIAL_ROUTE_CODES.includes(record.code));
    if (gone) {
      return 'unavailable';
    }
    /*
     * A refusal is the answer, not a detour: when the emitter forbids embedding
     * of a YouTube stream (or the request lacks the client identity YouTube
     * requires), telling the user "this is seen in the official player" would
     * replace the real reason with a generic link. The refusal is rendered with
     * its own explanation and the official page is still offered as an action.
     *
     * Other `blocked` failures (a geo lock, a DRM key) keep the previous
     * behaviour: a published emitter route still means the user can watch it
     * there, which is more useful than a dead end.
     */
    const refusal = this.failedState().some(
      (record) => record.code === 'BLOCKED_EMBED_FORBIDDEN' || record.code === 'BLOCKED_CLIENT_IDENTITY',
    );
    if (classes.size > 0 && [...classes].every((entry) => entry === 'blocked') && (refusal || !hasOfficialRoute(this.channelState()))) {
      return 'blocked';
    }
    /*
     * A YouTube route we could not even check (no API key, a page we cannot
     * identify) is not an emitter route either: presenting it as "this is seen in
     * the official player" hides WHY nothing played. But it is not "unavailable"
     * in the sense of "nothing to watch" either — the channel keeps its own page,
     * which the action below offers. `unavailable` is the state that says "no
     * source of this channel is available now", so the wording has to match: the
     * engine shows the real reason and the official link.
     */
    const uncertain = this.failedState().some((record) => record.code === 'YOUTUBE_UNCERTAIN');
    if (uncertain && this.failedState().length <= 1) {
      return 'external';
    }
    if (hasOfficialRoute(this.channelState())) {
      return 'external';
    }
    if (classes.size === 1 && classes.has('unsupported')) {
      return 'unsupported';
    }
    return 'unavailable';
  }

  /** Next eligible source not yet failed, searched once around the list. */
  private nextEligibleAfter(source: MediaSource | undefined, failureClass: FailureClass): number | undefined {
    const channel = this.channelState();
    if (!channel || !source) {
      return undefined;
    }
    const currentIndex = channel.sources.findIndex((candidate) => candidate.id === source.id);
    if (currentIndex < 0 || channel.sources.length < 2) {
      return undefined;
    }
    const failed = this.failedState().map((record) => record.sourceId);
    return nextFallbackIndex(
      channel.sources.map((candidate) => ({ id: candidate.id, eligible: isEligibleSource(candidate) })),
      failed,
      currentIndex,
      failureClass,
    );
  }

  private recordFailure(source: MediaSource | undefined, error: PlayerErrorInfo, failureClass: FailureClass): void {
    if (!source) {
      return;
    }
    const record: SourceFailureRecord = {
      sourceId: source.id,
      sourceLabel: source.label,
      sourceFormat: source.format,
      cause: causeFor(error, { engineFormat: source.format, failureClass }),
      code: error.code,
      message: error.message,
      failureClass,
    };
    this.failedState.update((records) => [...records.filter((existing) => existing.sourceId !== source.id), record]);
  }

  /**
   * Stops playback and enters a terminal status. Always releases the engine, so a
   * failed source cannot keep playing audio behind the error overlay, and always
   * cancels pending retries and watchdogs so nothing fires later.
   */
  private stopForStatus(event: PlayerEvent): void {
    this.clearCascades();
    this.destroyEngine();
    this.isPlayingState.set(false);
    this.transition(event);
  }

  /** Destroys the current engine and clears the reference. Idempotent. */
  private destroyEngine(): void {
    this.engine?.destroy();
    this.engine = undefined;
    this.engineState.set('none');
  }

  /** Live-style sources are restarted at the beginning when they end. */
  private isLiveLike(): boolean {
    return this.sourceState() !== undefined;
  }

  private currentOptions(): { volume: number; muted: boolean } {
    return this.optionsState();
  }

  async togglePlay(): Promise<void> {
    if (this.engine?.kind === 'youtube') {
      // The official player is the only thing that can start a YouTube stream;
      // the `<video>` element is empty and its `paused` flag means nothing here.
      if (this.statusState() === 'paused' || this.statusState() === 'loading') {
        await this.engine.play();
      } else {
        this.engine.pause();
      }
      return;
    }
    if (this.media?.paused) {
      await this.tryPlay();
      return;
    }
    this.clearWatchdog();
    this.clearStallTimer();
    this.engine?.pause();
  }

  setVolume(volume: number): void {
    this.optionsState.update((current) => ({ ...current, volume }));
    this.engine?.setVolume(volume);
  }

  setMuted(muted: boolean): void {
    this.optionsState.update((current) => ({ ...current, muted }));
    this.engine?.setMuted(muted);
  }

  setQuality(index: number | 'auto'): void {
    this.engine?.setQuality(index);
  }

  setAudioTrack(id: number | null): void {
    this.engine?.setAudioTrack(id);
  }

  /**
   * Selects a subtitle track, `'off'` to turn subtitles off.
   *
   * The selection is recorded here as well as forwarded to the engine, because
   * no engine reports its current text track back; without it the UI could not
   * show which track is active.
   */
  setSubtitleTrack(id: number | 'off'): void {
    this.subtitleSelectionState.set(id);
    this.engine?.setSubtitleTrack(id);
  }

  seekToLive(): void {
    this.engine?.seekToLive();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  /**
   * Cancels every scheduled reaction to the current engine: retries, the no-frame
   * watchdog and the stall timer. Called whenever ownership of playback moves on
   * (new engine, fallback, terminal state) so a stale timer cannot re-decide.
   */
  private clearCascades(): void {
    this.clearRetryTimer();
    this.clearWatchdog();
    this.clearStallTimer();
  }

  /**
   * Ensures no engine creation from an older generation can still settle. The
   * generation check already makes late creations destroy themselves; this marks
   * the in-flight creation as no longer owned by the controller.
   */
  private cancelPendingStart(): void {
    this.startPromise = undefined;
  }

  /** Destroys the engine and resets state. Idempotent. */
  clear(): void {
    this.generation += 1;
    this.startPromise = undefined;
    this.clearCascades();
    this.destroyEngine();
    this.channelState.set(undefined);
    this.sourceState.set(undefined);
    this.sourceIndexState.set(0);
    this.qualitiesState.set([]);
    this.currentQualityState.set(-1);
    this.audioState.set([]);
    this.subtitlesState.set([]);
    this.subtitleSelectionState.set(undefined);
    this.errorState.set(undefined);
    this.attemptsState.set(0);
    this.failedState.set([]);
    this.noticeState.set(undefined);
    this.watchableState.set(undefined);
    this.isPlayingState.set(false);
    this.autoplayBlockedState.set(false);
    this.readyState.set(false);
    this.statusState.set('idle');
  }
}
