/**
 * YouTube's official IFrame player as a `PlayerEngine` (TDT-CLONE-12 §2/§4).
 *
 * It implements the same contract as the hls.js and dash.js engines — play,
 * pause, volume, mute, live seek, teardown and one normalised `EngineEvent`
 * stream — so `PlayerController` treats it exactly like any other backend.
 *
 * What it does:
 * - loads the published IFrame Player API (lazily, once, browser only);
 * - creates the player on the **privacy-enhanced** host (`youtube-nocookie.com`)
 *   with `origin` restricted to our own origin;
 * - maps `YT.PlayerState` onto our events. `playing` is emitted **only** for
 *   `PLAYING (1)`; `BUFFERING (3)` is `waiting`; `ready` is NOT `playing`;
 * - maps YouTube error codes onto classified, actionable failures — notably
 *   100 (gone), 101/150 (owner forbids embedding) and 153 (no client identity);
 * - destroys the player and removes its frame on `destroy()`, so switching
 *   channel never leaves two players running.
 *
 * What it deliberately does NOT do:
 * - it never resolves manifests, extracts media URLs or imitates a first-party
 *   client: the official player page is the only thing it addresses;
 * - it never touches hls.js/dash.js;
 * - it never hides YouTube's marks or controls (`controls` stays at the
 *   default, `modestbranding`/`rel` are the only cosmetic parameters, both
 *   published and both honoured by the player itself);
 * - it applies no CSS to the frame, so no overlay of ours can cover the official
 *   controls at the frame's own origin.
 */
import {
  classifyYoutubeError,
  loadYoutubeApi,
  youtubeChannelLiveUrl,
  youtubeVideoEmbedConfig,
  YOUTUBE_PLAYER_STATE,
  type YoutubeApi,
  type YoutubePlayer,
} from '../integrations/youtube-embed';
import type { EngineEvent, EngineKind, EngineOptions, PlayerEngine } from './engine';
import { resolveYoutubeTarget } from '../integrations/youtube-target';

/** Error codes the player reports, kept as names for diagnostics. */
export const YOUTUBE_ERROR_CODES = {
  invalidParameter: 2,
  html5: 5,
  notFound: 100,
  embedDisabled: 101,
  embedDisabledAlt: 150,
  missingClientIdentity: 153,
} as const;

/**
 * Error code for a source we cannot address at all. `BLOCKED_*` prefixes are
 * classified as refusals (never retried), which is exactly right for them.
 */
export const YOUTUBE_UNRESOLVED = 'BLOCKED_YOUTUBE_UNRESOLVED';
export const YOUTUBE_CHANNEL_OFFLINE = 'BLOCKED_YOUTUBE_CHANNEL_OFFLINE';
export const YOUTUBE_API_UNAVAILABLE = 'BLOCKED_YOUTUBE_API_UNAVAILABLE';
export const YOUTUBE_API_LOAD = 'YOUTUBE_API_LOAD';

export interface YoutubeEngineDeps {
  /** Injected in tests; defaults to the published loader. */
  readonly loadApi?: () => Promise<YoutubeApi>;
  /** Injectable clock for the no-frames watchdog. */
  readonly now?: () => number;
  /** How long to wait for PLAYING before calling it stalled. Default 15 s. */
  readonly playingTimeoutMs?: number;
  /** How long the channel embed gets to mount before one re-mount. Default 12 s. */
  readonly channelStartTimeoutMs?: number;
}

const PLAYING_TIMEOUT_MS = 15_000;
/**
 * How long the channel embed gets to mount before it is re-mounted once. The
 * measured start is ~1-2 s; a slow or blocked first document is common on mobile
 * networks, so the first deadline is deliberately generous.
 */
const CHANNEL_START_TIMEOUT_MS = 12_000;
/** Free re-mounts of the channel embed before its failure is reported. */
const CHANNEL_REMOUNTS = 1;
/**
 * Re-mounts allowed when the user is ON the channel and the embedded player is
 * not visible (a lost document). Separately bounded from CHANNEL_REMOUNTS so a
 * missed start and a lost player each get their own, finite budget.
 */
