/**
 * Provenance pipeline — contract-shaped candidates with a complete audit chain.
 *
 * Every assertion here maps to a hard rule of MODULE-CONTRACT-02B: nothing
 * silent (§0.6), no secrets in payloads (§0.7), staging is private (§0.4), and
 * flags must be conservative (a false negative would publish a geo-blocked or
 * credential-bearing URL).
 */
import { describe, expect, it } from 'vitest';
import { parseM3u } from './m3u.js';
import { M3U_EXCERPT } from './m3u.fixture.js';
import { FREE_TV_ENTRIES_PLAYLIST } from './free-tv.fixture.js';
import {
  buildCandidates,
  cleanDisplayName,
  countryFromPath,
  countryFromPlaylistName,
  countryFromTvgId,
  detectStreamType,
  inferQuality,
  isPublishableShape,
  looksMangled,
  normalizeLanguage,
  normalizeUrl,
  uuidV5,
  type SourceSnapshotDoc,
} from './provenance.js';
import type { LoadedPlaylist } from './snapshot.js';

const RETRIEVED_AT = new Date('2026-11-16T14:53:23.231Z');

function snapshot(overrides: Partial<SourceSnapshotDoc> = {}): SourceSnapshotDoc {
  return {
    _id: 'a'.repeat(64),
    upstream: 'iptv-org',
    upstreamUrl: 'https://github.com/iptv-org/iptv',
    commitSha: '61b5e2ace91b35262d830e60cd266a9df64e3b1e',
    retrievedAt: RETRIEVED_AT,
    checksumSha256: 'a'.repeat(64),
    licence: { spdx: 'Unlicense', url: null, reuse: 'public-domain', notes: '' },
    format: 'm3u',
    fileCount: 1,
    entryCount: 0,
    bytes: 0,
    status: 'ingested',
    rejectionReason: null,
    createdAt: RETRIEVED_AT,
    ...overrides,
  };
}

function loaded(text: string, path = 'streams/es.m3u', sha = 'b'.repeat(64)): LoadedPlaylist {
  return { path, sha256: sha, bytes: text.length, playlist: parseM3u(new TextEncoder().encode(text)) };
}

const one = (text: string, path?: string) => buildCandidates(snapshot(), [loaded(text, path)]);

describe('normalizeUrl', () => {
  it('lowercases the host, drops the default port and keeps path plus meaningful query', () => {
    const result = normalizeUrl('HTTPS://CDN.Example.ORG:443/live/Channel/Playlist.m3u8?lang=es&quality=720');
    expect(result.normalized).toBe('https://cdn.example.org/live/Channel/Playlist.m3u8?lang=es&quality=720');
    expect(result.authRequired).toBe(false);
  });

  it('drops tracking parameters and keeps other parameters in order', () => {
    const result = normalizeUrl('https://live.example/watch?utm_source=x&id=42&fbclid=z&Ref=newsletter');
    expect(result.normalized).toBe('https://live.example/watch?id=42');
  });

  it('flags and removes userinfo', () => {
    const result = normalizeUrl('https://user:secret@cdn.example/x.m3u8');
    expect(result.authRequired).toBe(true);
    expect(result.credentialsStripped).toBe(true);
    expect(result.normalized).toBe('https://cdn.example/x.m3u8');
  });

  it('flags token-like query parameters and removes their values', () => {
    for (const param of ['token', 'access_token', 'apikey', 'api_key', 'sig', 'signature', 'password', 'wmsauthsign', 'hdnts']) {
      const result = normalizeUrl(`https://cdn.example/live.m3u8?${param}=deadbeef&t=1`);
      expect(result.authRequired, param).toBe(true);
      expect(result.normalized).not.toContain('deadbeef');
      expect(result.normalized).not.toContain(`${param}=`);
      expect(result.normalized).toContain('t=1');
    }
  });

  it('treats a lone weak `key` parameter as a credential and drops it', () => {
    const alone = normalizeUrl('https://cdn.example/live.m3u8?key=deadbeef');
    expect(alone.authRequired).toBe(true);
    expect(alone.normalized).toBe('https://cdn.example/live.m3u8');
    const beside = normalizeUrl('https://cdn.example/live.m3u8?key=demo&lang=es');
    expect(beside.normalized).toBe('https://cdn.example/live.m3u8?lang=es');
  });

  it('keeps non-default ports and non-http URLs verbatim', () => {
    expect(normalizeUrl('https://cdn.example:8443/x.m3u8').normalized).toBe('https://cdn.example:8443/x.m3u8');
    expect(normalizeUrl('rtsp://185.50.56.16:554/live').normalized).toBe('rtsp://185.50.56.16:554/live');
    expect(normalizeUrl('not a url').normalized).toBe('not a url');
  });

  it('is idempotent', () => {
    const once = normalizeUrl('HTTPS://A.Example:443/x/?utm_source=y').normalized;
    expect(normalizeUrl(once).normalized).toBe(once);
  });
});

