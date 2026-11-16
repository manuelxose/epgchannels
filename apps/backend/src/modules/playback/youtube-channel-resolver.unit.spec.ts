/**
 * The YouTube channel resolver: the rule that decides what a channel page means.
 *
 * These are unit tests over a fake `fetch`, because the resolver's whole job is
 * to turn an HTTP answer into a definite state. Getting the distinction between
 * "not broadcasting" and "could not tell" wrong is what makes an app claim a
 * channel is offline when it is live.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalOf,
  channelLivePageUrl,
  resolveChannelLiveVideo,
  videoIdFromCanonical,
} from './youtube-channel-resolver.js';

const CHANNEL = 'UCBi2mrWuNuyYy4gbM6fU18Q';

function fetchAnswering(status: number, body: string): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
}

describe('canonicalOf / videoIdFromCanonical', () => {
  it('reads the canonical link and the video id', () => {
    const html = '<head><link rel="canonical" href="https://www.youtube.com/watch?v=q5NLEgG7kmY"></head>';
    expect(canonicalOf(html)).toBe('https://www.youtube.com/watch?v=q5NLEgG7kmY');
    expect(videoIdFromCanonical('https://www.youtube.com/watch?v=q5NLEgG7kmY')).toBe('q5NLEgG7kmY');
  });

  it('accepts /live/ and /embed/ video URLs', () => {
    expect(videoIdFromCanonical('https://www.youtube.com/live/ErraEILevPE')).toBe('ErraEILevPE');
    expect(videoIdFromCanonical('https://www.youtube.com/embed/ErraEILevPE')).toBe('ErraEILevPE');
  });

  it('rejects a canonical that is not a video (the channel page itself)', () => {
    expect(videoIdFromCanonical(`https://www.youtube.com/channel/${CHANNEL}`)).toBeNull();
    expect(videoIdFromCanonical('https://www.youtube.com/@handle')).toBeNull();
  });

  it('rejects video ids of the wrong length or a foreign host', () => {
    expect(videoIdFromCanonical('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(videoIdFromCanonical('https://example.org/watch?v=q5NLEgG7kmY')).toBeNull();
    expect(videoIdFromCanonical('not a url')).toBeNull();
  });

  it('reports no canonical when the markup does not contain one', () => {
    expect(canonicalOf('<html><body>sin enlace</body></html>')).toBeNull();
  });
});

describe('resolveChannelLiveVideo', () => {
  it('reports the live video when the page announces one', async () => {
    const fetchImpl = fetchAnswering(
      200,
      '<link rel="canonical" href="https://www.youtube.com/watch?v=q5NLEgG7kmY">',
    );
    await expect(resolveChannelLiveVideo(CHANNEL, { fetchImpl })).resolves.toEqual({
      kind: 'live',
      videoId: 'q5NLEgG7kmY',
    });
  });

  it('reports offline when YouTube serves the channel page instead of a video', async () => {
    const fetchImpl = fetchAnswering(200, `<link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL}">`);
    await expect(resolveChannelLiveVideo(CHANNEL, { fetchImpl })).resolves.toEqual({ kind: 'offline' });
  });

  it('reports unavailable — never offline — when the page cannot be read', async () => {
    await expect(
      resolveChannelLiveVideo(CHANNEL, { fetchImpl: fetchAnswering(500, 'error') }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'http-500' });
    await expect(
      resolveChannelLiveVideo(CHANNEL, { fetchImpl: fetchAnswering(200, '<html>sin canonical</html>') }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'no-canonical' });
  });

  it('reports unavailable when the network fails', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(resolveChannelLiveVideo(CHANNEL, { fetchImpl })).resolves.toEqual({
      kind: 'unavailable',
      reason: 'network',
    });
  });

  it('refuses a channel id it cannot trust instead of building a URL from it', async () => {
    await expect(resolveChannelLiveVideo('../etc/passwd')).resolves.toEqual({
      kind: 'unavailable',
      reason: 'invalid-channel-id',
    });
  });

  it('builds the official page URL for the explicit link', () => {
    expect(channelLivePageUrl(CHANNEL)).toBe(`https://www.youtube.com/channel/${CHANNEL}/live`);
  });
});