const CHANNEL_RECOVERIES = 2;

/**
 * One YouTube player. A `PlayerEngine` for `format: 'youtube'` sources whose URL
 * carries a video id (`/live/<id>`, `/watch?v=`, `/embed/`, `youtu.be/`).
 */
export class YoutubePlaybackEngine implements PlayerEngine {
  readonly kind: EngineKind = 'youtube';

  private player: YoutubePlayer | undefined;
  private api: YoutubeApi | undefined;
  private frame: HTMLIFrameElement | undefined;
  private ready = false;
  private destroyed = false;
  private everPlayed = false;
  private volume: number;
  private muted: boolean;
  private wantsPlay = false;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  /** Re-applies frame sizing when the host or the player's frame changes. */
  private resizeObserver: ResizeObserver | undefined;
  /** The per-engine element handed to the API (which may replace it). */
  private mountPoint: HTMLElement | undefined;
  /**
   * False for the channel embed, whose playback state YouTube does not expose:
   * we never claim `playing` for it.
   */
  private observable = true;
  /** The channel the embed is for, so a lost document can be re-mounted. */
  private channelEmbedId: string | undefined;
  /**
   * Is the emission visible at all, in our page, right now?
   *
   * The channel embed cannot be observed directly, but two things can: the frame
   * is in the document, and the player paints content inside it (checked by
   * `channelEmbedDiagnostics`, which the player reports for its own diagnostics).
   * When the user is on the channel and the player is not visible, the engine
   * re-mounts it ONCE — the case where the first document was lost.
   *
   * Retrying is side-effect free (YouTube is idempotent: the same channel, a fresh
   * player), and the budget is bounded so this can never loop.
   */
  recoverIfStuck(): boolean {
    if (this.destroyed || this.observable || !this.channelEmbedId || !this.mountPoint) {
      return false;
    }
    if (this.recoveries >= CHANNEL_RECOVERIES) {
      return false;
    }
    const frame = this.frame;
    const attached = Boolean(frame?.isConnected);
    if (attached && this.lastFramePainted === true) {
      // Visible and painting: nothing to recover.
      return false;
    }
    this.recoveries += 1;
    this.remountChannelEmbed();
    return true;
  }

  /** Records what the visible player looks like; called by the UI on an interval. */
  reportEmbedVisibility(paints: boolean | undefined): void {
    this.lastFramePainted = paints;
  }

  /**
   * Puts the player back on screen for the SAME source (route or view return).
   *
   * This is not a retry budget: the channel has not changed and the user expects
   * the player where they left it. Playback state is not observable here, so the
   * honest result is `can-play` (mounted, starting) — never `playing`.
   */
  remount(): void {
    if (this.destroyed) {
      return;
    }
    if (this.observable) {
      // A video-backed player is rebuilt by the normal load path, not here.
      return;
    }
    if (this.channelEmbedId && this.mountPoint) {
      this.remountChannelEmbed();
      return;
    }
    this.options.onEvent({ type: 'can-play' });
  }

  /** Does this engine drive an unobservable (channel embed) player? */
  get isUnobservable(): boolean {
    return !this.observable;
  }

  /**
   * Moves the playing frame into a newly rendered host.
   *
   * The engine owns its mount and frame, so it — not the view or the controller —
   * decides where they live. Moving a connected iframe keeps YouTube playing it;
   * building a new one would restart the player and spend another attempt.
   */
  reattachTo(host: HTMLElement): boolean {
    if (this.destroyed || this.observable) {
      return false;
    }
    if (this.frame && !this.frame.isConnected) {
      // The frame went away with its container: nothing left to move.
      return false;
    }
    if (!this.mountPoint) {
      return false;
    }
    if (this.mountPoint.parentElement !== host) {
      host.replaceChildren(this.mountPoint);
    }
    this.sizeFrame();
    return true;
  }

  /** How many times this engine may re-mount a channel embed after a failure. */
  private recoveries = 0;
  /** Whether the embedded player was last seen painting content. */
  private lastFramePainted: boolean | undefined;
  /** Guards against a second `destroy()` or a late API load installing a frame. */
  private readonly deps: YoutubeEngineDeps;

