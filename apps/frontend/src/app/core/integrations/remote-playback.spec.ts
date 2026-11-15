import { describe, expect, it } from 'vitest';
import {
  castBridgeOf,
  readBrowserRemoteSurfaces,
  remotePlaybackCapabilities,
  showAirPlayPicker,
  startRemotePlayback,
  type CastBridge,
} from './remote-playback';

/**
 * "Enviar a un dispositivo" uses the BROWSER's device discovery, never a list of
 * our own. This pins which surfaces are read, in which order they are offered,
 * and that a cross-origin player (YouTube) is never handed over.
 */
describe('remotePlaybackCapabilities', () => {
  it('offers the browser Cast picker when the Media Router bridge exists', () => {
    const capabilities = remotePlaybackCapabilities(
      { hasCastBridge: true, hasRemotePlayback: true, hasAirPlayPicker: false },
      true,
    );
    // The bridge already lists real devices; the standard API is the fallback.
    expect(capabilities.routes).toEqual(['cast', 'remote-playback']);
    expect(capabilities.canCastOwnMedia).toBe(true);
  });

  it('offers Remote Playback and AirPlay where the browser exposes them', () => {
    expect(
      remotePlaybackCapabilities({ hasCastBridge: false, hasRemotePlayback: true, hasAirPlayPicker: true }, true)
        .routes,
    ).toEqual(['remote-playback', 'airplay']);
  });

  it('offers nothing when the browser offers nothing (no invented device list)', () => {
    const none = remotePlaybackCapabilities(
      { hasCastBridge: false, hasRemotePlayback: false, hasAirPlayPicker: false },
      true,
    );
    expect(none.routes).toEqual([]);
    expect(none.canCastOwnMedia).toBe(false);
  });

  it('never claims it can send a player it does not own (YouTube, cross-origin)', () => {
    const capabilities = remotePlaybackCapabilities(
      { hasCastBridge: true, hasRemotePlayback: true, hasAirPlayPicker: true },
      false,
    );
    // The browser picker may still exist, but our media is not handable over.
    expect(capabilities.canCastOwnMedia).toBe(false);
    expect(capabilities.routes).not.toContain('remote-playback');
    expect(capabilities.routes).not.toContain('airplay');
  });
});

describe('surface detection', () => {
  it('reports no surfaces without a window (server/SSR)', () => {
    expect(readBrowserRemoteSurfaces(undefined, null)).toEqual({
      hasRemotePlayback: false,
      hasAirPlayPicker: false,
    });
    expect(castBridgeOf(undefined)).toBeUndefined();
  });

  it('treats an explicit unavailable bridge as absent', () => {
    const win = { chrome: { cast: { isAvailable: false } } } as unknown as Window;
    expect(castBridgeOf(win)).toBeUndefined();
  });

  it('reads the remote surfaces of a media element', () => {
    const media = Object.create(HTMLMediaElement.prototype) as HTMLMediaElement;
    Object.defineProperty(media, 'remotePlayback', { value: { prompt: () => Promise.resolve() } });
    const surfaces = readBrowserRemoteSurfaces({} as Window, media);
    expect(surfaces.hasRemotePlayback).toBe(true);
  });
});

describe('invoking the browser pickers', () => {
  it('opens AirPlay only when the browser provides the picker', () => {
    const withoutPicker = Object.create(HTMLMediaElement.prototype) as HTMLMediaElement;
    expect(showAirPlayPicker(withoutPicker)).toBe(false);

    let called = 0;
    const withPicker = Object.create(HTMLMediaElement.prototype) as HTMLMediaElement & {
      webkitShowPlaybackTargetPicker?: () => void;
    };
    withPicker.webkitShowPlaybackTargetPicker = () => {
      called += 1;
    };
    expect(showAirPlayPicker(withPicker)).toBe(true);
    expect(called).toBe(1);
  });

  it('asks the standard Remote Playback API to prompt, and reports refusal', async () => {
    const element = Object.create(HTMLMediaElement.prototype) as HTMLMediaElement & {
      remotePlayback?: { prompt?: () => Promise<void> };
    };
    expect(await startRemotePlayback(element)).toBe(false);

    let prompted = 0;
    element.remotePlayback = {
      prompt: () => {
        prompted += 1;
        return Promise.reject(new Error('NotAllowedError'));
      },
    };
    // The browser refused (no device / no permission): the caller decides, it is
    // not swallowed into a false success.
    await expect(startRemotePlayback(element)).rejects.toThrow(/NotAllowed/);
    expect(prompted).toBe(1);

    element.remotePlayback = {
      prompt: () => {
        prompted += 1;
        return Promise.resolve();
      },
    };
    expect(await startRemotePlayback(element)).toBe(true);
  });

  it('exposes the Cast bridge with its own methods', () => {
    const bridge: CastBridge = { requestSession: () => undefined };
    const win = { chrome: { cast: bridge } } as unknown as Window;
    expect(castBridgeOf(win)).toBe(bridge);
  });
});
