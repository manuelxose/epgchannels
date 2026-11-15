import { describe, expect, it } from 'vitest';
import { castableSource, decodeSessionPayload, encodeSessionPayload, sessionLink } from './remote-playback';

/**
 * Sending a channel to another screen on the network.
 *
 * There is no server and no account: the link carries only which channel to open,
 * and the receiving device runs this same application. These tests pin what may
 * and may not be sent, and that a malformed link can never be trusted.
 */
describe('castableSource', () => {
  it('can hand a device the open HLS and DASH streams', () => {
    expect(castableSource('hls', 'https://cdn.example.org/live.m3u8')).toEqual({
      kind: 'link',
      url: 'https://cdn.example.org/live.m3u8',
      mime: 'application/vnd.apple.mpegurl',
    });
    expect(castableSource('dash', 'https://cdn.example.org/live.mpd').kind).toBe('link');
  });

  it('never sends a YouTube emission to another device', () => {
    const result = castableSource('youtube', 'https://www.youtube.com/live/OkQduT-9Pyc');
    expect(result.kind).toBe('unsupported');
    expect(result.kind === 'unsupported' && result.reason).toMatch(/YouTube/i);
  });

  it('never sends an emission that only exists inside the emitter page', () => {
    expect(castableSource('iframe', 'https://example.org/embed').kind).toBe('unsupported');
    expect(castableSource('stream', 'https://example.org/player/abc').kind).toBe('unsupported');
  });
});

describe('session link', () => {
  const payload = {
    v: 1 as const,
    channel: { id: 'la-1', name: 'La 1' },
    appUrl: 'http://192.168.1.10:4200/television',
  };

  it('round-trips the channel through the link', () => {
    const link = sessionLink(payload.appUrl, payload);
    expect(link.startsWith('http://192.168.1.10:4200/television#/cast/')).toBe(true);
    const token = link.split('#/cast/')[1];
    expect(decodeSessionPayload(token)).toMatchObject({ channel: { id: 'la-1', name: 'La 1' } });
  });

  it('is URL-safe and survives non-ASCII channel names', () => {
    const token = encodeSessionPayload({ ...payload, channel: { id: 'canal-24h', name: 'Canal 24h · Señal' } });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeSessionPayload(token)?.channel.name).toBe('Canal 24h · Señal');
  });

  it('rejects anything that is not a well-formed hand-over', () => {
    for (const bad of ['', 'not-base64!!', btoa('{"v":2}'), btoa('{"v":1}'), btoa('["la-1"]')]) {
      expect(decodeSessionPayload(bad), bad).toBeUndefined();
    }
  });

  it('replaces an existing fragment instead of nesting links', () => {
    const link = sessionLink('http://host/television#/cast/old', payload);
    expect(link.split('#').length).toBe(2);
  });
});
