/**
 * hls.js-backed engine for MPEG-TS / fMP4 HLS streams.
 *
 * hls.js is imported dynamically so it lives in its own lazily loaded chunk and
 * never blocks first paint of the catalogue.
 *
 * Media-element events (canplay/playing/waiting/pause/ended/error) come from the
 * shared `attachMediaListeners` helper in `native-engine.ts`, so both engines
 * report the exact same normalised event stream to the controller.
 */
import type { EngineEvent, EngineKind, EngineOptions, MediaTrack, PlayerEngine, QualityLevel } from './engine';
import { attachMediaListeners } from './native-engine';

type HlsModule = typeof import('hls.js');
type HlsInstance = InstanceType<HlsModule['default']>;

export class HlsPlayerEngine implements PlayerEngine {
  readonly kind: EngineKind = 'hls';

  constructor(
    private readonly hls: HlsInstance,
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
    this.hls.currentLevel = index === 'auto' ? -1 : index;
  }

  setAudioTrack(id: number | null): void {
    this.hls.audioTrack = id ?? -1;
  }

  setSubtitleTrack(id: number | 'off'): void {
    this.hls.subtitleTrack = id === 'off' ? -1 : id;
  }

  seekToLive(): void {
    // `liveSyncPosition` exists once playback is under way and is the decoder-
    // safe live point; otherwise the seekable live edge is the best target.
    const liveEdge = this.hls.liveSyncPosition;
    if (typeof liveEdge === 'number' && Number.isFinite(liveEdge)) {
      this.media.currentTime = liveEdge;
    } else if (this.media.seekable && this.media.seekable.length > 0) {
      this.media.currentTime = this.media.seekable.end(this.media.seekable.length - 1);
    }
  }

  destroy(): void {
    for (const remove of this.cleanups) {
      remove();
    }
    this.cleanups.length = 0;
    // hls.js must detach from the element before the next engine claims it,
    // otherwise its source buffers stay bound to the reused <video>.
    this.hls.detachMedia();
    this.hls.destroy();
    this.media.removeAttribute('src');
    this.media.load();
  }
}

const HLS_ERROR_TEXT: Readonly<Record<string, string>> = {
  bufferAppendError: 'La fuente no ha entregado vídeo válido (segmento no disponible).',
  bufferStalledError: 'La emisión se ha detenido al quedarse sin datos.',
  manifestLoadError: 'No se ha podido descargar la lista de reproducción.',
  manifestParsingError: 'La lista de reproducción no es válida.',
  manifestIncompatibleCodecsError: 'Esta emisión usa un formato de vídeo que tu navegador no admite.',
  levelLoadError: 'No se han podido descargar los datos de la emisión.',
  levelLoadTimeOut: 'El servidor de la emisión no responde.',
  levelEmptyError: 'La lista de reproducción está vacía.',
  fragLoadError: 'No se ha podido descargar un fragmento de la emisión.',
  fragParsingError: 'Un fragmento de la emisión no es válido.',
  audioTrackLoadError: 'No se han podido cargar las pistas de audio.',
  audioTrackLoadTimeOut: 'Las pistas de audio no responden.',
  subtitleTrackLoadError: 'No se han podido cargar los subtítulos.',
  keyLoadError: 'La emisión está protegida y no se puede desbloquear aquí.',
};

function formatHlsError(data: { details?: string; reason?: string; type?: string }): string {
  const known = data.details ? HLS_ERROR_TEXT[data.details] : undefined;
  return known ?? data.reason ?? data.details ?? data.type ?? 'No se pudo cargar la emisión.';
}

/**
 * Error detail codes that retrying the same source cannot fix: the browser
 * cannot decode it, the manifest is not valid HLS, or the playlist is empty.
 */
const HLS_PERMANENT_DETAILS: readonly string[] = [
  'manifestParsingError',
  'manifestIncompatibleCodecsError',
  'fragParsingError',
  'levelEmptyError',
];

/** Errors that mean the stream is key-locked (DRM), which we never bypass. */
const HLS_DRM_DETAILS: readonly string[] = ['keyLoadError', 'keySystemError'];

