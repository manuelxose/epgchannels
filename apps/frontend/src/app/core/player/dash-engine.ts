/**
 * dash.js-backed engine for MPEG-DASH manifests (`.mpd`).
 *
 * dash.js is imported dynamically so it lives in its own lazily loaded chunk and
 * never blocks first paint of the catalogue (spec: an MPD is a streaming
 * container handled by a real DASH engine, never by the native element).
 *
 * The engine mirrors `hls-engine.ts` exactly: the same normalised `EngineEvent`
 * stream (media-element events via `attachMediaListeners`, qualities, tracks,
 * classified errors), the same control surface, and a `destroy()` that fully
 * releases dash.js from the media element so the next engine can claim it.
 */
import type { EngineEvent, EngineKind, EngineOptions, MediaTrack, PlayerEngine, QualityLevel } from './engine';
import { attachMediaListeners } from './native-engine';
import type { MediaPlayerClass } from 'dashjs';

/** dash.js error codes (MediaPlayerErrors) grouped by what they mean for us. */
const DASH_CODES = {
  MANIFEST_PARSING: 10,
  MANIFEST_LOADING: 11,
  SEGMENT_BASE_LOADER: 15,
  TIME_SYNC_FAILED: 16,
  FRAGMENT_LOADING: 17,
  FRAGMENT_NULL_REQUEST: 18,
  URL_RESOLUTION_FAILED: 19,
  APPEND_ERROR: 20,
  DATA_UPDATE_FAILED: 22,
  MEDIASOURCE_UNSUPPORTED: 23,
  MEDIAKEYS_UNSUPPORTED: 24,
  DOWNLOAD_manifest: 25,
  DOWNLOAD_sidx: 26,
  DOWNLOAD_content: 27,
  DOWNLOAD_initialization: 28,
  MANIFEST_PARSE: 31,
  MANIFEST_NO_STREAMS: 32,
  MANIFEST_MULTIPLEXED: 34,
  MEDIASOURCE_TYPE_UNSUPPORTED: 35,
} as const;

const CODE_LABEL: Readonly<Record<number, string>> = {
  [DASH_CODES.MANIFEST_PARSING]: 'MANIFEST_PARSING',
  [DASH_CODES.MANIFEST_LOADING]: 'MANIFEST_LOADING',
  [DASH_CODES.SEGMENT_BASE_LOADER]: 'SEGMENT_BASE_LOADER',
  [DASH_CODES.TIME_SYNC_FAILED]: 'TIME_SYNC_FAILED',
  [DASH_CODES.FRAGMENT_LOADING]: 'FRAGMENT_LOADING',
  [DASH_CODES.FRAGMENT_NULL_REQUEST]: 'FRAGMENT_NULL_REQUEST',
  [DASH_CODES.URL_RESOLUTION_FAILED]: 'URL_RESOLUTION_FAILED',
  [DASH_CODES.APPEND_ERROR]: 'APPEND_ERROR',
  [DASH_CODES.DATA_UPDATE_FAILED]: 'DATA_UPDATE_FAILED',
  [DASH_CODES.MEDIASOURCE_UNSUPPORTED]: 'UNSUPPORTED_MEDIASOURCE',
  [DASH_CODES.MEDIAKEYS_UNSUPPORTED]: 'BLOCKED_DRM',
  [DASH_CODES.DOWNLOAD_manifest]: 'MANIFEST_DOWNLOAD',
  [DASH_CODES.DOWNLOAD_sidx]: 'SEGMENT_INDEX',
  [DASH_CODES.DOWNLOAD_content]: 'SEGMENT_LOADING',
  [DASH_CODES.DOWNLOAD_initialization]: 'SEGMENT_INITIALIZATION',
  [DASH_CODES.MANIFEST_PARSE]: 'MANIFEST_INVALID',
  [DASH_CODES.MANIFEST_NO_STREAMS]: 'MANIFEST_INVALID',
  [DASH_CODES.MANIFEST_MULTIPLEXED]: 'MANIFEST_INVALID',
  [DASH_CODES.MEDIASOURCE_TYPE_UNSUPPORTED]: 'UNSUPPORTED_MEDIASOURCE',
};

