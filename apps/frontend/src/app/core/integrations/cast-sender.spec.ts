import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEDIA_RECEIVER_APP_ID,
  castMediaFor,
  castSenderBridge,
  resolveCastConfiguration,
  startCastSession,
  type CastBridge,
  type CastMedia,
} from './cast-sender';

/**
 * Professional Cast integration: use Google's SDK when the browser provides it,
 * and say exactly what is missing when it does not. Never invent devices, never
 * hardcode a registered App ID.
 */

const winWith = (cast: unknown) => ({ chrome: { cast } }) as unknown as Window;

describe('castSenderBridge', () => {
  it('is absent when the browser has no Cast component', () => {
    expect(castSenderBridge(undefined)).toBeUndefined();
    expect(castSenderBridge({} as Window)).toBeUndefined();
  });

  it('is absent when the bridge exists but reports itself unavailable', () => {
    expect(castSenderBridge(winWith({ isAvailable: false, initialize: () => undefined }))).toBeUndefined();
  });

  it('is present when the SDK bridge can initialize', () => {
    const bridge: CastBridge = { isAvailable: true, initialize: () => undefined };
    expect(castSenderBridge(winWith(bridge))).toBe(bridge);
  });
});

describe('resolveCastConfiguration', () => {
  it('explains that Chrome needs the Google Cast component', () => {
    const config = resolveCastConfiguration(undefined);
    expect(config.state).toBe('no-bridge');
    expect(config.state === 'no-bridge' && config.reason).toMatch(/Google Cast/i);
  });

  it('uses the deployment App ID when one is configured', () => {
    const config = resolveCastConfiguration(winWith({ initialize: () => undefined }), 'ABC12345');
    expect(config).toEqual({ state: 'ready', appId: 'ABC12345' });
  });

  it('falls back to Google Default Media Receiver, never to an invented id', () => {
    const config = resolveCastConfiguration(winWith({ initialize: () => undefined }), '   ');
    expect(config).toEqual({ state: 'ready', appId: DEFAULT_MEDIA_RECEIVER_APP_ID });
  });
});

describe('castMediaFor', () => {
  it('describes open HLS and DASH streams for the receiver', () => {
    expect(castMediaFor('hls', 'https://cdn/x.m3u8', 'La 1')).toEqual({
      url: 'https://cdn/x.m3u8',
      type: 'application/x-mpegurl',
      title: 'La 1',
      subtitle: undefined,
    });
    expect(castMediaFor('dash', 'https://cdn/x.mpd', 'La 2')?.type).toBe('application/dash+xml');
  });

  it('refuses YouTube and non-media sources', () => {
    expect(castMediaFor('youtube', 'https://www.youtube.com/live/x', 'Canal')).toBeUndefined();
    expect(castMediaFor('iframe', 'https://example.org/e', 'Canal')).toBeUndefined();
    expect(castMediaFor('stream', 'https://example.org/p', 'Canal')).toBeUndefined();
  });
});

describe('startCastSession', () => {
  const media: CastMedia = { url: 'https://cdn/x.m3u8', type: 'application/x-mpegurl', title: 'La 1' };

  it('initializes the SDK then requests a session', async () => {
    const calls: string[] = [];
    const bridge: CastBridge = {
      initialize: (_config, onSuccess) => {
        calls.push('initialize');
        onSuccess?.();
      },
      requestSession: () => calls.push('requestSession'),
    };
    const SessionRequest = class {};
    bridge.SessionRequest = SessionRequest as unknown as CastBridge['SessionRequest'];
    expect(await startCastSession(bridge, 'CC1AD845', media)).toBe(true);
    expect(calls).toEqual(['initialize', 'requestSession']);
  });

  it('reports failure when the SDK cannot initialize', async () => {
    const bridge: CastBridge = {
      initialize: (_config, _done, onError) => onError?.(new Error('blocked')),
    };
    bridge.SessionRequest = class {} as unknown as CastBridge['SessionRequest'];
    expect(await startCastSession(bridge, 'CC1AD845', media)).toBe(false);
  });

  it('reports failure when the SDK has no SessionRequest', async () => {
    expect(await startCastSession({ initialize: () => undefined }, 'CC1AD845', media)).toBe(false);
  });
});
