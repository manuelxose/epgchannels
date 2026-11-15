import { describe, expect, it } from 'vitest';
import { NO_CAPABILITIES, verifiedPlaybackState, verifiedStateLabel, requiresOfficialAccess } from './verified-state';
import type { PlaybackCapabilities } from './verified-state';
import type { Channel, MediaSource } from '../models/catalog.model';

/** A browser that can run hls.js/dash.js, as Chromium does. */
const MEDIA_SOURCE: PlaybackCapabilities = { mediaSource: true, canPlayHls: false, canPlayProgressive: true };
/** Only the element's native codecs: a broken/limited browser. */
const NATIVE_ONLY: PlaybackCapabilities = { mediaSource: false, canPlayHls: false, canPlayProgressive: false };

function source(overrides: Partial<MediaSource> & Pick<MediaSource, 'format' | 'url'>): MediaSource {
  return {
    id: overrides.id ?? 'canal#0',
    label: overrides.label ?? 'Emisión 1',
    geoRestricted: overrides.geoRestricted ?? false,
    ...overrides,
  };
}

function channel(overrides: Partial<Channel> & Pick<Channel, 'sources'>): Channel {
  return {
    id: 'canal',
    name: 'Canal',
    categoryId: 'es:generalistas',
    categoryName: 'Generalistas',
    country: 'España',
    tags: [],
    availability: 'playable',
    ...overrides,
  };
}

const hls = source({ format: 'hls', url: 'https://cdn.example.org/live.m3u8' });
const geoHls = source({ id: 'canal#1', format: 'hls', url: 'https://cdn.example.org/geo.m3u8', geoRestricted: true });
const youtubePage = source({
  id: 'canal#2',
  format: 'youtube',
  url: 'https://www.youtube.com/channel/UCOCGPFW1UqPP9zdol7vEK1A/live',
  label: 'Emisión en YouTube',
  unplayable: true,
  embed: true,
  platformId: 'UCOCGPFW1UqPP9zdol7vEK1A',
});
const youtubeUnembeddable = source({
  id: 'canal#3',
  format: 'youtube',
  url: 'https://www.youtube.com/@emisora/live',
  label: 'Emisión en YouTube',
  unplayable: true,
});
const iframePage = source({
  id: 'canal#4',
  format: 'iframe',
  url: 'https://player.example.org/embed/uno',
  label: 'Emisión del emisor',
  unplayable: true,
});

describe('verifiedPlaybackState — "Ver en directo" only when it can play here', () => {
  it('is live for an eligible HLS source', () => {
    const state = verifiedPlaybackState({
      channel: channel({ sources: [hls] }),
      sources: [hls],
      capabilities: MEDIA_SOURCE,
    });
    expect(state.kind).toBe('live');
    expect(state.label).toBe('Ver en directo');
    expect(state.action).toEqual({ kind: 'in-app' });
  });

  it('is never live for a geo-blocked source, even when everything else looks playable', () => {
    const state = verifiedPlaybackState({
      channel: channel({ sources: [geoHls], webUrl: 'https://emisora.example.org' }),
      sources: [geoHls],
      capabilities: MEDIA_SOURCE,
    });
    expect(state.kind).toBe('official-site');
    expect(state.label).toBe('Disponible en la web oficial');
    expect(state.action).toEqual({ kind: 'external', url: 'https://emisora.example.org' });
    expect(state.blockedSources).toEqual([{ source: geoHls, reason: 'geo' }]);
  });

  it('is never live for a container this browser cannot decode', () => {
    const state = verifiedPlaybackState({
      channel: channel({ sources: [hls], webUrl: 'https://emisora.example.org' }),
      sources: [hls],
      capabilities: NATIVE_ONLY,
    });
    expect(state.kind).toBe('official-site');
    expect(state.blockedSources[0]).toMatchObject({ reason: 'format' });
  });

  it('is never live for a URL that needs client data we refuse to forge', () => {
    const token = source({ format: 'hls', url: 'https://cdn.example.org/p.m3u8?did=[DEVICE_ID]', unplayable: true });
    const state = verifiedPlaybackState({
      channel: channel({ sources: [token], webUrl: 'https://emisora.example.org' }),
      sources: [token],
      capabilities: MEDIA_SOURCE,
    });
    expect(state.kind).toBe('official-site');
    expect(state.blockedSources[0]).toMatchObject({ reason: 'unplayable-url' });
  });

  it('picks the first attemptable source and lists the blocked ones', () => {
    const state = verifiedPlaybackState({
      channel: channel({ sources: [geoHls, hls] }),
      sources: [geoHls, hls],
      capabilities: MEDIA_SOURCE,
    });
    expect(state.kind).toBe('live');
    expect(state.blockedSources.map((entry) => entry.reason)).toEqual(['geo']);
  });
});

