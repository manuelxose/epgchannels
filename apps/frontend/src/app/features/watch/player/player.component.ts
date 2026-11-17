import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { IconComponent } from '../../../shared/ui/icon.component';
import { PlayerController } from '../../../core/state/player.controller';
import { PreferencesStore } from '../../../core/state/preferences.store';
import { playbackStateFor, type PlaybackState } from '../../../core/player/player-state';
import { planPlayback, isEligibleSource } from '../../../core/models/catalog.model';
import type { Channel, MediaSource } from '../../../core/models/catalog.model';
import { resolveYoutubeTarget, youtubeWatchUrl } from '../../../core/integrations/youtube-target';
import {
  castBridgeOf,
  readBrowserRemoteSurfaces,
  remotePlaybackCapabilities,
  sessionLink as sessionLinkFor,
  showAirPlayPicker,
  startRemotePlayback,
  type CastBridge,
} from '../../../core/integrations/remote-playback';
import { resolveCastConfiguration, sendToCastDevice } from '../../../core/integrations/cast-sender';
import { formatTimeRange, type NowNext } from '../../../core/epg/now-next';
import { clampVolume, resolvePlayerCommand, VOLUME_STEP, type PlayerCommand } from './player-keyboard';
import { PlaybackTelemetryService } from '../../../core/telemetry/playback-telemetry.service';

/**
 * The application's own video player.
 *
 * Renders one `<video>` element and delegates all engine work to
 * `PlayerController`, which owns the state machine, bounded recovery and
 * teardown. Nothing here talks to hls.js directly.
 */
@Component({
  selector: 'app-player',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  templateUrl: './player.component.html',
  styleUrl: './player.component.css',
})
export class PlayerComponent implements OnDestroy {
  readonly channel = input.required<Channel>();
  readonly source = input<MediaSource | undefined>(undefined);
  readonly nowNext = input<NowNext>({ progress: 0 });
  readonly locale = input('es-ES');

  protected readonly controller = inject(PlayerController);
  protected readonly preferences = inject(PreferencesStore);
  protected readonly telemetry = inject(PlaybackTelemetryService);
  protected readonly Math = Math;

  private readonly videoRef = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly ytHostRef = viewChild<ElementRef<HTMLElement>>('ytHost');
  private readonly shellRef = viewChild<ElementRef<HTMLElement>>('shell');

  protected readonly snapshot = this.controller.snapshot;
  protected readonly status = this.controller.status;
  protected readonly muted = signal(false);
  protected readonly volume = signal(this.preferences.volume());
  /**
   * Whether the stage currently holds the browser's fullscreen. Read from the
   * `fullscreenchange` event rather than assumed, so the button's label and
   * `aria-pressed` always describe reality (including an Escape key exit).
   */
  protected readonly isFullscreen = signal(false);
  /** Last playback status seen, so telemetry records transitions only. */
  private lastTelemetryStatus: string | undefined;
  /** Channel+source identity currently loaded; guards against needless reloads. */
  private loadedKey = '';

  protected readonly isPlaying = computed(() => this.status() === 'playing');
  /**
   * True once the active source is played by the official YouTube engine. The
   * official player then owns playback, its controls and its chrome.
   */
  protected readonly isYoutube = computed(() => this.snapshot().engine === 'youtube');
  /** The official target the current source addresses (video id), if any. */
  protected readonly youtubeTarget = computed(() => {
    const source = this.youtubeSource();
    const target = source ? resolveYoutubeTarget(source.url) : undefined;
    return target?.ok && target.target.kind === 'video' ? target.target : undefined;
  });

  /**
   * The YouTube source being played (or attempted), independent of the engine's
   * current state: after a refusal the engine is gone, but the user must still be
   * able to reach the official page.
   */
  protected readonly youtubeSource = computed(() => {
    const source = this.source();
    return source?.format === 'youtube' ? source : undefined;
  });

  /**
   * The public page a human can open in YouTube for the stream being played, so
   * a refusal to embed (101/150/153) always has a way out that stays on YouTube.
   */
  protected readonly youtubePageUrl = computed(() => {
    const video = this.youtubeTarget();
    if (video) {
      return youtubeWatchUrl(video.videoId);
    }
    // A channel we could not check: the controller recorded where it can be seen.
    return this.snapshot().watchableUrl ?? this.youtubeSource()?.url ?? undefined;
  });

