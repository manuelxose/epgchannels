/**
 * Engine-agnostic contract implemented by every playback backend.
 *
 * The UI never touches hls.js, dash.js or the raw media element directly: it
 * talks to a `PlayerEngine`, which normalises engine-specific events and owns its
 * own teardown. This is what makes the backends replaceable and testable.
 *
 * Three backends implement it:
 * - `hls` / `dash` / `native` drive the shared `<video>` element;
 * - `youtube` drives the emitter's stream through YouTube's official IFrame
 *   player, which owns its own frame and reports its own state
 *   (`YouTubePlaybackEngine`).
 */

export type EngineKind = 'hls' | 'dash' | 'native' | 'youtube';

/** Streaming container the controller asks the factory for. */
export type EngineRequestKind = 'hls' | 'dash' | 'progressive' | 'youtube';

export interface QualityLevel {
  readonly index: number;
  readonly label: string;
  readonly height?: number;
  readonly bitrate?: number;
}

export interface MediaTrack {
  readonly id: number;
  readonly label: string;
  readonly language?: string;
}

export type EngineEvent =
  | { readonly type: 'manifest-ready'; readonly qualities: readonly QualityLevel[] }
  | { readonly type: 'quality-changed'; readonly index: number }
  | { readonly type: 'tracks'; readonly audio: readonly MediaTrack[]; readonly subtitles: readonly MediaTrack[] }
  | { readonly type: 'can-play' }
  | { readonly type: 'playing' }
  | { readonly type: 'waiting' }
  | { readonly type: 'pause' }
  | { readonly type: 'ended' }
  | { readonly type: 'unsupported'; readonly reason: string }
  | { readonly type: 'error'; readonly code: string; readonly message: string; readonly recoverable: boolean };

export interface EngineOptions {
  /**
   * The source URL. For the media engines it is the manifest/media address; for
   * the YouTube engine it is the official page URL (never a media URL).
   */
  readonly url: string;
  /** The media element the media engines attach to (hls.js, dash.js, native). */
  readonly media: HTMLVideoElement;
  /**
   * Where a non-media backend mounts its own surface. The YouTube engine puts
   * the official frame here; the `<video>` element is never touched by it.
   */
  readonly container?: HTMLElement;
  readonly autoplay: boolean;
  readonly startVolume: number;
  readonly muted: boolean;
  readonly onEvent: (event: EngineEvent) => void;
}

export interface PlayerEngine {
  readonly kind: EngineKind;
  play(): Promise<void>;
  pause(): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  setQuality(index: number | 'auto'): void;
  setAudioTrack(id: number | null): void;
  setSubtitleTrack(id: number | 'off'): void;
  seekToLive(): void;
  destroy(): void;
  /**
   * Optional capabilities of an engine that drives a player whose state it cannot
   * observe (a third-party channel embed), so it can be put back on screen.
   */
  readonly isUnobservable?: boolean;
  /** Re-mounts the same player (a route/view return for the same source). */
  remount?(): void;
  /**
   * Moves the SAME live player into a freshly rendered host, keeping it alive.
   * One owner for the mount: the controller never looks for the frame itself.
   */
  reattachTo?(host: HTMLElement): boolean;
  /** Re-mounts the player only if it is not showing, within a bounded budget. */
  recoverIfStuck?(): boolean;
  /** The UI's observation of whether the player paints content right now. */
  reportEmbedVisibility?(paints: boolean | undefined): void;
}

/** Builds a ready engine for a source kind. Injected so backends are swappable. */
export type EngineFactory = (options: EngineOptions, kind: EngineRequestKind) => Promise<PlayerEngine>;

/**
 * Whether a media format can be played *in app* by a media engine at all.
 *
 * `youtube` is its own official backend (`YouTubePlaybackEngine`), never hls.js
 * or dash.js. `iframe` stays a plain link: we do not embed arbitrary third-party
 * players. `dash` is a first-class streaming format driven by dash.js, never a
 * progressive file.
 */
export function isEngineFormat(format: string): format is EngineRequestKind {
  return format === 'hls' || format === 'dash' || format === 'progressive' || format === 'youtube';
}

/**
 * Explicit narrowing of the (wider) catalogue format union to an engine kind.
 * Returns `undefined` for formats the in-app player must not attempt, so callers
 * never need a cast and a new format cannot silently reach an engine.
 */
export function toEngineKind(format: string): EngineRequestKind | undefined {
  return isEngineFormat(format) ? format : undefined;
}
