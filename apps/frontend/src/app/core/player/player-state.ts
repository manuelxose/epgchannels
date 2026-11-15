/**
 * Player state machine.
 *
 * The player is modelled as an explicit finite automaton so every UI layer
 * renders from one source of truth and tests can assert transitions by name.
 *
 * Status vocabulary (behaviour spec §5, P5):
 * - `loading`     a source is being resolved (manifest/engine start, or a fallback step);
 * - `buffering`   playback is underway but data is momentarily missing;
 * - `playing` / `paused`;
 * - `error`       retries for the current source are exhausted (actionable: retry);
 * - `unavailable` no eligible source is left for this channel (all failed/blocked);
 * - `external`    the official emitter player must be used (never proxied by us);
 * - `blocked`     the source cannot be played here (DRM/geo/unauthorised integration);
 * - `unsupported` this browser cannot decode the stream at all.
 */

export type PlayerStatus =
  | 'idle'
  | 'loading'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'error'
  | 'unavailable'
  | 'external'
  | 'blocked'
  | 'unsupported';

export type PlayerEvent =
  | 'select-source'
  | 'manifest-ready'
  | 'can-play'
  | 'playing'
  | 'waiting'
  | 'pause'
  | 'ended'
  | 'error'
  | 'unavailable'
  | 'external'
  | 'blocked'
  | 'unsupported'
  | 'clear';

const TRANSITIONS: Readonly<Record<PlayerStatus, readonly PlayerEvent[]>> = {
  /*
   * `load()` starts from `clear()`, so a channel that needs no engine can be
   * decided straight from `idle`: a refusal (`blocked`) or an emitter route
   * (`external`) is a terminal answer, not a pending state. `unavailable` too:
   * a channel that publishes nothing attemptable is settled, not idle.
   */
  idle: ['select-source', 'unavailable', 'external', 'blocked', 'clear'],
  loading: ['manifest-ready', 'can-play', 'playing', 'error', 'unavailable', 'external', 'blocked', 'unsupported', 'clear'],
  /*
   * `blocked` and `unsupported` are terminal refusals that can arrive at any
   * moment, including after playback has started (a DRM handshake or a codec
   * check fails late). Omitting them here made the reducer silently keep
   * `playing` while the engine had already been torn down, so the UI reported a
   * healthy player over a dead stream.
   *
   * `unavailable` was missing from the same list: a YouTube live that has ended
   * (error 100) is gone for good, and from `buffering` or `playing` the reducer
   * would have ignored the transition and kept claiming playback while the
   * engine was already released.
   */
  buffering: [
    'playing',
    'can-play',
    'pause',
    'waiting',
    'error',
    'unavailable',
    'external',
    'blocked',
    'unsupported',
    'clear',
  ],
  playing: ['waiting', 'pause', 'error', 'unavailable', 'external', 'blocked', 'unsupported', 'ended', 'clear'],
  paused: ['playing', 'waiting', 'error', 'unavailable', 'external', 'blocked', 'unsupported', 'clear'],
  // A source failure may advance to another source (which starts again at
  // `loading`), and the cascade may reach any terminal state: a refused or
  // undecodable route, a dead channel with no official player, or the emitter's
  // own player. The terminal states themselves stay terminal.
  error: ['select-source', 'unavailable', 'external', 'blocked', 'unsupported', 'clear'],
  unavailable: ['select-source', 'external', 'clear'],
  external: ['select-source', 'clear'],
  blocked: ['select-source', 'clear'],
  unsupported: ['select-source', 'clear'],
};

/** Pure reducer: returns the next status, ignoring events that are not valid. */
export function reducePlayerStatus(status: PlayerStatus, event: PlayerEvent): PlayerStatus {
  if (!TRANSITIONS[status].includes(event)) {
    return status;
  }
  switch (event) {
    case 'select-source':
      return 'loading';
    case 'manifest-ready':
      return status === 'loading' ? 'loading' : status;
    case 'can-play':
      return 'paused';
    case 'playing':
      return 'playing';
    case 'waiting':
      return status === 'playing' || status === 'buffering' ? 'buffering' : status;
    case 'pause':
      // An engine may report `pause` while it is still loading (attach/detach
      // cycles, source switches). That is not a user-visible paused state yet.
      return status === 'loading' || status === 'buffering' ? status : 'paused';
    case 'ended':
      return 'paused';
    case 'error':
      return 'error';
    case 'unavailable':
      return 'unavailable';
    case 'external':
      return 'external';
    case 'blocked':
      return 'blocked';
    case 'unsupported':
      return 'unsupported';
    case 'clear':
      return 'idle';
    default:
      return status;
  }
}