  /**
   * True when YouTube's player is a plain channel embed: its playback state is
   * not observable from here, so the UI says so instead of guessing.
   */
  protected readonly youtubeStateUnobservable = computed(() =>
    Boolean(this.youtubeSource()?.url.includes('/embed/live_stream')),
  );

  protected readonly showControls = computed(
    () => !['error', 'unavailable', 'external', 'blocked', 'unsupported', 'idle'].includes(this.status()),
  );

  /** P5: the status alone does not say what the user can do about it. */
  protected readonly playbackState = computed<PlaybackState>(() => playbackStateFor(this.status()));

  /** The official route for this channel: the emitter's own player when it exists. */
  protected readonly officialUrl = computed(() => {
    const channel = this.channel();
    const plan = planPlayback(channel);
    return plan.kind === 'external' ? (plan.externalUrl ?? channel.webUrl) : channel.webUrl;
  });

  protected readonly hasOfficialRoute = computed(() => Boolean(this.officialUrl()));

  protected readonly progressPercent = computed(() =>
    Math.round(Math.min(1, Math.max(0, this.nowNext().progress)) * 100),
  );

  protected readonly currentProgramLabel = computed(() => {
    const { now, next } = this.nowNext();
    if (now) {
      return `Ahora: ${now.title} (${formatTimeRange(now.start, now.end, this.locale())})`;
    }
    if (next) {
      return `Próximo: ${next.title} (${formatTimeRange(next.start, next.end, this.locale())})`;
    }
    return 'Sin información de programación';
  });

  protected readonly statusLabel = computed(() => {
    switch (this.playbackState()) {
      case 'loading':
        return this.status() === 'buffering' ? 'Almacenando en búfer…' : 'Cargando emisión…';
      case 'playing':
        return 'En reproducción';
      case 'paused':
        return 'En pausa';
      case 'recoverable-failure':
        return 'Error de reproducción: puedes reintentar';
      case 'source-unavailable':
        return 'Ninguna fuente de este canal está disponible ahora mismo';
      case 'eventual-emission':
        return 'Emisión sin vídeo en línea: solo la guía';
      case 'external-official':
        return 'Reproducción oficial disponible en la página del emisor';
      case 'unauthorised':
        return 'Emisión no reproducible aquí (bloqueo regional o del emisor)';
      case 'unsupported':
        return 'Tu navegador no puede reproducir esta emisión';
      default:
        return 'Sin reproducir';
    }
  });

  /**
   * Overlays that belong to *our* player. The now-playing card and the buffering
   * spinner are only for the media engines: over a YouTube frame they would sit
   * on top of YouTube's mandatory marks, which we must never cover. The official
   * player shows its own loading and title chrome.
   */
  protected readonly showOwnOverlays = computed(() => !this.isYoutube());

  /**
   * When every source failed, the cause to report is the LAST one: the first
   * failure belongs to a source that was only one step in the fallback (on 7TV
   * Almería the first attempt failed for CORS while the last was a plain 404,
   * and blaming CORS would point at the wrong problem).
   */
  protected readonly latestFailureMessage = computed(() => {
    const failed = this.snapshot().failedSources;
    return failed[failed.length - 1]?.message ?? 'Las fuentes publicadas no responden en este momento.';
  });

  /** True when the browser can offer picture-in-picture for the media element. */
  protected readonly canPictureInPicture =
    typeof document !== 'undefined' && document.pictureInPictureEnabled === true;

  /**
   * Sending playback to another device, using the BROWSER's own device picker.
   *
   * Measured (`scripts/playback/probe-remote-playback.mjs`): browsers expose
   * discovery on different surfaces, and none of them lets us list devices
   * ourselves. So the button is driven by that discovery instead of the video
   * element: it appears as soon as the browser can find devices.
   *
   * For a YouTube source the player is a cross-origin frame whose document is
   * unreachable (`contentDocument === null`), so it cannot be handed over from
   * here: the button explains that and YouTube's own cast control is the route.
   */
  protected readonly remoteSurfaces = computed(() => {
    const win = typeof window === 'undefined' ? undefined : window;
    const bridge = castBridgeOf(win);
    const media = this.videoRef()?.nativeElement ?? null;
    const surfaces = readBrowserRemoteSurfaces(win, media);
    return {
      bridge,
      ...surfaces,
      hasCastBridge: Boolean(bridge),
      // Media engines own a same-origin <video>; the YouTube engine does not.
      ownsMedia: !this.isYoutube(),
      hasRemotePlayback: surfaces.hasRemotePlayback || this.remotePlaybackApi(win),
    };
  });