describe('detectStreamType', () => {
  it('detects hls, dash, youtube, official-embed and external', () => {
    expect(detectStreamType('https://cdn.example/live/master.m3u8')).toBe('hls');
    expect(detectStreamType('https://cdn.example/live/index.M3U8?x=1')).toBe('hls');
    expect(detectStreamType('https://cdn.example/live/manifest.mpd')).toBe('dash');
    expect(detectStreamType('https://www.youtube.com/watch?v=abc')).toBe('youtube');
    expect(detectStreamType('https://youtu.be/abc')).toBe('youtube');
    expect(detectStreamType('https://emitter.example/EmbedPlayer/player.php?id=1')).toBe('official-embed');
    expect(detectStreamType('https://media.example/embed/live/1')).toBe('official-embed');
    expect(detectStreamType('https://origin.example/live/index')).toBe('external');
    expect(detectStreamType('rtsp://1.2.3.4:554/live')).toBe('external');
    expect(detectStreamType('garbage')).toBe('external');
  });
});

describe('country, language and quality inference', () => {
  it('reads the country from an iptv-org tvg-id suffix', () => {
    expect(countryFromTvgId('3CatCameresdeltemps.es@SD')).toBe('ES');
    expect(countryFromTvgId('Kanali7.al')).toBe('AL');
    expect(countryFromTvgId('NoSuffix')).toBeNull();
    expect(countryFromTvgId(null)).toBeNull();
  });

  it('reads the country from a file name', () => {
    expect(countryFromPath('streams/es.m3u')).toBe('ES');
    expect(countryFromPath('streams/es_telecinco.m3u')).toBe('ES');
    expect(countryFromPath('streams/zz.m3u')).toBeNull();
    expect(countryFromPlaylistName('playlists/playlist_spain.m3u8')).toBe('ES');
    expect(countryFromPlaylistName('playlists/playlist_united_kingdom.m3u8')).toBe('GB');
    expect(countryFromPlaylistName('playlist.m3u8')).toBeNull();
  });

  it('normalises language tags', () => {
    expect(normalizeLanguage('es')).toBe('es');
    expect(normalizeLanguage('es-ES')).toBe('es');
    expect(normalizeLanguage('Spanish')).toBeNull();
    expect(normalizeLanguage('spa')).toBe('es');
    expect(normalizeLanguage('')).toBeNull();
  });

  it('infers the maximum advertised quality and the decoration span', () => {
    expect(inferQuality('Channel (1080p)')).toMatchObject({ quality: 'FHD' });
    expect(inferQuality('Channel (576p)')).toMatchObject({ quality: 'SD' });
    expect(inferQuality('Channel (720p)')).toMatchObject({ quality: 'HD' });
    expect(inferQuality('Channel 4K')).toMatchObject({ quality: 'UHD' });
    expect(inferQuality('Channel (2160p)')).toMatchObject({ quality: 'UHD' });
    expect(inferQuality('Channel')).toBeNull();
    expect(inferQuality('A (576p)', 'A (1080p)')).toMatchObject({ quality: 'FHD' });
  });

  it('cleans decorations without touching the rest of the name', () => {
    expect(cleanDisplayName('3Cat Exclusiu 1 (1080p) [Geo-blocked]')).toBe('3Cat Exclusiu 1');
    expect(cleanDisplayName('Canal Sur (576p)')).toBe('Canal Sur');
    expect(cleanDisplayName('[Geo-blocked]')).toBe('[Geo-blocked]');
    expect(cleanDisplayName('Càmeres del temps')).toBe('Càmeres del temps');
  });

  it('recognises mangled names', () => {
    expect(looksMangled('C\uFFFDMeres')).toBe(true);
    // Upstream mangling turns an accented head into ASCII: `Càmeres` → `C?meres`.
    expect(looksMangled('Canales C\u00e0meres?')).toBe(true);
    expect(looksMangled('Caf\u00e9')).toBe(false);
    // A `?` right after a plain letter is ambiguous (`Caf?`, `Canal Sur?`): we
    // document the conservative reading instead of guessing punctuation.
    expect(looksMangled('Caf\u003f')).toBe(true);
    expect(looksMangled('\u00bfQu\u00e9 pasa\u003f')).toBe(true);
    expect(looksMangled('C\u00e0meres')).toBe(false);
    expect(looksMangled('')).toBe(false);
    expect(looksMangled('Canal 5:30')).toBe(false);
  });
});