  private constructor(
    private readonly options: EngineOptions,
    readonly videoId: string,
    deps: YoutubeEngineDeps,
  ) {
    this.volume = Math.min(100, Math.max(0, Math.round(options.startVolume * 100)));
    this.muted = options.muted;
    this.deps = deps;
  }
  /**
   * Builds the engine for an official YouTube URL, or throws with a classified
   * error when the URL is not one we can address with the official player.
   */
  static async create(options: EngineOptions, deps: YoutubeEngineDeps = {}): Promise<YoutubePlaybackEngine> {
    /*
     * Browser-only, explicitly. The official player is a third-party frame and
     * the milestone forbids running it (or anything that needs a DOM) during SSR
     * or prerender: such a call is a refusal, never a partially built engine.
     */
    if (typeof document === 'undefined') {
      throw new YoutubeEngineRefusal(
        YOUTUBE_API_LOAD,
        'El reproductor oficial de YouTube solo puede iniciarse en el navegador.',
      );
    }
    const config = youtubeVideoEmbedConfig(videoIdOf(options.url) ?? '');
    if (!config?.videoId) {
      /*
       * YouTube's documented CHANNEL embed (`/embed/live_stream?channel=…`):
       * a public player page that needs no API key and lets YouTube decide
       * whether the channel is live and whether it allows embedding. Its
       * playback state is NOT observable from here, so this engine reports the
       * honest `can-play`/paused state and never claims `playing`.
       */
      const channelId = channelIdOf(options.url);
      if (channelId) {
        const engine = new YoutubePlaybackEngine(options, '', deps);
        engine.observable = false;
        engine.mountChannelEmbed(channelId);
        return engine;
      }
      throw new YoutubeEngineRefusal(
        YOUTUBE_UNRESOLVED,
        'Esta página de YouTube no identifica una emisión concreta que podamos reproducir aquí.',
      );
    }
    const engine = new YoutubePlaybackEngine(options, config.videoId, deps);
    await engine.mount(config);
    return engine;
  }

  /**
   * Mounts the documented channel embed as a plain frame inside our own mount
   * point. Nothing is observed: the frame is YouTube's page, not an API object.
   */
  private mountChannelEmbed(channelId: string): void {
    const host = this.container();
    if (!host) {
      throw new YoutubeEngineRefusal(
        YOUTUBE_UNRESOLVED,
        'No hay ningún espacio donde montar el reproductor oficial de YouTube.',
      );
    }
    const mount = host.ownerDocument.createElement('div');
    mount.style.display = 'block';
    mount.style.width = '100%';
    mount.style.height = '100%';
    host.appendChild(mount);
    this.mountPoint = mount;
    this.channelEmbedId = channelId;
    const frame = host.ownerDocument.createElement('iframe');
    /*
     * MEASURED (`scripts/playback/probe-autoplay.mjs`, `probe-start-time.mjs`):
     * the bare channel embed mounts PAUSED, while the published `autoplay=1` and
     * `playsinline=1` start it — within ~1.0-1.8 s of 9 measurements, in every
     * run. `origin` is our own, as the published API requires.
     *
     * So the embed DOES start on its own; what we cannot do is observe it. Giving
     * up on the first sample was the intermittent "no ha podido reproducirse"
     * the user saw.
     */
    frame.setAttribute('src', youtubeChannelLiveUrl(channelId));
    frame.setAttribute('title', 'Reproductor de YouTube');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
    frame.setAttribute('allowfullscreen', '');
    frame.width = '100%';
    frame.height = '100%';
    this.frame = frame;
    frame.addEventListener('load', () => this.onFrameLoaded());
    mount.replaceChildren(frame);
    this.sizeFrame();
    // The frame is mounted and starting: who is broadcasting is YouTube's answer
    // to give inside it. We never claim `playing` for it.
    this.ready = true;
    this.unobservableAnnouncements += 1;
    this.options.onEvent({ type: 'can-play' });
    this.startUnobservableStartWatch();
  }