  /**
   * True when the DOM exposes the standard Remote Playback API at all.
   *
   * Read from the prototype, not from a particular element: the button must not
   * depend on whether this exact `<video>` already has a source.
   */
  private remotePlaybackApi(win: Window | undefined): boolean {
    if (!win || typeof HTMLMediaElement === 'undefined') {
      return false;
    }
    return 'remotePlayback' in HTMLMediaElement.prototype;
  }

  /**
   * Whether to OFFER sending to a device.
   *
   * The Cast SDK can add a bridge the page did not have on load, so the button
   * must not depend on that detection alone: it is shown for every source the
   * engine owns, and pressing it reports what is actually possible (Cast, Remote
   * Playback, AirPlay) or exactly what is missing. A YouTube source never shows
   * it: its player is not ours to hand over.
   */
  protected readonly canSendToDevice = computed(
    () => this.remoteSurfaces().ownsMedia || this.remoteSurfaces().hasCastBridge,
  );

  /** Why sending is not available, when that is the honest answer. */
  protected readonly sendToDeviceNotice = signal<string | undefined>(undefined);

  constructor() {
    /*
     * (Re)create the engine only when the channel or the source changes.
     *
     * Angular effects track every signal read synchronously in the body, so the
     * volume and mute reads must happen inside `untracked`; otherwise moving the
     * volume slider would re-run this effect and reload the whole stream.
     */
    effect(() => {
      const video = this.videoRef()?.nativeElement;
      const ytHost = this.ytHostRef()?.nativeElement;
      const source = this.source();
      const channel = this.channel();
      if (!video || !source || !channel) {
        return;
      }
      /*
       * Key the reload on the *identity* of channel+source, never on the object
       * reference. `selectedSource()` is derived from a filtered array, so it is
       * a fresh object on every change-detection pass; depending on the
       * reference made unrelated updates (e.g. toggling mute) tear down and
       * reload a healthy stream.
       */
      const key = `${channel.id}\u0000${source.id}\u0000${source.url}`;
      if (key === this.loadedKey) {
        return;
      }
      this.loadedKey = key;
      const initial = untracked(() => ({ volume: this.volume(), muted: this.muted() }));
      this.controller.attachMedia(video);
      if (ytHost) {
        this.controller.attachHost(ytHost);
      }
      /*
       * One owner for putting the player back.
       *
       * The load settles first; only then does the view announce its host, and
       * only then may a running player be moved into it. Doing it from a second
       * effect raced the load and re-mounted the player on every visit, which is
       * exactly the "a veces funciona y otras no" loop.
       */
      void this.controller.load(channel, source, initial).then(() => {
        if (ytHost?.isConnected) {
          this.controller.onHostReady(ytHost);
        }
      });
    });

    /*
     * Report, on an interval, whether the embedded player is showing anything:
     * same-origin inspection only (the frame exists and has a size). YouTube's
     * document is never read. The engine uses this to decide whether to recover.
     */
    if (typeof window !== 'undefined') {
      this.visibilityTimer = setInterval(() => {
        const host = this.ytHostRef()?.nativeElement;
        const frame = host?.querySelector('iframe') ?? null;
        /*
         * Only judge a player that has had time to arrive. Right after a return,
         * the engine is re-mounting and the frame does not exist yet; reporting
         * "not showing" then triggered a needless re-mount on every visit, which
         * spent the channel's attempts. A grace period measures the player once it
         * could exist.
         */
        if (!frame && Date.now() - this.mountedAt < 8_000) {
          return;
        }
        this.controller.reportLiveEngineVisibility(Boolean(frame && frame.getBoundingClientRect().height > 0));
      }, 3_000);
    }
    /*
     * Telemetry: ONE effect over the player's own state transitions.
     *
     * No timer, no polling and no per-frame work — the effect runs only when a
     * status actually changes, so a paused, failed or hidden player costs
     * nothing. `untracked` keeps the recording itself from becoming a
     * dependency. Records are non-identifying and never leave the device
     * (PlaybackTelemetry has no transport unless one is injected).
     */
    effect(() => {
      const status = this.status();
      const source = this.source();
      const channel = this.channel();
      const engine = this.snapshot().engine;
      untracked(() => this.recordStatusTransition(status, channel?.id, source, engine));
    });

    /*
     * Keyboard shortcuts, scoped explicitly.
     *
     * The listener sits on the stage, not on the document, so a key pressed
     * anywhere else on the page is never intercepted. Arrow keys additionally
     * require focus INSIDE the player (`resolvePlayerCommand` enforces it), so
     * they can never hijack page scrolling — the component only calls
     * `preventDefault` when a command was actually resolved.
     */
    if (typeof document !== 'undefined') {
      this.onFullscreenChange = () => {
        this.isFullscreen.set(document.fullscreenElement === this.shellRef()?.nativeElement);
      };
      document.addEventListener('fullscreenchange', this.onFullscreenChange);
    }
  }