const DASH_ERROR_TEXT: Readonly<Record<string, string>> = {
  MANIFEST_PARSING: 'El manifiesto DASH de la emisión no es válido.',
  MANIFEST_LOADING: 'No se ha podido descargar el manifiesto DASH de la emisión.',
  MANIFEST_DOWNLOAD: 'No se ha podido descargar el manifiesto DASH de la emisión.',
  MANIFEST_INVALID: 'La emisión DASH no anuncia ninguna pista de vídeo utilizable.',
  SEGMENT_BASE_LOADER: 'El manifiesto DASH apunta a índices de segmento inaccesibles.',
  TIME_SYNC_FAILED: 'No se ha podido sincronizar el reloj con el servidor de la emisión.',
  FRAGMENT_LOADING: 'No se ha podido descargar un fragmento de la emisión.',
  FRAGMENT_NULL_REQUEST: 'La emisión no publica fragmentos en este momento.',
  URL_RESOLUTION_FAILED: 'La dirección de un fragmento de la emisión no se puede resolver.',
  APPEND_ERROR: 'La fuente no ha entregado vídeo válido (segmento no disponible).',
  DATA_UPDATE_FAILED: 'La emisión ha enviado datos que no se pueden aplicar.',
  SEGMENT_INDEX: 'No se ha podido leer el índice de segmentos de la emisión.',
  SEGMENT_LOADING: 'No se ha podido descargar un fragmento de la emisión.',
  SEGMENT_INITIALIZATION: 'No se ha podido descargar el inicio de la emisión.',
  UNSUPPORTED_MEDIASOURCE: 'Tu navegador no puede reproducir esta emisión DASH.',
  BLOCKED_DRM: 'Esta emisión está protegida con DRM y no se puede reproducir aquí.',
};

export interface DashErrorLike {
  readonly error?: string | number | { code?: number; message?: string };
  readonly message?: string;
}

export interface DashClassification {
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
}

function resolveCode(error: DashErrorLike): string {
  const value = error.error;
  if (typeof value === 'number') {
    return CODE_LABEL[value] ?? `DASH_${value}`;
  }
  if (typeof value === 'string') {
    // dash.js reports `error: 'download' | 'manifestError' | 'capability' | ...`.
    switch (value) {
      case 'download':
        return codeFromDownload(error);
      case 'manifestError':
        return 'MANIFEST_INVALID';
      case 'mediasource':
        return 'UNSUPPORTED_MEDIASOURCE';
      case 'capability':
        return 'UNSUPPORTED_MEDIASOURCE';
      case 'key_session':
      case 'key_message':
        return 'BLOCKED_DRM';
      default:
        return value.toUpperCase();
    }
  }
  if (value && typeof value === 'object' && typeof value.code === 'number') {
    return CODE_LABEL[value.code] ?? `DASH_${value.code}`;
  }
  return 'DASH_ERROR';
}

function codeFromDownload(error: DashErrorLike): string {
  // `event.id` in a download error names the failing request.
  const id = (error as { event?: { id?: string } }).event?.id ?? '';
  if (id.includes('manifest')) {
    return 'MANIFEST_DOWNLOAD';
  }
  if (id.includes('initialization')) {
    return 'SEGMENT_INITIALIZATION';
  }
  if (id.includes('sidx')) {
    return 'SEGMENT_INDEX';
  }
  return 'SEGMENT_LOADING';
}

/** Errors that are worth another attempt on the *same* source. */
const DASH_TRANSIENT = new Set([
  'MANIFEST_LOADING',
  'MANIFEST_DOWNLOAD',
  'SEGMENT_BASE_LOADER',
  'TIME_SYNC_FAILED',
  'SEGMENT_LOADING',
  'SEGMENT_INITIALIZATION',
  'SEGMENT_INDEX',
  'APPEND_ERROR',
  'DATA_UPDATE_FAILED',
  'MANIFEST_DOWNLOAD_TIMEOUT',
]);

/**
 * Classifies a dash.js error event. Exported because the recoverable/fatal split
 * is the only input of the bounded retry and source-fallback state machine.
 */
export function classifyDashError(error: DashErrorLike): DashClassification {
  const code = resolveCode(error);
  // `MANIFEST_LOADING` (11) is shared by load failures and 4xx answers; a 403/404
  // is a refusal that retrying cannot fix, but dash.js only reports the code, so
  // the controller's bounded retries take care of the rare wrong guess.
  const recoverable = DASH_TRANSIENT.has(code);
  return { code, message: DASH_ERROR_TEXT[code] ?? 'No se ha podido reproducir la emisión DASH.', recoverable };
}

function toQualities(representations: readonly { index?: number; height?: number; bandwidth?: number }[]): QualityLevel[] {
  return representations.map((representation, index) => ({
    index,
    label: representation.height
      ? `${representation.height}p`
      : `${Math.round((representation.bandwidth ?? 0) / 1000)} kbps`,
    height: representation.height,
    bitrate: representation.bandwidth,
  }));
}

function toTracks(tracks: ReadonlyArray<{ lang?: string | null; labels?: { text: string }[] | null }>, noun: string): MediaTrack[] {
  return tracks.map((track, id) => ({
    id,
    label: track.labels?.[0]?.text || track.lang || `${noun} ${id + 1}`,
    language: track.lang ?? undefined,
  }));
}

export class DashPlayerEngine implements PlayerEngine {
  readonly kind: EngineKind = 'dash';

