import { describe, expect, it } from 'vitest';
import { assessHlsPlaylist, parseHlsPlaylist, probeHlsSource } from './hls-manifest';

const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.640020,mp4a.40.2"
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
360/index.m3u8
`;

const MEDIA_LIVE = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:42
#EXTINF:6.0,
seg42.ts
#EXTINF:6.0,
seg43.ts
`;

const MEDIA_EMPTY = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
`;

const AUDIO_ONLY = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"
audio.m3u8
`;

describe('parseHlsPlaylist', () => {
  it('rejects text that is not an HLS playlist', () => {
    expect(parseHlsPlaylist('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"></MPD>')).toBeUndefined();
    expect(parseHlsPlaylist('')).toBeUndefined();
  });

  it('recognises a master playlist and its renditions, codecs and bandwidths', () => {
    const info = parseHlsPlaylist(MASTER);
    expect(info?.kind).toBe('master');
    expect(info?.variants).toHaveLength(2);
    expect(info?.variants[0]).toMatchObject({
      uri: '720/index.m3u8',
      bandwidth: 2_500_000,
      resolution: '1280x720',
      codecs: 'avc1.640020,mp4a.40.2',
    });
    expect(info?.variants[1].bandwidth).toBe(800_000);
  });

  it('recognises a live media playlist and its live window', () => {
    const info = parseHlsPlaylist(MEDIA_LIVE);
    expect(info).toMatchObject({ kind: 'media', ended: false, targetDuration: 6, segmentCount: 2 });
  });

  it('detects a finished (VOD) playlist', () => {
    expect(parseHlsPlaylist(`${MEDIA_LIVE}#EXT-X-ENDLIST\n`)?.ended).toBe(true);
  });
});

describe('assessHlsPlaylist', () => {
  it('accepts a master playlist with a video rendition', () => {
    expect(assessHlsPlaylist(MASTER)).toEqual({ ok: true });
  });

  it('accepts a live media playlist with segments', () => {
    expect(assessHlsPlaylist(MEDIA_LIVE)).toEqual({ ok: true });
  });

  it('classifies an audio-only rendition as a permanent failure', () => {
    const result = assessHlsPlaylist(AUDIO_ONLY);
    expect(result).toMatchObject({ ok: false, code: 'HLS_AUDIO_ONLY', recoverable: false });
  });

  /*
   * Regression (TDT-CLONE-10 §1): the audio-only detector used to infer
   * "audio only" from the *absence* of `RESOLUTION`/`height` or of a declared
   * `CODECS` attribute. Real live TV masters routinely omit both and still
   * carry video, so that detector hid working channels. A rendition is audio
   * only only when its CODECS declare audio codecs and no video codec.
   */
  it('does not treat a video master with undeclared CODECS and no RESOLUTION as audio-only', () => {
    const undeclared = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2500000
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000
360/index.m3u8
`;
    expect(assessHlsPlaylist(undeclared)).toEqual({ ok: true });
  });

  it('does not treat a RESOLUTION-only master (no CODECS) as audio-only', () => {
    const resolutionOnly = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720/index.m3u8
`;
    expect(assessHlsPlaylist(resolutionOnly)).toEqual({ ok: true });
  });

  it('accepts a master that also carries a separate audio rendition group', () => {
    // The audio rendition is a sibling of the video variant, not a replacement.
    const withAudioGroup = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Español",DEFAULT=YES,URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2500000,CODECS="avc1.640020,mp4a.40.2",AUDIO="aud"
720/index.m3u8
`;
    expect(assessHlsPlaylist(withAudioGroup)).toEqual({ ok: true });
  });

  it('classifies an empty media playlist as transient (publisher lag)', () => {
    expect(assessHlsPlaylist(MEDIA_EMPTY)).toMatchObject({ ok: false, code: 'HLS_EMPTY_PLAYLIST', recoverable: true });
  });

  it('refuses an encrypted playlist instead of bypassing its keys', () => {
    const encrypted = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
${MEDIA_LIVE.replace('#EXTM3U\n', '')}`;
    expect(assessHlsPlaylist(encrypted)).toMatchObject({ ok: false, code: 'BLOCKED_ENCRYPTED', recoverable: false });
  });

  it('does not flag METHOD=NONE as encryption', () => {
    const clear = `#EXTM3U
#EXT-X-KEY:METHOD=NONE
${MEDIA_LIVE.replace('#EXTM3U\n', '')}`;
    expect(assessHlsPlaylist(clear).ok).toBe(true);
  });

  it('rejects a payload that is not HLS at all', () => {
    expect(assessHlsPlaylist('{"error":"not found"}')).toMatchObject({ ok: false, code: 'HLS_PLAYLIST_INVALID' });
  });
});

describe('probeHlsSource', () => {
  function response(body: string, status = 200): Response {
    return new Response(body, { status });
  }

  it('accepts a reachable playlist and follows redirects transparently', async () => {
    const calls: string[] = [];
    const fakeFetch = async (url: string) => {
      calls.push(url);
      return response(MASTER);
    };
    await expect(probeHlsSource('https://cdn.example.org/a.m3u8', fakeFetch as unknown as typeof fetch)).resolves.toEqual({
      ok: true,
    });
    expect(calls).toEqual(['https://cdn.example.org/a.m3u8']);
  });

  it('reports a 403/404 as a non-retryable unavailable source', async () => {
    for (const status of [403, 404]) {
      const result = await probeHlsSource(
        'https://cdn.example.org/a.m3u8',
        (async () => response('', status)) as unknown as typeof fetch,
      );
      expect(result).toMatchObject({ ok: false, code: `HLS_HTTP_${status}`, recoverable: false });
    }
  });

  it('treats a server error as transient', async () => {
    const result = await probeHlsSource(
      'https://cdn.example.org/a.m3u8',
      (async () => response('', 503)) as unknown as typeof fetch,
    );
    expect(result).toMatchObject({ ok: false, code: 'HLS_HTTP_503', recoverable: true });
  });

  it('treats a network error as transient', async () => {
    const result = await probeHlsSource(
      'https://cdn.example.org/a.m3u8',
      (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
    );
    expect(result).toMatchObject({ ok: false, code: 'HLS_UNREACHABLE', recoverable: true });
  });

  it('classifies an audio-only master fetched from a CDN', async () => {
    const result = await probeHlsSource(
      'https://cdn.example.org/a.m3u8',
      (async () => response(AUDIO_ONLY)) as unknown as typeof fetch,
    );
    expect(result).toMatchObject({ ok: false, code: 'HLS_AUDIO_ONLY' });
  });
});
