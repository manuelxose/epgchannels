import { describe, expect, it } from 'vitest';
import {
  isChannelLivePath,
  normalizeChannelId,
  normalizeVideoId,
  resolveYoutubeTarget,
  youtubeChannelWatchUrl,
  youtubeWatchUrl,
} from './youtube-target';

/**
 * The resolver is the first security boundary of YouTube playback: everything
 * that reaches the official player is an id that passed through here.
 */
describe('resolveYoutubeTarget — video identifiers', () => {
  it('reads the video id from every published URL shape', () => {
    const shapes = [
      'https://www.youtube.com/watch?v=OkQduT-9Pyc',
      'https://www.youtube.com/live/OkQduT-9Pyc',
      'https://www.youtube.com/embed/OkQduT-9Pyc',
      'https://youtu.be/OkQduT-9Pyc',
      'https://www.youtube.com/v/OkQduT-9Pyc',
      'https://www.youtube.com/shorts/OkQduT-9Pyc',
      'https://www.youtube.com/watch?app=desktop&v=OkQduT-9Pyc&t=30',
      'https://m.youtube.com/watch?v=OkQduT-9Pyc',
    ];
    for (const url of shapes) {
      const result = resolveYoutubeTarget(url);
      expect(result.ok, url).toBe(true);
      expect(result.ok && result.target, url).toEqual({ kind: 'video', videoId: 'OkQduT-9Pyc' });
    }
  });

  it('rejects a malformed video id instead of "fixing" it', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/live/OkQduT-9PycEXTRA',
      'https://youtu.be/',
      'https://www.youtube.com/watch?v=OkQduT 9Pyc',
      'https://www.youtube.com/watch?v=OkQduT-9P%3C',
    ]) {
      const result = resolveYoutubeTarget(url);
      expect(result.ok, url).toBe(false);
      expect(!result.ok && result.problem, url).toBe('invalid-video-id');
    }
  });

  it('never normalises an id by trimming or case-folding its content', () => {
    const result = resolveYoutubeTarget('https://www.youtube.com/live/okqdut-9pyc');
    expect(result.ok && result.target).toEqual({ kind: 'video', videoId: 'okqdut-9pyc' });
  });
});

describe('resolveYoutubeTarget — channel identifiers', () => {
  it('reads the channel id from the live page and the documented embed', () => {
    const live = resolveYoutubeTarget('https://www.youtube.com/channel/UCOCGPFW1UqPP9zdol7vEK1A/live');
    expect(live.ok && live.target).toEqual({ kind: 'channel', channelId: 'UCOCGPFW1UqPP9zdol7vEK1A' });
    const embed = resolveYoutubeTarget('https://www.youtube.com/embed/live_stream?channel=UCOCGPFW1UqPP9zdol7vEK1A');
    expect(embed.ok && embed.target).toEqual({ kind: 'channel', channelId: 'UCOCGPFW1UqPP9zdol7vEK1A' });
  });

  it('separates a channel id from a video id (they are not interchangeable)', () => {
    const channelId = 'UCOCGPFW1UqPP9zdol7vEK1A';
    expect(normalizeVideoId(channelId)).toBeUndefined();
    expect(normalizeChannelId(channelId)).toBe(channelId);
    expect(normalizeChannelId('OkQduT-9Pyc')).toBeUndefined();
    const asVideo = resolveYoutubeTarget(`https://www.youtube.com/watch?v=${channelId}`);
    expect(asVideo.ok).toBe(false);
  });

  it('identifies a channel page without /live, but only as a channel', () => {
    // The channel id is readable, but this is NOT a live path: the caller must
    // still ask whether the channel is broadcasting.
    const result = resolveYoutubeTarget('https://www.youtube.com/channel/UCOCGPFW1UqPP9zdol7vEK1A');
    expect(result.ok && result.target).toEqual({ kind: 'channel', channelId: 'UCOCGPFW1UqPP9zdol7vEK1A' });
    expect(isChannelLivePath('https://www.youtube.com/channel/UCOCGPFW1UqPP9zdol7vEK1A')).toBe(false);
  });

  it('accepts only the documented live sub-path of a channel page', () => {
    // `/channel/<UC…>/videos` (or anything else) is not the live page.
    expect(resolveYoutubeTarget('https://www.youtube.com/channel/UCOCGPFW1UqPP9zdol7vEK1A/videos').ok).toBe(false);
    expect(resolveYoutubeTarget('https://www.youtube.com/channel/UCOCGPFW1UqPP9zdol7vEK1A/streams/live').ok).toBe(false);
  });

  it('recognises handles without inventing an id for them', () => {
    for (const url of ['https://www.youtube.com/@emisora', 'https://www.youtube.com/@emisora/live']) {
      const result = resolveYoutubeTarget(url);
      expect(result.ok && result.target, url).toEqual({ kind: 'handle', handle: 'emisora' });
    }
    expect(resolveYoutubeTarget('https://www.youtube.com/@a').ok).toBe(false);
    expect(resolveYoutubeTarget('https://www.youtube.com/@bad handle').ok).toBe(false);
  });

  it('recognises the legacy /c/ and /user/ pages as handles', () => {
    expect(resolveYoutubeTarget('https://www.youtube.com/c/emisora/live')).toMatchObject({
      ok: true,
      target: { kind: 'handle', handle: 'emisora' },
    });
    expect(resolveYoutubeTarget('https://www.youtube.com/user/emisora/live')).toMatchObject({
      ok: true,
      target: { kind: 'handle', handle: 'emisora' },
    });
  });
});