  /** Bound so it can be removed; a fresh arrow each time would leak. */
  private onFullscreenChange: (() => void) | undefined;

  /**
   * Handles a key press on the player surface.
   *
   * Returns without calling `preventDefault` for anything the player does not
   * act on, so browser and assistive-technology behaviour is untouched.
   */
  protected onKeydown(event: KeyboardEvent): void {
    const shell = this.shellRef()?.nativeElement;
    const playerHasFocus = Boolean(shell && event.target instanceof Node && shell.contains(event.target));
    const command = resolvePlayerCommand(event, playerHasFocus);
    if (!command) {
      return;
    }
    // Only keys we act on lose their default behaviour.
    event.preventDefault();
    this.telemetry.record({ name: 'control', code: command, channelId: this.channel().id });
    this.runCommand(command);
  }

  /** Executes a resolved player command. */
  private runCommand(command: PlayerCommand): void {
    switch (command) {
      case 'toggle-play':
        void this.controller.togglePlay();
        break;
      case 'toggle-mute':
        this.toggleMute();
        break;
      case 'toggle-fullscreen':
        void this.toggleFullscreen();
        break;
      case 'seek-live':
        this.controller.seekToLive();
        break;
      case 'volume-up':
      case 'volume-down':
        this.nudgeVolume(command === 'volume-up' ? VOLUME_STEP : -VOLUME_STEP);
        break;
    }
  }

  /** Applies a relative volume change and un-mutes, so the change is audible. */
  private nudgeVolume(delta: number): void {
    const next = clampVolume((this.muted() ? 0 : this.volume()) + delta);
    this.volume.set(next);
    this.preferences.setVolume(next);
    this.controller.setVolume(next);
    if (next > 0 && this.muted()) {
      this.muted.set(false);
      this.controller.setMuted(false);
    }
  }

  /** Turns a status change into at most one telemetry record. */
  private recordStatusTransition(
    status: string,
    channelId: string | undefined,
    source: MediaSource | undefined,
    engine: string,
  ): void {
    if (status === this.lastTelemetryStatus) {
      return;
    }
    const previous = this.lastTelemetryStatus;
    this.lastTelemetryStatus = status;

    const common = { channelId, format: source?.format, engine };
    switch (status) {
      case 'loading':
        // A new attempt begins: this is the clock the first frame is measured against.
        this.telemetry.record({ name: 'playback-start', ...common });
        break;
      case 'playing':
        this.telemetry.record(
          previous === 'loading' || previous === 'buffering'
            ? { name: 'first-frame', ...common }
            : { name: 'playing', ...common },
        );
        break;
      case 'buffering':
        this.telemetry.record({ name: 'buffering', ...common });
        break;
      case 'error':
      case 'unavailable':
      case 'blocked':
      case 'unsupported': {
        // The code comes from the engine/controller, never from a guess.
        const code = this.snapshot().error?.code ?? status.toUpperCase();
        this.telemetry.record({ name: 'error', code, ...common });
        // A fallback that happened is recorded as such, so a channel that
        // eventually played is not reported as a plain failure.
        if (this.snapshot().failedSources.length > 0 && status === 'unavailable') {
          this.telemetry.record({ name: 'source-fallback', code, ...common });
        }
        break;
      }
      default:
        break;
    }
  }
  private readonly mountedAt = Date.now();