describe('buildCandidates — provenance and shape', () => {
  it('emits one contract-shaped candidate per entry with full provenance', () => {
    const candidates = buildCandidates(snapshot(), [loaded(M3U_EXCERPT, 'streams/es.m3u', 'c'.repeat(64))]);
    const first = candidates[0];
    expect(first).toBeDefined();
    expect(Object.keys(first ?? {}).sort()).toEqual(
      [
        '_id', 'attributes', 'channelId', 'country', 'createdAt', 'duplicateOf', 'flags', 'groupTitle', 'language',
        'name', 'normalizedUrl', 'provenance', 'provider', 'quality', 'rejectionReason', 'snapshotId', 'state', 'type',
        'upstream', 'updatedAt', 'url', 'urlSha256',
      ].sort(),
    );
    expect(first).toMatchObject({
      channelId: null,
      snapshotId: snapshot()._id,
      upstream: 'iptv-org',
      type: 'hls',
      name: '3Cat Càmeres del temps',
      quality: 'FHD',
      country: 'ES',
      language: null,
      provider: '3CatCameresdeltemps',
      state: 'staging',
      rejectionReason: null,
      duplicateOf: null,
    });
    expect(first?.provenance).toEqual({
      snapshotId: snapshot()._id,
      upstream: 'iptv-org',
      upstreamPath: 'streams/es.m3u',
      line: 2,
      rawName: '3Cat Càmeres del temps (1080p)',
      rawAttributes: { 'tvg-id': '3CatCameresdeltemps.es@SD' },
      retrievedAt: RETRIEVED_AT,
      checksumSha256: 'c'.repeat(64),
    });
    expect(first?.urlSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first?.createdAt).toEqual(RETRIEVED_AT);
  });

  it('gives every candidate a deterministic uuid and the same inputs give the same output', () => {
    const a = buildCandidates(snapshot(), [loaded(M3U_EXCERPT)]);
    const b = buildCandidates(snapshot(), [loaded(M3U_EXCERPT)]);
    expect(a).toEqual(b);
    expect(a[0]?._id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Two sources for the same channel get *different* candidate ids.
    expect(a[1]?._id).not.toBe(a[2]?._id);
    expect(uuidV5('x')).toBe(uuidV5('x'));
    expect(uuidV5('x')).not.toBe(uuidV5('y'));
  });

  it('keeps unknown attributes verbatim', () => {
    const [candidate] = one('#EXTM3U\n#EXTINF:-1 tvg-id="x.es" Custom-Key="v" radio="true",X\nhttps://a.example/x.m3u8\n');
    expect(candidate?.attributes).toEqual({ 'tvg-id': 'x.es', 'Custom-Key': 'v', radio: 'true' });
    expect(candidate?.provenance.rawAttributes).toEqual({ 'tvg-id': 'x.es', 'Custom-Key': 'v', radio: 'true' });
  });

  it('accounts for every line: rejected entries stay candidates in state rejected', () => {
    const candidates = buildCandidates(snapshot(), [loaded(FREE_TV_ENTRIES_PLAYLIST, 'playlist.m3u8')]);
    expect(candidates).toHaveLength(3);
    expect(candidates.map((candidate) => candidate.state)).toEqual(['staging', 'rejected', 'rejected']);
    expect(candidates.map((candidate) => candidate.rejectionReason)).toEqual([null, 'placeholder', 'not-http']);
    expect(candidates[1]?.rejectionReason).toBe('placeholder');
    expect(candidates[1]?.name).toBe('Kanal D Drama');
    expect(candidates[2]?.flags).toContain('unsupported-scheme');
    expect(candidates.every((candidate) => candidate.provenance.line > 0)).toBe(true);
  });
});

describe('buildCandidates — flags', () => {
  it('marks geo-blocked from the name decoration', () => {
    const [, geo] = buildCandidates(snapshot(), [loaded(M3U_EXCERPT)]);
    expect(geo?.flags).toContain('geo-blocked');
    expect(geo?.name).toBe('3Cat Exclusiu 1');
  });

  it('marks refererRequired and userAgentRequired from #EXTVLCOPT', () => {
    const candidates = buildCandidates(snapshot(), [loaded(M3U_EXCERPT)]);
    const referer = candidates.find((candidate) => candidate.name.startsWith('12TV'));
    expect(referer?.flags).toContain('refererRequired');
    expect(referer?.flags).not.toContain('userAgentRequired');
    const agent = candidates.find((candidate) => candidate.name.startsWith('Canal Demo'));
    expect(agent?.flags).toContain('userAgentRequired');
    // Directive values are never persisted on the candidate.
    expect(JSON.stringify(agent)).not.toContain('Mozilla');
    expect(JSON.stringify(candidates)).not.toContain('Mozilla');
  });

  it('marks authRequired and strips credentials from URL fields', () => {
    const [candidate] = one('#EXTM3U\n#EXTINF:-1,Secret\nhttps://user:pass@cdn.example/live.m3u8?token=deadbeef&lang=es\n');
    expect(candidate?.flags).toContain('authRequired');
    expect(candidate?.url).toBe('https://cdn.example/live.m3u8?lang=es');
    expect(candidate?.normalizedUrl).toBe('https://cdn.example/live.m3u8?lang=es');
    expect(JSON.stringify(candidate)).not.toContain('deadbeef');
    expect(JSON.stringify(candidate)).not.toContain('pass@');
  });

  it('leaves a plain public stream unflagged and publishable in shape', () => {
    const [candidate] = one('#EXTM3U\n#EXTINF:-1,Plain\nhttps://cdn.example/plain.m3u8\n');
    expect(candidate?.flags).toEqual([]);
    expect(candidate !== undefined && isPublishableShape(candidate)).toBe(true);
    expect(candidate !== undefined && candidate.state === 'staging' && isPublishableShape({ ...candidate, state: 'rejected' })).toBe(false);
  });
});

describe('buildCandidates — country, language, provider and group', () => {
  it('prefers tvg-country, then tvg-id, then group-title, then the file name', () => {
    const candidates = buildCandidates(snapshot(), [
      loaded(
        [
          '#EXTM3U',
          '#EXTINF:-1 tvg-country="Spain" group-title="Albania",A',
          'https://a.example/1.m3u8',
          '#EXTINF:-1 tvg-id="B.al" group-title="Albania",B',
          'https://a.example/2.m3u8',
          '#EXTINF:-1 group-title="France",C',
          'https://a.example/3.m3u8',
          '#EXTINF:-1,D',
          'https://a.example/4.m3u8',
        ].join('\n'),
        'streams/de.m3u',
      ),
    ]);
    expect(candidates.map((candidate) => candidate.country)).toEqual(['ES', 'AL', 'FR', 'DE']);
    expect(candidates.map((candidate) => candidate.groupTitle)).toEqual(['Albania', 'Albania', 'France', null]);
  });

  it('uses the free-tv country name in the file name', () => {
    const candidates = buildCandidates(snapshot({ upstream: 'free-tv' }), [
      loaded('#EXTM3U\n#EXTINF:-1 tvg-name="X",X\nhttps://a.example/x.m3u8\n', 'playlists/playlist_spain.m3u8'),
    ]);
    expect(candidates[0]?.country).toBe('ES');
    expect(candidates[0]?.provider).toBe('a.example');
    expect(candidates[0]?.upstream).toBe('free-tv');
  });

  it('infers language only from an explicit attribute and falls back to the emitter host', () => {
    const [explicit] = one('#EXTM3U\n#EXTINF:-1 tvg-language="spa",L\nhttps://a.example/x.m3u8\n');
    expect(explicit?.language).toBe('es');
    const [hostOnly] = one('#EXTM3U\n#EXTINF:-1,H\nhttps://www.Emitter.Example/x.m3u8\n');
    expect(hostOnly?.language).toBeNull();
    expect(hostOnly?.provider).toBe('emitter.example');
  });
});