  /**
   * The channel embed cannot be sampled from here, but its iframe load event can.
   * If the frame never even loads, that is a real failure and is reported; while
   * it is loading we keep waiting instead of guessing.
   */
  private onFrameLoaded(): void {
    if (this.destroyed) {
      return;
    }
    this.clearWatchdog();
    // The document is there; the player inside it may still be starting.
    this.options.onEvent({ type: 'can-play' });
  }

  private startUnobservableStartWatch(): void {
    this.clearWatchdog();
    const timeout = this.deps.channelStartTimeoutMs ?? CHANNEL_START_TIMEOUT_MS;
    this.watchdog = setTimeout(() => {
      this.watchdog = undefined;
      this.onUnobservableStartTimeout();
    }, timeout);
  }

  /**
   * The embed never announced itself. Re-mount it once — the measured start is a
   * few seconds, but a blocked or slow start is transient — and only then report
   * a failure, so a single slow start does not become a dead end.
   */
  private onUnobservableStartTimeout(): void {
    if (this.destroyed || this.observable) {
      return;
    }
    if (this.unobservableAnnouncements < CHANNEL_REMOUNTS + 1 && this.channelEmbedId) {
      this.remountChannelEmbed();
      return;
    }
    this.options.onEvent({
      type: 'error',
      code: 'YOUTUBE_EMBED_NO_START',
      message: 'El reproductor de YouTube de este canal no ha llegado a cargar.',
      recoverable: false,
    });
  }

  /** Re-mounts the same channel embed: a fresh document, one more real attempt. */
  private remountChannelEmbed(): void {
    const channelId = this.channelEmbedId;
    const mount = this.mountPoint;
    if (!channelId || !mount) {
      return;
    }
    const frame = mount.ownerDocument.createElement('iframe');
    frame.setAttribute('src', youtubeChannelLiveUrl(channelId));
    frame.setAttribute('title', 'Reproductor de YouTube');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
    frame.setAttribute('allowfullscreen', '');
    frame.width = '100%';
    frame.height = '100%';
    this.frame = frame;
    frame.addEventListener('load', () => this.onFrameLoaded());
    mount.replaceChildren(frame);
    this.sizeFrame();
    this.unobservableAnnouncements += 1;
    this.options.onEvent({ type: 'can-play' });
    this.startUnobservableStartWatch();
  }

  private async mount(config: { host: string; videoId?: string; playerVars: Record<string, string | number> }): Promise<void> {
    let api: YoutubeApi;
    try {
      api = await (this.deps.loadApi ?? loadYoutubeApi)();
    } catch (error) {
      throw new YoutubeEngineRefusal(
        YOUTUBE_API_LOAD,
        error instanceof Error ? error.message : 'No se ha podido cargar el reproductor oficial de YouTube.',
      );
    }
    // Destroyed while the API was loading: never leave an orphan frame behind.
    if (this.destroyed) {
      return;
    }
    const host = this.container();
    if (!host) {
      throw new YoutubeEngineRefusal(
        YOUTUBE_UNRESOLVED,
        'No hay ningún espacio donde montar el reproductor oficial de YouTube.',
      );
    }
    this.api = api;
    /*
     * MEASURED (`scripts/playback/probe-youtube-api.mjs`): the official API
     * REPLACES the element it is given:
     *
     *   Pass the host itself -> after mounting, `host.isConnected === false`: the
     *   <div> is gone and the <iframe> now sits in the host's former PARENT. Every
     *   later call then acts on a detached node: sizing/teardown do nothing, a
     *   second player can wipe the first one's frame, and a stale destroy() can
     *   wipe a newer player.
     *
     * So the engine mounts into a FRESH CHILD of the host it was given. That child
     * is the one element the API may replace, and it belongs to this engine only.
     */
    const mount = host.ownerDocument.createElement('div');
    mount.style.display = 'block';
    mount.style.width = '100%';
    mount.style.height = '100%';
    /*
     * A host may already hold another engine's player (concurrent creation, or a
     * switch whose teardown has not run yet): ours is APPENDED, never used to
     * wipe the host. Clearing the host was what let one engine remove another's
     * live frame.
     */
    host.appendChild(mount);
    this.mountPoint = mount;
    this.player = new api.Player(mount, {
      host: config.host,
      videoId: config.videoId,
      width: '100%',
      height: '100%',
      playerVars: config.playerVars,
      events: {
        onReady: () => this.onReady(),
        onStateChange: (event) => this.onStateChange(Number(event.data)),
        onError: (event) => this.onError(Number(event.data)),
        onPlaybackQualityChange: (event) => this.onQuality(String(event.data ?? '')),
      },
    });
    // `getIframe()` is authoritative; the fallback is scoped to OUR mount point.
    this.frame = this.player.getIframe?.() ?? findOwnedFrame(this.mountPoint) ?? undefined;
    this.sizeFrame();
    this.observeFrameSize();
  }