/** Statuses that end playback for the current source until an explicit action. */
export const TERMINAL_STATUSES: readonly PlayerStatus[] = ['error', 'unavailable', 'external', 'blocked', 'unsupported'];

export function isTerminalStatus(status: PlayerStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * User-facing playback classes (P5). A status alone does not say whether the
 * user can act: `error` is recoverable in place, `unavailable` means another
 * source must be chosen, `external` means the emitter's own player is the only
 * official route, and `blocked` means we decline to play it here.
 */
export type PlaybackState =
  | 'idle'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'recoverable-failure'
  | 'source-unavailable'
  | 'eventual-emission'
  | 'external-official'
  | 'unauthorised'
  | 'unsupported';

export function playbackStateFor(status: PlayerStatus): PlaybackState {
  switch (status) {
    case 'idle':
      return 'idle';
    case 'loading':
    case 'buffering':
      return 'loading';
    case 'playing':
      return 'playing';
    case 'paused':
      return 'paused';
    case 'error':
      return 'recoverable-failure';
    case 'unavailable':
      return 'source-unavailable';
    case 'blocked':
      return 'unauthorised';
    case 'external':
      return 'external-official';
    case 'unsupported':
      return 'unsupported';
  }
}

export interface PlayerErrorInfo {
  readonly code: string;
  readonly message: string;
  /** True when retrying the same source may succeed. */
  readonly recoverable: boolean;
}

/** Why a source cannot be attempted any more (spec §5.4). */
export type SourceFailureCause =
  | 'network'
  | 'unreachable'
  | 'format'
  | 'codec'
  | 'blocked'
  | 'unsupported'
  | 'stalled'
  | 'no-frames';

/**
 * Classifies a failure so the fallback logic can decide whether another source
 * is worth trying. Only `transient` failures justify an extra attempt.
 */
export type FailureClass = 'transient' | 'permanent' | 'blocked' | 'unsupported' | 'invalid';

export function classifyFailure(error: PlayerErrorInfo): FailureClass {
  const code = error.code.toUpperCase();
  if (code.startsWith('UNSUPPORTED') || code.includes('MEDIASOURCE_UNAVAILABLE') || code.includes('CODEC_UNSUPPORTED')) {
    return 'unsupported';
  }
  if (
    code.includes('DRM') ||
    code.includes('KEY_SYSTEM') ||
    code.includes('GEO') ||
    code.startsWith('BLOCKED') ||
    code.includes('UNAUTHORISED') ||
    code.includes('UNAUTHORIZED')
  ) {
    return 'blocked';
  }
  if (code.includes('MANIFEST_INVALID') || code.includes('FORMAT_MISMATCH') || code.includes('SCHEME')) {
    return 'invalid';
  }
  if (error.recoverable) {
    return 'transient';
  }
  if (code.includes('MEDIA_') || code.includes('CODEC')) {
    return 'permanent';
  }
  return 'permanent';
}

/**
 * Decides which source index to try next.
 *
 * Rules (bounded, no loops): only a `transient` failure of the current source
 * may move on, each source is tried at most once per load, a source already
 * marked as failed/blocked is never retried, and the search is a single pass
 * over the eligible sources.
 *
 * Scope note: this helper answers "may the *same route* be retried, and where
 * does the search continue". Whether a non-transient failure of a route is
 * worth trying on *another* source is a controller decision.
 */
export function nextFallbackIndex(
  sources: readonly { readonly id: string; readonly eligible: boolean }[],
  failed: readonly string[],
  currentIndex: number,
  failure: FailureClass,
): number | undefined {
  if (failure !== 'transient') {
    return undefined;
  }
  for (let offset = 1; offset <= sources.length; offset += 1) {
    const index = (currentIndex + offset) % sources.length;
    if (index === currentIndex) {
      continue;
    }
    const source = sources[index];
    if (source && source.eligible && !failed.includes(source.id)) {
      return index;
    }
  }
  return undefined;
}
