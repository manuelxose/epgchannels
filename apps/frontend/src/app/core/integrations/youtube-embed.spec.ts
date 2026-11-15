import { describe, expect, it } from 'vitest';
import {
  classifyYoutubeError,
  isEmbeddableYoutubeUrl,
  loadYoutubeApi,
  youtubeChannelLiveUrl,
  youtubeEmbedConfig,
  youtubeTargetOf,
  youtubeVideoEmbedConfig,
  YOUTUBE_NOCOOKIE_HOST,
} from './youtube-embed';

/**
 * The YouTube integration is deliberately narrow: it only understands the
 * published page URLs, never stream URLs. These tests pin that boundary.
 */
describe('youtubeTargetOf', () => {
  it('reads the channel id from an official channel live page', () => {
    expect(youtubeTargetOf('https://www.youtube.com/channel/UCOCGPFW1UqPP9zdol7vEK1A/live')).toEqual({
      kind: 'channel',
      id: 'UCOCGPFW1UqPP9zdol7vEK1A',
    });
  });

  it('reads the video id from every official video page shape', () => {
    for (const url of [
      'https://www.youtube.com/live/OkQduT-9Pyc',
      'https://www.youtube.com/embed/OkQduT-9Pyc',
      'https://www.youtube.com/watch?v=OkQduT-9Pyc',
      'https://youtu.be/OkQduT-9Pyc',
      'https://www.youtube.com/shorts/OkQduT-9Pyc',
    ]) {
      expect(youtubeTargetOf(url), url).toEqual({ kind: 'video', id: 'OkQduT-9Pyc' });
    }
  });

  it('rejects pages it cannot address and non-YouTube hosts', () => {
    expect(youtubeTargetOf('https://www.youtube.com/@emisora')).toBeUndefined();
    expect(youtubeTargetOf('https://www.youtube.com/playlist?list=PL1')).toBeUndefined();
    expect(youtubeTargetOf('https://notyoutube.example.org/live/OkQduT-9Pyc')).toBeUndefined();
    expect(youtubeTargetOf('javascript:alert(1)')).toBeUndefined();
    expect(youtubeTargetOf('data:text/html,<script>alert(1)</script>')).toBeUndefined();
  });
});

describe('youtubeEmbedConfig', () => {
  it('uses the privacy-enhanced host and restricts the origin to ours', () => {
    const config = youtubeEmbedConfig('https://www.youtube.com/live/OkQduT-9Pyc', 'https://player.example.org');
    expect(config).toBeDefined();
    expect(config?.host).toBe(YOUTUBE_NOCOOKIE_HOST);
    expect(config?.videoId).toBe('OkQduT-9Pyc');
    expect(config?.playerVars).toMatchObject({
      origin: 'https://player.example.org',
      autoplay: 1,
      playsinline: 1,
      rel: 0,
    });
  });

  it('restricts origin to the real origin and omits it when there is none', () => {
    const config = youtubeEmbedConfig('https://www.youtube.com/live/OkQduT-9Pyc', undefined);
    // jsdom has an origin (http://localhost:3000); the parameter only exists when
    // there is a real browsing context, and it must never be a forged value.
    expect(config?.playerVars['origin'] ?? 'absent').toBe('http://localhost:3000');
    expect(youtubeEmbedConfig('https://www.youtube.com/live/OkQduT-9Pyc', '')?.playerVars['origin']).toBeUndefined();
  });

  it('refuses a channel page: only a video id can be driven and observed', () => {
    // A channel page names a channel, not a video: the IFrame API cannot observe
    // its state, so it must be resolved to a video id first.
    expect(youtubeEmbedConfig('https://www.youtube.com/channel/UCOCGPFW1UqPP9zdol7vEK1A/live', 'https://x.test')).toBeUndefined();
    expect(youtubeEmbedConfig('https://www.youtube.com/@algo', 'https://x.test')).toBeUndefined();
    // An already validated video id still yields a full configuration.
    expect(youtubeVideoEmbedConfig('OkQduT-9Pyc', 'https://x.test')).toMatchObject({
      host: YOUTUBE_NOCOOKIE_HOST,
      videoId: 'OkQduT-9Pyc',
    });
    expect(youtubeVideoEmbedConfig('not-a-video-id', 'https://x.test')).toBeUndefined();
  });

  it('builds the documented channel live-stream embed URL with autoplay', () => {
    /*
     * MEASURED: the bare channel embed mounts PAUSED; `autoplay=1` and
     * `playsinline=1` are what make YouTube start it on its own. It stays on the
     * privacy-enhanced host and carries our origin, like the video player.
     */
    const url = youtubeChannelLiveUrl('UCOCGPFW1UqPP9zdol7vEK1A', 'https://player.example.org');
    const parsed = new URL(url);
    expect(parsed.origin).toBe(YOUTUBE_NOCOOKIE_HOST);
    expect(parsed.pathname).toBe('/embed/live_stream');
    expect(parsed.searchParams.get('channel')).toBe('UCOCGPFW1UqPP9zdol7vEK1A');
    expect(parsed.searchParams.get('autoplay')).toBe('1');
    expect(parsed.searchParams.get('playsinline')).toBe('1');
    expect(parsed.searchParams.get('origin')).toBe('https://player.example.org');
  });

  it('loads the published API script into the given document', async () => {
    // The loader is the only place that injects the third-party script: it must
    // target the document it is given (the browser's in production) and refuse
    // cleanly when there is none, which is what the SSR guard relies on.
    const doc = document.implementation.createHTMLDocument('yt');
    const loading = loadYoutubeApi(doc);
    const script = doc.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    expect(script).not.toBeNull();
    // The script never actually downloads in the test environment: it errors,
    // and the loader must report that as a rejection (never a hang).
    (script as HTMLScriptElement).onerror?.(new Event('error'));
    await expect(loading).rejects.toThrow(/No se ha podido cargar/);
  });

  it('marks only addressable YouTube pages as embeddable', () => {
    expect(isEmbeddableYoutubeUrl('https://www.youtube.com/channel/UC7QZIf0dta-XPXsp9Hv4dTw/live')).toBe(true);
    expect(isEmbeddableYoutubeUrl('https://www.youtube.com/@emisora/live')).toBe(false);
  });
});

describe('classifyYoutubeError', () => {
  it('separates "the owner forbids embedding" from "the stream is gone"', () => {
    expect(classifyYoutubeError(101).kind).toBe('embedding');
    expect(classifyYoutubeError(150).kind).toBe('embedding');
    expect(classifyYoutubeError(100).kind).toBe('unavailable');
    expect(classifyYoutubeError(2).kind).toBe('invalid');
    expect(classifyYoutubeError(5).kind).toBe('unavailable');
    expect(classifyYoutubeError(999).message).toMatch(/error/);
  });

  /*
   * 153 is not "the video is gone": YouTube refuses to serve the player at all
   * when the embedding page sent no HTTP Referer (or equivalent client
   * identification). Reporting it as unavailable would blame the emitter for
   * our own deployment problem, so it has its own kind and its own message.
   */
  it('treats 153 as a missing client identity, not a missing stream', () => {
    const classified = classifyYoutubeError(153);
    expect(classified.kind).toBe('client-identity');
    expect(classified.message).toMatch(/identific/i);
  });
});