/** Container/format mismatch: the URL is not an HLS playlist at all. */
const HLS_FORMAT_MISMATCH_DETAILS: readonly string[] = ['manifestIncompatibleCodecsError'];

function toQualities(levels: readonly { height?: number; bitrate?: number }[]): QualityLevel[] {
  return levels.map((level, index) => ({
    index,
    label: level.height ? `${level.height}p` : `${Math.round((level.bitrate ?? 0) / 1000)} kbps`,
    height: level.height,
    bitrate: level.bitrate,
  }));
}

function toTracks(
  tracks: ReadonlyArray<{ name?: string; lang?: string }>,
  fallbackNoun: string,
): MediaTrack[] {
  return tracks.map((track, id) => ({
    id,
    label: track.name || track.lang || `${fallbackNoun} ${id + 1}`,
    language: track.lang,
  }));
}

interface HlsErrorData {
  readonly fatal?: boolean;
  readonly details?: string;
  readonly reason?: string;
  readonly type?: string;
}

/**
 * Classifies an hls.js fatal error for the controller. Exported for tests: the
 * recoverable/fatal split is the fallback state machine's only input.
 */
export function classifyHlsError(
  data: HlsErrorData,
  context: { noFramesYet: boolean; networkErrorType: string; mediaErrorType: string },
): { code: string; message: string; recoverable: boolean } {
  const code = data.details ?? data.type ?? 'HLS_ERROR';
  if (data.details && HLS_DRM_DETAILS.includes(data.details)) {
    return { code: 'BLOCKED_DRM', message: 'La emisión está protegida y no se puede desbloquear aquí.', recoverable: false };
  }
  if (data.details && HLS_FORMAT_MISMATCH_DETAILS.includes(data.details)) {
    return { code: 'FORMAT_MISMATCH', message: formatHlsError(data), recoverable: false };
  }
  if (data.details && HLS_PERMANENT_DETAILS.includes(data.details)) {
    return { code, message: formatHlsError(data), recoverable: false };
  }
  // A segment that fails to download surfaces as a MEDIA_ERROR
  // (bufferAppendError) even though the cause is the network. When no frame has
  // been rendered yet, retrying the same source is legitimate.
  const networkish =
    data.type === context.networkErrorType ||
    (data.type === context.mediaErrorType && context.noFramesYet);
  return { code, message: formatHlsError(data), recoverable: networkish };
}

/**
 * Creates an hls.js engine bound to `options.media`.
 * Emits `unsupported` when hls.js cannot drive this browser.
 */
export async function createHlsEngine(options: EngineOptions): Promise<PlayerEngine> {
  const { onEvent, media, url } = options;
  const module = await import('hls.js');
  const Hls = module.default;

  if (!Hls.isSupported()) {
    onEvent({ type: 'unsupported', reason: 'Este navegador no puede reproducir vídeo HLS.' });
    throw new Error('hls.js unsupported');
  }

  const hls = new Hls({
    enableWorker: true,
    lowLatencyMode: false,
    backBufferLength: 30,
  });

  const emit = (event: EngineEvent): void => onEvent(event);
  const emitTracks = (): void =>
    emit({ type: 'tracks', audio: toTracks(hls.audioTracks, 'Audio'), subtitles: toTracks(hls.subtitleTracks, 'Subtítulos') });

  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    emit({ type: 'manifest-ready', qualities: toQualities(hls.levels) });
  });
  hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
    emit({ type: 'quality-changed', index: data.level });
  });
  hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, emitTracks);
  hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, emitTracks);
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal) {
      return;
    }
    const classified = classifyHlsError(data, {
      noFramesYet: media.videoWidth === 0,
      networkErrorType: Hls.ErrorTypes.NETWORK_ERROR,
      mediaErrorType: Hls.ErrorTypes.MEDIA_ERROR,
    });
    emit({ type: 'error', ...classified });
  });

  media.volume = options.startVolume;
  media.muted = options.muted;
  const cleanups = attachMediaListeners(media, options);
  hls.loadSource(url);
  hls.attachMedia(media);

  return new HlsPlayerEngine(hls, media, cleanups);
}
