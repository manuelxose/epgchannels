/**
 * Minimal, dependency-free HLS playlist analyser.
 *
 * It exists to make real HLS defects visible *before* playback: an audio-only
 * rendition cannot produce video frames, a media playlist with no segments is
 * empty, and an encrypted or key-locked playlist must not be presented as a
 * generic playback error. The analyser is pure so it can be unit tested and so
 * the same rules apply to master and media manifests.
 */

export interface HlsVariant {
  readonly uri: string;
  readonly bandwidth?: number;
  readonly codecs?: string;
  readonly resolution?: string;
}

export interface HlsPlaylistInfo {
  readonly kind: 'master' | 'media';
  readonly variants: readonly HlsVariant[];
  /** True when the playlist carries `#EXT-X-ENDLIST`. */
  readonly ended: boolean;
  /** Target duration declared by a media playlist, in seconds. */
  readonly targetDuration?: number;
  readonly segmentCount: number;
}

const VIDEO_CODECS = ['avc1', 'avc3', 'hvc1', 'hev1', 'vp8', 'vp09', 'av01', 'dvh1', 'dvhe'];

function attribute(line: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[:,])${name}=("[^"]*"|[^,]*)`).exec(line);
  const raw = match?.[1];
  return raw ? raw.replace(/^"|"$/g, '') : undefined;
}

/** Returns the playlist structure, or `undefined` when the text is not HLS. */
export function parseHlsPlaylist(text: string): HlsPlaylistInfo | undefined {
  if (!/^\s*#EXTM3U/m.test(text)) {
    return undefined;
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const variants: HlsVariant[] = [];
  let segmentCount = 0;
  let targetDuration: number | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const uri = lines.slice(index + 1).find((next) => !next.startsWith('#'));
      if (uri) {
        const bandwidth = attribute(line, 'BANDWIDTH') ?? attribute(line, 'AVERAGE-BANDWIDTH');
        variants.push({
          uri,
          bandwidth: bandwidth ? Number(bandwidth) : undefined,
          codecs: attribute(line, 'CODECS'),
          resolution: attribute(line, 'RESOLUTION'),
        });
      }
    } else if (line.startsWith('#EXTINF')) {
      segmentCount += 1;
    } else if (line.startsWith('#EXT-X-TARGETDURATION')) {
      const value = Number(line.split(':')[1]);
      targetDuration = Number.isFinite(value) ? value : undefined;
    }
  }

  return {
    kind: variants.length > 0 ? 'master' : 'media',
    variants,
    ended: /#EXT-X-ENDLIST/.test(text),
    targetDuration,
    segmentCount,
  };
}

export interface HlsAssessment {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly recoverable?: boolean;
}

function isVideoCodec(codecs: string | undefined): boolean {
  if (!codecs) {
    // No CODECS attribute: assume it may carry video rather than reject it.
    return true;
  }
  return codecs
    .toLowerCase()
    .split(',')
    .some((codec) => VIDEO_CODECS.some((prefix) => codec.trim().startsWith(prefix)));
}

/**
 * Decides whether a fetched HLS playlist can plausibly render video.
 * Failures are classified so the fallback logic can act on them:
 * - encrypted (METHOD !== NONE): blocked, never bypassed;
 * - audio-only: permanent, another source is the only route;
 * - empty media playlist: transient, a CDN may still be publishing.
 */
export function assessHlsPlaylist(text: string): HlsAssessment {
  const info = parseHlsPlaylist(text);
  if (!info) {
    return { ok: false, code: 'HLS_PLAYLIST_INVALID', message: 'El manifiesto de la emisión no es válido.', recoverable: false };
  }
  if (/#EXT-X-KEY:[^\n]*METHOD=(?!NONE)[A-Z0-9-]+/.test(text) || /#EXT-X-SESSION-KEY:/.test(text)) {
    return {
      ok: false,
      code: 'BLOCKED_ENCRYPTED',
      message: 'Esta emisión está protegida con llaves y no se puede reproducir aquí.',
      recoverable: false,
    };
  }
  if (info.kind === 'master') {
    if (!info.variants.some((variant) => isVideoCodec(variant.codecs))) {
      return {
        ok: false,
        code: 'HLS_AUDIO_ONLY',
        message: 'La fuente solo contiene audio; no hay vídeo que mostrar.',
        recoverable: false,
      };
    }
    return { ok: true };
  }
  // Media playlist: a live window is appended continuously, so an empty one
  // usually means "not published yet", not "never available".
  if (info.segmentCount === 0) {
    return {
      ok: false,
      code: 'HLS_EMPTY_PLAYLIST',
      message: 'La emisión no publica fragmentos en este momento.',
      recoverable: true,
    };
  }
  return { ok: true };
}

/**
 * Probes an HLS source without an engine: classifies a redirect (allowed, the
 * fetch follows it), a 403/404 (source unavailable) and an audio-only rendition.
 * Network errors are transient; a refusal is not.
 */
export async function probeHlsSource(url: string, fetchImpl: typeof fetch = fetch): Promise<HlsAssessment> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'GET', credentials: 'omit', redirect: 'follow' });
  } catch {
    return { ok: false, code: 'HLS_UNREACHABLE', message: 'No se ha podido contactar con el servidor de la emisión.', recoverable: true };
  }
  if (!response.ok) {
    return {
      ok: false,
      code: `HLS_HTTP_${response.status}`,
      message:
        response.status === 403 || response.status === 401
          ? 'El servidor rechaza reproducir esta emisión fuera de su propia página.'
          : 'La emisión no está disponible en este momento.',
      recoverable: response.status >= 500,
    };
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, code: 'HLS_READ_FAILED', message: 'No se ha podido leer el manifiesto de la emisión.', recoverable: true };
  }
  return assessHlsPlaylist(text);
}