  private visibilityTimer: ReturnType<typeof setInterval> | undefined;

  ngOnDestroy(): void {
    if (this.visibilityTimer !== undefined) {
      clearInterval(this.visibilityTimer);
      this.visibilityTimer = undefined;
    }
    if (this.onFullscreenChange && typeof document !== 'undefined') {
      document.removeEventListener('fullscreenchange', this.onFullscreenChange);
      this.onFullscreenChange = undefined;
    }
    this.controller.detachMedia();
  }

  protected formatRange(start: Date, end: Date): string {
    return formatTimeRange(start, end, this.locale());
  }

  protected togglePlay(): void {
    void this.controller.togglePlay();
  }

  protected toggleMute(): void {
    this.muted.update((value) => !value);
    this.controller.setMuted(this.muted());
  }

  protected readonly autoplayBlocked = this.controller.autoplayBlocked;
  protected readonly ready = this.controller.ready;

  protected onVolume(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value) / 100;
    this.volume.set(value);
    this.preferences.setVolume(value);
    this.controller.setVolume(value);
    if (value > 0 && this.muted()) {
      this.muted.set(false);
      this.controller.setMuted(false);
    }
  }

  protected onQuality(event: Event): void {
    const value = Number((event.target as HTMLSelectElement).value);
    this.controller.setQuality(value < 0 ? 'auto' : value);
  }

  protected onAudio(event: Event): void {
    this.controller.setAudioTrack(Number((event.target as HTMLSelectElement).value));
  }

  /**
   * Subtitle selection. `<select>` values are strings, so `'off'` is handled
   * explicitly instead of being coerced into `NaN`.
   */
  protected onSubtitle(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.controller.setSubtitleTrack(value === 'off' ? 'off' : Number(value));
  }

  /** The subtitle control's current value, always in the `<select>` vocabulary. */
  protected subtitleValue(): string {
    const selection = this.snapshot().subtitleSelection;
    return typeof selection === 'number' ? String(selection) : 'off';
  }

  protected goLive(): void {
    this.controller.seekToLive();
  }

  protected async retry(): Promise<void> {
    await this.controller.retry(this.volume(), this.muted());
  }

  /** Restarts from the first eligible source after every source failed once. */
  protected async restartFromFirstSource(): Promise<void> {
    await this.controller.selectSource(this.firstEligibleIndex(), this.volume(), this.muted());
  }

  private firstEligibleIndex(): number {
    const index = this.channel().sources.findIndex((candidate) => isEligibleSource(candidate));
    return index >= 0 ? index : 0;
  }

  /**
   * Opens the device picker the browser provides.
   *
   * Order matches `remotePlaybackCapabilities`: the browser's own Cast picker,
   * then the standard Remote Playback prompt, then AirPlay. Whichever opens is
   * the browser's real device list — we never render one of our own.
   */
  protected async sendToDevice(): Promise<void> {
    this.sendToDeviceNotice.set(undefined);
    const video = this.videoRef()?.nativeElement ?? null;
    const source = this.source();

    // A YouTube player lives in a cross-origin frame we cannot reach, and its
    // terms forbid playing the stream elsewhere.
    if (this.isYoutube()) {
      this.sendToDeviceNotice.set(
        'El reproductor de YouTube es de YouTube: usa su botón de emisión dentro del vídeo.',
      );
      return;
    }
    if (!video || !source) {
      return;
    }

    /*
     * Google Cast first: the professional path. The official SDK opens the
     * browser's device picker and hands the STREAM URL to the device, which plays
     * it directly — so playback continues even if this tab closes.
     */
    const appId = (window as unknown as { TDT_CAST_APP_ID?: string }).TDT_CAST_APP_ID;
    const castResult = await sendToCastDevice(source.format, source.url, this.channel().name, appId);
    if (castResult === 'requested') {
      this.sendToDeviceNotice.set('Elige la pantalla en el selector de dispositivos.');
      return;
    }
    if (castResult === 'unsupported') {
      this.sendToDeviceNotice.set(
        'Esta emisión solo se puede ver dentro de la web del emisor: no se puede enviar a un dispositivo.',
      );
      return;
    }

    // The browser's standard surfaces, when it has them.
    try {
      if (await startRemotePlayback(video)) {
        return;
      }
    } catch {
      // A refused prompt is not an error we should shout about.
    }
    if (showAirPlayPicker(video)) {
      return;
    }
    const configuration = resolveCastConfiguration(window, appId);
    this.sendToDeviceNotice.set(
      configuration.state === 'no-bridge'
        ? configuration.reason
        : 'No se ha encontrado ningún dispositivo en tu red.',
    );
  }

  /**
   * The link another device on the network receives.
   *
   * There is no server here: the link points at THIS application's address and
   * carries which channel to open, so a phone or a TV browser that opens it lands
   * on the same channel with no account, no session and no data leaving the LAN.
   */
  protected readonly sessionLink = computed(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const channel = this.channel();
    /*
     * The link must land on the INDEX, not on the channel page: a device already
     * showing `/television/<other>` would keep that route when only the fragment
     * changes, and never see the hand-over. The index route is a fresh navigation.
     */
    const target = `${window.location.origin}/television/`;
    return sessionLinkFor(target, {
      v: 1,
      channel: { id: channel.id, name: channel.name, logo: channel.logoSrc },
      appUrl: target,
    });
  });

  /** Opens the system share sheet / clipboard so the other device gets the link. */
  protected async sendToAnotherScreen(): Promise<void> {
    const link = this.sessionLink();
    if (!link) {
      return;
    }
    const share = (navigator as unknown as { share?: (data: { title: string; text: string; url: string }) => Promise<void> })
      .share;
    if (typeof share === 'function') {
      try {
        await share.call(navigator, { title: this.channel().name, text: 'Ver este canal', url: link });
        return;
      } catch {
        // The user dismissed the sheet: fall through to a copy, never an error.
      }
    }
    try {
      await navigator.clipboard.writeText(link);
      this.sendToDeviceNotice.set('Enlace copiado: ábrelo en la tele o el móvil de tu red.');
    } catch {
      this.sendToDeviceNotice.set(`Abre este enlace en el otro dispositivo: ${link}`);
    }
  }

  /**
   * Enters or leaves fullscreen on the whole stage (video + our controls), and
   * keeps keyboard focus on the control that was used.
   *
   * Restoring focus matters: when the fullscreen element closes, the browser
   * moves focus to `<body>`, which leaves a keyboard user at the top of the
   * document with nothing focused (WCAG 2.2 Focus Not Obscured / focus order).
   */
  protected async toggleFullscreen(): Promise<void> {
    const shell = this.shellRef()?.nativeElement;
    if (!shell || typeof shell.requestFullscreen !== 'function') {
      return;
    }
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await shell.requestFullscreen();
      }
    } catch {
      // A refused or unsupported request must not break the player; the sheet
      // simply stays as it is and the button keeps its truthful state.
      return;
    }
    this.isFullscreen.set(document.fullscreenElement === shell);
    this.restoreControlFocus();
  }

  /**
   * Returns focus to the fullscreen button after the fullscreen mode changed.
   *
   * The element is looked up by its stable hook rather than by a viewChild,
   * because the control bar is re-created whenever the player leaves a terminal
   * state. Deferred to the next frame so the browser has finished moving focus.
   */
  private restoreControlFocus(): void {
    const shell = this.shellRef()?.nativeElement;
    if (!shell || typeof window === 'undefined') {
      return;
    }
    window.setTimeout(() => {
      const button = shell.querySelector<HTMLElement>('[data-control="fullscreen"]');
      button?.focus();
    }, 0);
  }

  protected async togglePictureInPicture(): Promise<void> {
    const video = this.videoRef()?.nativeElement;
    if (!video || typeof video.requestPictureInPicture !== 'function') {
      return;
    }
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else {
      await video.requestPictureInPicture();
    }
  }
}
