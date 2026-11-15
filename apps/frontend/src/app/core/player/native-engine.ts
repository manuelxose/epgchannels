/**
 * Native-backend engine used for progressive files and for browsers that expose
 * an HLS implementation directly on the media element (Safari, iOS).
 */
import type { EngineEvent, EngineKind, EngineOptions, PlayerEngine } from './engine';

/** Wires media-element events to the engine callback; returns removers. */
export function attachMediaListeners(media: HTMLVideoElement, options: EngineOptions): Array<() => void> {
  const emit = (event: EngineEvent): void => options.onEvent(event);
  const bind = <K extends keyof HTMLMediaElementEventMap>(
    name: K,
    handler: (event: HTMLMediaElementEventMap[K]) => void,
  ): (() => void) => {
    media.addEventListener(name, handler as EventListener);
    return () => media.removeEventListener(name, handler as EventListener);
  };

  return [
    bind('canplay', () => emit({ type: 'can-play' })),
    bind('playing', () => emit({ type: 'playing' })),
    bind('waiting', () => emit({ type: 'waiting' })),
    bind('pause', () => emit({ type: 'pause' })),
    bind('ended', () => emit({ type: 'ended' })),
    bind('error', () =>
      emit({
        type: 'error',
        code: `MEDIA_${media.error?.code ?? 0}`,
        message: 'El navegador no ha podido reproducir esta emisión.',
        recoverable: false,
      }),
    ),
  ];
}

export class NativePlayerEngine implements PlayerEngine {
  readonly kind: EngineKind = 'native';

  constructor(
    private readonly media: HTMLVideoElement,
    private readonly listeners: Array<() => void>,
  ) {}

  async play(): Promise<void> {
    await this.media.play();
  }

  pause(): void {
    this.media.pause();
  }

  setVolume(volume: number): void {
    this.media.volume = Math.min(1, Math.max(0, volume));
  }

  setMuted(muted: boolean): void {
    this.media.muted = muted;
  }

  setQuality(): void {
    /* Native playback exposes no quality switching. */
  }

  setAudioTrack(): void {
    /* Native playback exposes no audio-track switching. */
  }

  setSubtitleTrack(): void {
    /* Native playback exposes no subtitle switching beyond the element's own controls. */
  }

  seekToLive(): void {
    const { seekable } = this.media;
    if (seekable.length > 0) {
      this.media.currentTime = seekable.end(seekable.length - 1);
    }
  }

  destroy(): void {
    for (const remove of this.listeners) {
      remove();
    }
    this.listeners.length = 0;
    this.media.pause();
    this.media.removeAttribute('src');
    this.media.load();
  }
}

/**
 * True when the media element can play the given kind of source *on its own*.
 *
 * HLS requires a definitive "probably": Chrome answers "maybe" for
 * `application/vnd.apple.mpegurl` even though it has no HLS parser and cannot
 * play such sources natively. Safari/iOS answer "probably", which is the only
 * signal trusted for native HLS.
 */
export function supportsNative(media: HTMLVideoElement, type: 'hls' | 'dash' | 'progressive'): boolean {
  if (type === 'dash') {
    // No shipping browser parses an MPD on its own; DASH is driven by dash.js.
    return false;
  }
  const mime = type === 'hls' ? 'application/vnd.apple.mpegurl' : 'video/mp4';
  const result = media.canPlayType(mime);
  return type === 'hls' ? result === 'probably' : result === 'probably' || result === 'maybe';
}

export function createNativeEngine(options: EngineOptions): PlayerEngine {
  const { media, url } = options;
  const listeners = attachMediaListeners(media, options);
  const engine = new NativePlayerEngine(media, listeners);
  media.volume = options.startVolume;
  media.muted = options.muted;
  media.src = url;
  media.load();
  return engine;
}