describe('resolveYoutubeTarget — refusals', () => {
  it('refuses foreign hosts, including lookalikes and schemes', () => {
    for (const url of [
      'https://notyoutube.example.org/live/OkQduT-9Pyc',
      'https://youtube.example.org/live/OkQduT-9Pyc',
      'https://evil.test/?u=https://www.youtube.com/live/OkQduT-9Pyc',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'not a url at all',
      '',
    ]) {
      const result = resolveYoutubeTarget(url);
      expect(result.ok, url).toBe(false);
    }
  });

  it('accepts subdomains of the official hosts only', () => {
    expect(resolveYoutubeTarget('https://m.youtube.com/live/OkQduT-9Pyc').ok).toBe(true);
    expect(resolveYoutubeTarget('https://www.youtube-nocookie.com/embed/OkQduT-9Pyc').ok).toBe(true);
  });

  it('refuses paths that do not identify a video or channel', () => {
    for (const url of [
      'https://www.youtube.com/playlist?list=PL1',
      'https://www.youtube.com/results?search_query=news',
      'https://www.youtube.com/channel',
    ]) {
      const result = resolveYoutubeTarget(url);
      expect(result.ok, url).toBe(false);
    }
  });
});

describe('helpers', () => {
  it('reports only genuine channel live paths', () => {
    expect(isChannelLivePath('https://www.youtube.com/channel/UCOCGPFW1UqPP9zdol7vEK1A/live')).toBe(true);
    expect(isChannelLivePath('https://www.youtube.com/@emisora/live')).toBe(true);
    expect(isChannelLivePath('https://www.youtube.com/live/OkQduT-9Pyc')).toBe(false);
    expect(isChannelLivePath('https://www.youtube.com/channel/UCOCGPFW1UqPP9zdol7vEK1A')).toBe(false);
  });

  it('builds the public pages a human can open', () => {
    expect(youtubeWatchUrl('OkQduT-9Pyc')).toBe('https://www.youtube.com/watch?v=OkQduT-9Pyc');
    expect(youtubeChannelWatchUrl('UCOCGPFW1UqPP9zdol7vEK1A')).toBe(
      'https://www.youtube.com/channel/UCOCGPFW1UqPP9zdol7vEK1A/live',
    );
  });
});
