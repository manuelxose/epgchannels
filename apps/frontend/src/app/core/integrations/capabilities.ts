/**
 * What this browser can actually attempt in-app.
 *
 * The verified state must never claim "Ver en directo" for a container the
 * browser cannot decode, so the capability probe is explicit and cheap:
 * `MediaSource` presence (hls.js/dash.js) plus the element's own `canPlayType`.
 */
import type { PlaybackCapabilities } from './verified-state';

export function probePlaybackCapabilities(): PlaybackCapabilities {
  const mediaSource = typeof globalThis.MediaSource !== 'undefined';
  const probe = typeof document === 'undefined' ? undefined : document.createElement('video');
  return {
    mediaSource,
    canPlayHls:
      probe?.canPlayType('application/vnd.apple.mpegurl') === 'probably' ||
      probe?.canPlayType('application/x-mpegURL') === 'probably',
    canPlayProgressive: probe?.canPlayType('video/mp4') === 'probably' || probe?.canPlayType('video/mp4') === 'maybe',
  };
}
