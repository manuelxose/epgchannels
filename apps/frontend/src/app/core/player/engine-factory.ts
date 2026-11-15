import { createDashEngine } from './dash-engine';
import { createHlsEngine } from './hls-engine';
import { createNativeEngine, supportsNative } from './native-engine';
import { YoutubePlaybackEngine, YoutubeEngineRefusal } from './youtube-engine';
import type { EngineOptions, EngineRequestKind, PlayerEngine, EngineEvent } from './engine';

/**
 * Chooses the backend for a given source and returns a ready engine.
 *
 * - `youtube` → the official YouTube IFrame player (`YouTubePlaybackEngine`),
 *   never hls.js/dash.js: a YouTube page is not a manifest we may fetch;
 * - `dash` → dash.js (an MPD is never handed to the element as a progressive file);
 * - `progressive` → native element;
 * - `hls` + definitive native support (Safari/iOS) → native element;
 * - `hls` + MediaSource → lazily imported hls.js;
 * - `hls` + neither → `unsupported`, surfaced through the event channel.
 */
export async function createEngine(options: EngineOptions, kind: EngineRequestKind): Promise<PlayerEngine> {
  if (kind === 'youtube') {
    return createYoutubeEngine(options);
  }
  if (kind === 'dash') {
    return createDashEngine(options);
  }
  if (kind === 'progressive') {
    return createNativeEngine(options);
  }
  if (supportsNative(options.media, 'hls')) {
    return createNativeEngine(options);
  }
  if (typeof MediaSource === 'undefined') {
    options.onEvent({ type: 'unsupported', reason: 'Este navegador no puede reproducir vídeo en continuo.' });
    throw new Error('MediaSource unavailable');
  }
  return createHlsEngine(options);
}

/**
 * Builds the official YouTube engine.
 *
 * A page we cannot address (a channel page, a handle, an unknown path) is a
 * refusal, not an error to retry. It is reported ONCE, through the throw: the
 * controller's `start()` catch is the single owner of an engine-start failure.
 * Emitting an `error` event *and* throwing made the controller handle the same
 * failure twice (a terminal refusal followed by a retryable `ENGINE_START`
 * that re-armed the retry timer).
 */
async function createYoutubeEngine(options: EngineOptions): Promise<PlayerEngine> {
  try {
    return await YoutubePlaybackEngine.create(options);
  } catch (error) {
    if (error instanceof YoutubeEngineRefusal) {
      throw new YoutubeEngineError(error.code, error.message, error.code === 'YOUTUBE_API_LOAD');
    }
    throw error;
  }
}

/** An engine-start failure whose classification the controller can read. */
export class YoutubeEngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recoverable: boolean,
  ) {
    super(message);
    this.name = 'YoutubeEngineError';
  }
}