  constructor(
    private readonly player: MediaPlayerClass,
    private readonly media: HTMLVideoElement,
    private readonly cleanups: Array<() => void>,
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

  setQuality(index: number | 'auto'): void {
    if (index === 'auto') {
      // -1 asks dash.js to resume automatic bitrate switching.
      this.player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true } } } });
      return;
    }
    const representation = this.player.getRepresentationsByType('video')[index];
    if (representation) {
      this.player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } });
      this.player.setRepresentationForTypeByIndex('video', index);
    }
  }

  setAudioTrack(id: number | null): void {
    const tracks = this.player.getTracksFor('audio');
    if (id === null) {
      return;
    }
    const track = tracks[id];
    if (track) {
      this.player.setCurrentTrack(track);
    }
  }

  setSubtitleTrack(id: number | 'off'): void {
    if (id === 'off') {
      this.player.setTextTrack(-1);
      return;
    }
    this.player.setTextTrack(id);
  }

  seekToLive(): void {
    // dash.js tracks the live edge itself; `seekToOriginalLive` is the documented
    // way back to it, and the media element is the fallback when the player is
    // not streaming yet.
    try {
      this.player.seekToOriginalLive();
    } catch {
      const { seekable } = this.media;
      if (seekable && seekable.length > 0) {
        this.media.currentTime = seekable.end(seekable.length - 1);
      }
      return;
    }
    const { seekable } = this.media;
    if (seekable && seekable.length > 0) {
      const edge = seekable.end(seekable.length - 1);
      // `seekToOriginalLive` is a no-op when already live; make sure we are at
      // the newest available point when the DVR window has moved on.
      if (Math.abs(this.media.currentTime - edge) > 2) {
        this.media.currentTime = edge;
      }
    }
  }

  destroy(): void {
    for (const remove of this.cleanups) {
      remove();
    }
    this.cleanups.length = 0;
    const element = this.media as HTMLVideoElement & { _dashjs_player?: unknown };
    // Detach dash.js from the element before releasing it: the element is reused
    // by the next engine, and a destroyed player must not keep intercepting it.
    try {
      this.player.reset();
    } catch {
      // dash.js throws when resetting before initialisation; destroy() below is
      // the authoritative teardown.
    }
    this.player.destroy();
    delete element._dashjs_player;
    this.media.removeAttribute('src');
    this.media.load();
  }
}

/**
 * Creates a dash.js engine bound to `options.media`.
 * Emits `unsupported` when the browser has no MediaSource at all.
 */
export async function createDashEngine(options: EngineOptions): Promise<PlayerEngine> {
  const { onEvent, media, url } = options;
  // The package's ESM entry mixes a default export with named exports depending
  // on how a bundler unwraps it; resolve both shapes explicitly.
  const module = await import('dashjs');
  const dashjs = (module as { default?: typeof module }).default ?? module;

  if (!dashjs.supportsMediaSource()) {
    onEvent({ type: 'unsupported', reason: 'Este navegador no puede reproducir vídeo DASH.' });
    throw new Error('dash.js unsupported');
  }

  const player = dashjs.MediaPlayer().create();
  const emit = (event: EngineEvent): void => onEvent(event);
  const audioTracks = (): MediaTrack[] => toTracks(player.getTracksFor('audio'), 'Audio');
  const subtitleTracks = (): MediaTrack[] => toTracks(player.getTracksFor('text'), 'Subtítulos');
  const emitTracks = (): void => emit({ type: 'tracks', audio: audioTracks(), subtitles: subtitleTracks() });

  player.updateSettings({
    streaming: {
      // A live channel must stay live: small target delay, ABR on by default.
      delay: { liveDelay: 4 },
      abr: { autoSwitchBitrate: { audio: true, video: true } },
    },
  });

  player.on('streamInitialized', () => {
    emit({ type: 'manifest-ready', qualities: toQualities(player.getRepresentationsByType('video')) });
    emitTracks();
  });
  player.on('textTracksAdded', emitTracks);
  player.on('qualityChangeRendered', (event: { mediaType?: string; newRepresentation?: { index?: number } }) => {
    if (event.mediaType && event.mediaType !== 'video') {
      return;
    }
    if (typeof event.newRepresentation?.index === 'number') {
      emit({ type: 'quality-changed', index: event.newRepresentation.index });
    }
  });
  player.on('playbackEnded', () => emit({ type: 'ended' }));
  player.on('error', (event: DashErrorLike) => emit({ type: 'error', ...classifyDashError(event) }));

  media.volume = options.startVolume;
  media.muted = options.muted;
  const cleanups = attachMediaListeners(media, options);
  player.initialize(media, url, options.autoplay);

  return new DashPlayerEngine(player, media, cleanups);
}