describe('verifiedPlaybackState — official routes', () => {
  /*
   * A specific YouTube video is an addressable page: the official IFrame player
   * shows exactly that stream, so these routes use `/live/<id>`.
   */
  const youtubeVideo = source({
    id: 'canal#12',
    format: 'youtube',
    url: 'https://www.youtube.com/live/OkQduT-9Pyc',
    label: 'Emisión en YouTube',
    unplayable: true,
    embed: true,
    platformId: 'OkQduT-9Pyc',
  });

  it('offers the official YouTube IFrame player only for an embeddable official page', () => {
    const state = verifiedPlaybackState({
      channel: channel({ sources: [youtubeVideo], availability: 'external', tags: ['EMB'], webUrl: 'https://emisora.example.org' }),
      sources: [youtubeVideo],
      capabilities: MEDIA_SOURCE,
    });
    expect(state.kind).toBe('official-embed');
    expect(state.action).toEqual({ kind: 'embed', url: youtubeVideo.url, sourceId: youtubeVideo.id });
  });

  it('never embeds a YouTube page it cannot address (no invented channel/video id)', () => {
    const state = verifiedPlaybackState({
      channel: channel({
        sources: [youtubeUnembeddable],
        availability: 'external',
        tags: ['EMB'],
        webUrl: 'https://emisora.example.org',
      }),
      sources: [youtubeUnembeddable],
      capabilities: MEDIA_SOURCE,
    });
    expect(state.kind).toBe('official-site');
    expect(state.action).toEqual({ kind: 'external', url: youtubeUnembeddable.url });
  });

  it('never embeds a geo-restricted YouTube page', () => {
    const state = verifiedPlaybackState({
      channel: channel({ sources: [{ ...youtubePage, geoRestricted: true }], availability: 'external', tags: ['EMB'] }),
      sources: [{ ...youtubePage, geoRestricted: true }],
      capabilities: MEDIA_SOURCE,
    });
    expect(state.kind).not.toBe('official-embed');
  });

  it('prefers the official YouTube embed over a bare emitter page link', () => {
    const state = verifiedPlaybackState({
      channel: channel({
        sources: [iframePage, youtubeVideo],
        availability: 'external',
        tags: ['EMB'],
        webUrl: 'https://emisora.example.org',
      }),
      sources: [iframePage, youtubeVideo],
      capabilities: MEDIA_SOURCE,
    });
    // A page we may embed is more useful than a link out, and it is the official
    // player: the iframe page is only linked from the embed view.
    expect(state.kind).toBe('official-embed');
    expect(state.action).toMatchObject({ kind: 'embed', sourceId: youtubeVideo.id });
  });

  it('requires official access for UAG and REF channels and never claims live', () => {
    for (const tag of ['UAG', 'REF'] as const) {
      const state = verifiedPlaybackState({
        channel: channel({ sources: [geoHls], tags: [tag], webUrl: 'https://emisora.example.org' }),
        sources: [geoHls],
        capabilities: MEDIA_SOURCE,
      });
      expect(state.kind, tag).toBe('requires-official');
      expect(state.label).toBe('Requiere acceso oficial');
    }
    expect(requiresOfficialAccess(['UAG'])).toBe(true);
    expect(requiresOfficialAccess(['REF', 'GEO'])).toBe(true);
    expect(requiresOfficialAccess(['EMB', 'EVT'])).toBe(false);
  });

  /*
   * Regression (TDT-CLONE-10 §3): the catalogue publishes numbered variants
   * (REFI1, REFC1, UAGB). Only the bare 'REF'/'UAG' spellings used to count, so
   * the numbered channels were dropped into a generic bucket with no
   * explanation.
   */
  it('recognises every published access-restriction variant, not just the bare tag', () => {
    for (const tag of ['REFI1', 'REFC1', 'REFC2', 'UAG', 'UAGB'] as const) {
      expect(requiresOfficialAccess([tag]), tag).toBe(true);
      const state = verifiedPlaybackState({
        channel: channel({ sources: [geoHls], tags: [tag], webUrl: 'https://emisora.example.org' }),
        sources: [geoHls],
        capabilities: MEDIA_SOURCE,
      });
      expect(state.kind, tag).toBe('requires-official');
    }
    // Unrelated tags stay unaffected.
    expect(requiresOfficialAccess(['EXTA', 'EXTB', 'EMB', 'NOEM', 'REG'])).toBe(false);
  });

  /*
   * Regression (TDT-CLONE-10 §3): NONAV means "no navigation" — the link is not
   * a page a browser should open, not an access restriction. Treating it as one
   * refused Noroeste TV, whose NONAV stream is public, CORS-enabled and plays.
   */
  it('does not treat NONAV as an access restriction', () => {
    expect(requiresOfficialAccess(['NONAV', 'REFC1'])).toBe(true);
    expect(requiresOfficialAccess(['NONAV'])).toBe(false);
    const playable = source({ id: 'canal#13', format: 'hls', url: 'https://cdn.example.org/open.m3u8' });
    const state = verifiedPlaybackState({
      channel: channel({ sources: [playable], tags: ['NONAV'], webUrl: 'https://emisora.example.org' }),
      sources: [playable],
      capabilities: MEDIA_SOURCE,
    });
    expect(state.kind).toBe('live');
  });

  /*
   * Regression (TDT-CLONE-10 §3): the access restriction used to be checked
   * AFTER the "a source exists and the browser can play it" branch, so a
   * channel whose URL merely *looked* playable was labelled `live`. ETB
   * Deportes carries REF and its first source answered 403, yet the app
   * claimed "Ver en directo" and mounted a dead player.
   */
  it('an access-restricted channel is never live, even when its URL looks playable', () => {
    const playableHls = source({ id: 'canal#7', format: 'hls', url: 'https://cdn.example.org/open.m3u8' });
    const state = verifiedPlaybackState({
      channel: channel({ sources: [playableHls], tags: ['EVT', 'REF'], webUrl: 'https://emisora.example.org' }),
      sources: [playableHls],
      capabilities: MEDIA_SOURCE,
    });
    expect(state.kind).toBe('requires-official');
    expect(state.action).toMatchObject({ kind: 'external' });
  });

  /*
   * Regression (TDT-CLONE-10 §4): a channel publishing only a YouTube page has
   * no engine-eligible source, but the catalogue still labels it `playable`
   * because the YouTube option exists. Requiring `external`/`unavailable` for
   * the embed made every such channel fall back to a plain link instead of
   * YouTube's official player.
   */
  it('embeds an addressable YouTube page even when the catalogue calls the channel playable', () => {
    const state = verifiedPlaybackState({
      channel: channel({ sources: [youtubeVideo], availability: 'playable', tags: ['EMB'], webUrl: 'https://emisora.example.org' }),
      sources: [youtubeVideo],
      capabilities: MEDIA_SOURCE,
    });
    expect(state.kind).toBe('official-embed');
    expect(state.action).toMatchObject({ kind: 'embed', sourceId: youtubeVideo.id });
  });

  /*
   * A YouTube channel page is not an in-app media stream: it names a channel,
   * and the IFrame player can only show it by asking YouTube for the channel's
   * live video. Since TDT-CLONE-12 a channel page is played INSIDE our player
   * (resolved through the documented Data API, then driven by the official
   * YT.Player), so it is an official embed — never `live` and never a silent
   * external redirect. A page we cannot embed keeps the plain link.
   */
  it('a channel page is an official embed, never an in-app stream', () => {
    const state = verifiedPlaybackState({
      channel: channel({ sources: [youtubePage], tags: ['EMB'], webUrl: 'https://emisora.example.org' }),
      sources: [youtubePage],
      capabilities: MEDIA_SOURCE,
    });
    expect(state.kind).toBe('official-embed');
    expect(state.action).toMatchObject({ kind: 'embed' });
    // A page without a verifiable identifier (a handle) stays a link.
    const handle = verifiedPlaybackState({
      channel: channel({ sources: [youtubeUnembeddable], tags: ['EMB'], webUrl: 'https://emisora.example.org' }),
      sources: [youtubeUnembeddable],
      capabilities: MEDIA_SOURCE,
    });
    expect(handle.kind).not.toBe('official-embed');
  });

  /*
   * The access-restriction rule still outranks a page we cannot embed: a
   * restricted channel whose only official route is an unaddressable YouTube
   * page keeps `requires-official` and is never claimed as embeddable.
   */
  it('a restricted channel keeps its restriction when the YouTube page is unaddressable', () => {
    const state = verifiedPlaybackState({
      channel: channel({ sources: [youtubeUnembeddable], tags: ['UAG', 'REFI1'], webUrl: 'https://emisora.example.org' }),
      sources: [youtubeUnembeddable],
      capabilities: MEDIA_SOURCE,
    });
    expect(state.kind).toBe('requires-official');
    expect(state.action).toMatchObject({ kind: 'external', url: youtubeUnembeddable.url });
  });

  it('prefers an in-app stream over an embed when both are published', () => {
    const playableHls = source({ id: 'canal#8', format: 'hls', url: 'https://cdn.example.org/live.m3u8' });
    const state = verifiedPlaybackState({
      channel: channel({ sources: [playableHls, youtubePage], tags: ['EMB'] }),
      sources: [playableHls, youtubePage],
      capabilities: MEDIA_SOURCE,
    });
    expect(state.kind).toBe('live');
  });

  /*
   * Regression (TDT-CLONE-10 §3): our player cannot play a YouTube page — it
   * only ever gets its own engine, and YouTube pages are marked unplayable.
   * The watch page briefly reported them as an "in-app stream" (it filtered
   * sources with `isEligibleSource`, which keeps youtube) and labelled
   * restricted channels like 101TV Málaga "live". A YouTube page must never
   * make a channel live.
   */
  it('a YouTube page alone never makes a channel live', () => {
    for (const url of ['https://www.youtube.com/channel/UCJzt0XyxSwpsNODokzG4iRw/live', 'https://www.youtube.com/live/OkQduT-9Pyc']) {
      const page_ = source({ id: 'canal#10', format: 'youtube', url, embed: true, unplayable: true });
      const state = verifiedPlaybackState({
        channel: channel({ sources: [page_], tags: ['EMB'], webUrl: 'https://emisora.example.org' }),
        sources: [page_],
        capabilities: MEDIA_SOURCE,
      });
      expect(state.kind, url).not.toBe('live');
    }
  });

  it('reports an eventual emission for EVT and guide-only channels', () => {
    const evt = verifiedPlaybackState({
      channel: channel({ sources: [], tags: ['EVT'], availability: 'unavailable', webUrl: 'https://emisora.example.org' }),
      sources: [],
      capabilities: MEDIA_SOURCE,
    });
    expect(evt.kind).toBe('eventual');
    expect(evt.label).toBe('Emisión eventual');

    const guideOnly = verifiedPlaybackState({
      channel: channel({ sources: [], tags: ['NOEM'], availability: 'no-emission' }),
      sources: [],
      capabilities: MEDIA_SOURCE,
    });
    expect(guideOnly.kind).toBe('eventual');
  });

  it('reports unavailable when the catalog offers nothing usable', () => {
    const state = verifiedPlaybackState({
      channel: channel({ sources: [], availability: 'unavailable' }),
      sources: [],
      capabilities: MEDIA_SOURCE,
    });
    expect(state.kind).toBe('unavailable');
    expect(state.label).toBe('No disponible actualmente');
    expect(state.action).toBeUndefined();
  });
});

describe('verifiedStateLabel', () => {
  it('uses exactly the five labels of the specification', () => {
    expect(
      ['live', 'official-site', 'eventual', 'unavailable', 'requires-official'].map((kind) =>
        verifiedStateLabel(kind as never),
      ),
    ).toEqual([
      'Ver en directo',
      'Disponible en la web oficial',
      'Emisión eventual',
      'No disponible actualmente',
      'Requiere acceso oficial',
    ]);
  });

  it('has no capability-free default that could claim playback', () => {
    expect(NO_CAPABILITIES.mediaSource).toBe(false);
  });
});