  /**
   * Makes the official frame fill the stage.
   *
   * This CANNOT be done with a component stylesheet: Angular's emulated view
   * encapsulation tags only template elements with `_ngcontent-*`, so a rule such
   * as `.stage__youtube iframe[_ngcontent-…]` never matches the frame the API
   * injects. The API itself writes `width="100%" height="100%"`, which a frame
   * treats as 304×154 CSS pixels, so on a phone the player was surrounded by
   * black margins. The size is therefore applied here, where the frame element
   * actually exists.
   */
  private sizeFrame(): void {
    const frame = this.frame;
    if (!frame) {
      return;
    }
    frame.style.display = 'block';
    frame.style.width = '100%';
    frame.style.height = '100%';
    frame.style.maxWidth = '100%';
    frame.style.border = '0';
  }

  /**
   * The player may resize or re-create its frame after the fact: re-apply the
   * sizing when the STABLE host changes size (the mount point is replaceable, the
   * host is not).
   */
  private observeFrameSize(): void {
    const host = this.container();
    const Observer = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (!host || !Observer) {
      return;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = new Observer(() => {
      this.sizeFrame();
      // The mount point may have been replaced since: re-resolve OUR frame.
      this.frame = this.player?.getIframe?.() ?? findOwnedFrame(this.mountPoint) ?? this.frame;
    });
    this.resizeObserver.observe(host);
  }

  /** The element the official frame is mounted in, when the caller provided one. */
  private container(): HTMLElement | undefined {
    return this.options.container;
  }

  /** Volume is 0..1 in our contract; YouTube takes 0..100. */
  play(): Promise<void> {
    this.wantsPlay = true;
    if (this.destroyed) {
      return Promise.resolve();
    }
    // `onReady` may not have fired yet; the intent is applied there.
    if (this.ready) {
      this.applyAudio();
      this.player?.playVideo();
    }
    return Promise.resolve();
  }

  pause(): void {
    this.wantsPlay = false;
    if (!this.destroyed) {
      this.player?.pauseVideo();
    }
  }

  setVolume(volume: number): void {
    this.volume = Math.min(100, Math.max(0, Math.round(volume * 100)));
    // Applied to the live player: never recreate it just to change the volume.
    if (this.ready && !this.destroyed) {
      this.player?.setVolume(this.volume);
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ready && !this.destroyed) {
      this.applyAudio();
    }
  }

  /** YouTube picks its own quality; there is no published setter for live. */
  setQuality(_index: number | 'auto'): void {
    // Intentionally a no-op: the official player owns quality selection.
  }

  setAudioTrack(_id: number | null): void {
    // Audio track selection is not exposed by the published player API.
  }

  setSubtitleTrack(_id: number | 'off'): void {
    // Captions belong to the official player's own UI.
  }

  /** Jumps to the live edge through the published seek function. */
  seekToLive(): void {
    if (this.destroyed) {
      return;
    }
    try {
      this.player?.seekTo?.(Number.MAX_SAFE_INTEGER, true);
    } catch {
      // A player that is not ready has nothing to seek; it autoplays at live.
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.clearWatchdog();
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    try {
      this.player?.destroy();
    } catch {
      // A player that already failed has nothing to release.
    }
    this.player = undefined;
    /*
     * Remove ONLY what this engine created. The host is shared with whoever comes
     * next (and, in a race, with a newer player): clearing it blindly could delete
     * a player that is not ours.
     */
    this.frame?.remove();
    this.frame = undefined;
    const mount = this.mountPoint;
    this.mountPoint = undefined;
    if (mount) {
      // The API may have already replaced the mount with the frame we removed.
      mount.remove();
    }
    this.ready = false;
  }

  private applyAudio(): void {
    this.player?.setVolume(this.volume);
    if (this.muted) {
      this.player?.mute();
    } else {
      this.player?.unMute();
    }
  }

  private onReady(): void {
    if (this.destroyed) {
      return;
    }
    this.ready = true;
    this.applyAudio();
    // `ready` is NOT `playing`: the player is mounted and accepting calls, which
    // is `can-play`. Only PLAYING (1) claims playback.
    this.emit({ type: 'can-play' });
    if (this.wantsPlay || this.options.autoplay) {
      this.startWatchdog();
      this.player?.playVideo();
    }
  }

  /**
   * If the official player never reports PLAYING — for example it sits on its
   * own "press play" affordance — the stream is not playing, and saying so is
   * the honest outcome. It is a stall signal, not a permanent failure.
   */
  private startWatchdog(): void {
    this.clearWatchdog();
    const timeout = this.deps.playingTimeoutMs ?? PLAYING_TIMEOUT_MS;
    const now = this.deps.now ?? Date.now;
    const startedAt = now();
    this.watchdog = setTimeout(() => {
      this.watchdog = undefined;
      void this.checkStalled(startedAt, now, timeout);
    }, timeout);
  }

  private async checkStalled(startedAt: number, now: () => number, timeout: number): Promise<void> {
    if (this.destroyed || this.everPlayed) {
      return;
    }
    // Ask the player itself before judging it.
    const state = this.safeState();
    if (state === YOUTUBE_PLAYER_STATE.playing) {
      this.everPlayed = true;
      this.emit({ type: 'playing' });
      return;
    }
    // Before the deadline a not-yet-started player is simply still starting;
    // `can-play` was already reported by `onReady` and is not repeated here.
    if (now() - startedAt < timeout) {
      return;
    }
    /*
     * The deadline passed without PLAYING.
     *
     * A player that is merely waiting for the VIEWER to press its own play button
     * (`UNSTARTED`/`CUED`/`PAUSED`) is not stalled: destroying it on that basis
     * would remove a player the user could still start, which is worse than the
     * delay it was meant to catch. That case stays `can-play`.
     */
    const awaitingViewer =
      state === YOUTUBE_PLAYER_STATE.unstarted ||
      state === YOUTUBE_PLAYER_STATE.cued ||
      state === YOUTUBE_PLAYER_STATE.paused;
    if (awaitingViewer) {
      this.emit({ type: 'can-play' });
      return;
    }
    /*
     * Otherwise the player reports BUFFERING (or an unreadable state) past the
     * deadline: it holds no data, so the stream never arrived. That is a stall.
     */
    const loaded = this.player?.getVideoLoadedFraction?.() ?? 0;
    if (loaded > 0) {
      this.emit({ type: 'can-play' });
      return;
    }
    this.emit({
      type: 'error',
      code: 'SOURCE_STALLED',
      message: 'El reproductor de YouTube no ha empezado a reproducir la emisión.',
      recoverable: false,
    });
  }

  private safeState(): number | undefined {
    try {
      return this.player?.getPlayerState?.();
    } catch {
      return undefined;
    }
  }

  private onStateChange(state: number): void {
    if (this.destroyed) {
      return;
    }
    switch (state) {
      case YOUTUBE_PLAYER_STATE.playing:
        this.everPlayed = true;
        this.clearWatchdog();
        this.emit({ type: 'playing' });
        break;
      case YOUTUBE_PLAYER_STATE.buffering:
        this.emit({ type: 'waiting' });
        break;
      case YOUTUBE_PLAYER_STATE.paused:
        this.emit({ type: 'pause' });
        break;
      case YOUTUBE_PLAYER_STATE.ended:
        // A live stream that ends is off air: report it as such, never as a
        // healthy "playing" that happens to be silent.
        this.clearWatchdog();
        this.emit({ type: 'ended' });
        break;
      case YOUTUBE_PLAYER_STATE.cued:
        this.emit({ type: 'can-play' });
        break;
      default:
        // `unstarted (-1)` is a transient announcement, not a user-visible state.
        break;
    }
  }

  private onQuality(quality: string): void {
    if (this.destroyed) {
      return;
    }
    // YouTube reports quality as a name; we expose it as the current index only.
    const index = ['small', 'medium', 'large', 'hd720', 'hd1080', 'highres'].indexOf(quality);
    if (index >= 0) {
      this.emit({ type: 'quality-changed', index });
    }
  }

  private onError(code: number): void {
    if (this.destroyed) {
      return;
    }
    this.clearWatchdog();
    const classified = classifyYoutubeError(code);
    // Refusals (no embedding, gone, no client identity) are never retried; a
    // player-side hiccup (HTML5 code 5) is worth one automatic attempt.
    const recoverable = code === YOUTUBE_ERROR_CODES.html5;
    this.emit({
      type: 'error',
      code: `YOUTUBE_${code}`,
      message: classified.message,
      recoverable,
    });
  }

  private emit(event: EngineEvent): void {
    if (!this.destroyed) {
      this.options.onEvent(event);
    }
  }

  private clearWatchdog(): void {
    if (this.watchdog !== undefined) {
      clearTimeout(this.watchdog);
      this.watchdog = undefined;
    }
  }

  /**
   * How many times this engine may report `can-play` for an UNOBSERVABLE player.
   *
   * The channel embed announces itself once per (re)mount. Each distinct mount is
   * a real attempt, so it is allowed to announce itself; anything beyond a free
   * remount is not — otherwise waiting for an emission would loop forever.
   */
  private unobservableAnnouncements = 0;

  /** Diagnostic view used by the UI/tests: what the official player last said. */
  describe(): { readonly videoId: string; readonly ready: boolean; readonly everPlayed: boolean; readonly frameSrc?: string } {
    return {
      videoId: this.videoId,
      ready: this.ready,
      everPlayed: this.everPlayed,
      frameSrc: this.frame?.getAttribute('src') ?? undefined,
    };
  }
}

/**
 * The video id of an OFFICIAL YouTube page URL.
 *
 * Delegates to `resolveYoutubeTarget`, the single source of truth for host
 * allow-listing and id canonicalisation: a duplicate parser here would let a
 * foreign host (`https://evil.test/live/<id>`) reach the engine boundary, which
 * only the frame host being hardcoded to YouTube would then contain.
 */
function videoIdOf(url: string): string | undefined {
  const resolved = resolveYoutubeTarget(url);
  return resolved.ok && resolved.target.kind === 'video' ? resolved.target.videoId : undefined;
}

/** The channel id of a documented channel-embed URL, if this is one. */
function channelIdOf(url: string): string | undefined {
  const resolved = resolveYoutubeTarget(url);
  return resolved.ok && resolved.target.kind === 'channel' ? resolved.target.channelId : undefined;
}

/**
 * The YouTube frame belonging to THIS engine: the one inside its own mount point.
 * The official player nests its own frame inside ours, so the outermost iframe
 * inside the mount is the one we created. Scoping to the mount (never the shared
 * host) means a defensive fallback can never point at a sibling engine's frame.
 */
function findOwnedFrame(mount: HTMLElement | undefined): HTMLIFrameElement | undefined {
  if (!mount) {
    return undefined;
  }
  const frames = Array.from(mount.querySelectorAll('iframe'));
  return frames.find((frame) => /youtube(-nocookie)?\.com\/embed\//.test(frame.getAttribute('src') ?? ''));
}

/** A refusal we can classify, raised before any frame is created. */
export class YoutubeEngineRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'YoutubeEngineRefusal';
  }
}
