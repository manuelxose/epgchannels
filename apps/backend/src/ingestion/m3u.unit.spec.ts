/**
 * M3U/M3U8 parser — adversarial unit tests.
 *
 * The parser is the first boundary between a community-maintained playlist and
 * our store, so every test tries to make it throw, lose a line silently or
 * store something unbounded (the Free-TV `x-tvg-url` header is tens of KB).
 */
import { describe, expect, it } from 'vitest';
import { decodePlaylistBytes, MAX_ATTRIBUTE_VALUE_CHARS, MAX_RAW_BOUND_BYTES, parseM3u } from './m3u.js';
import { M3U_EXCERPT } from './m3u.fixture.js';
import { FREE_TV_ENTRIES_PLAYLIST, FREE_TV_HEADER_PLAYLIST } from './free-tv.fixture.js';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function utf16(text: string, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = littleEndian ? 0xff : 0xfe;
  bytes[1] = littleEndian ? 0xfe : 0xff;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    bytes[2 + i * 2 + (littleEndian ? 0 : 1)] = code & 0xff;
    bytes[2 + i * 2 + (littleEndian ? 1 : 0)] = code >> 8;
  }
  return bytes;
}

describe('decodePlaylistBytes', () => {
  it('decodes UTF-8 with and without BOM', () => {
    expect(decodePlaylistBytes(utf8('#EXTM3U\n'))).toEqual({ text: '#EXTM3U\n', encoding: 'utf-8' });
    const withBom = decodePlaylistBytes(utf8('\uFEFF#EXTM3U\n'));
    expect(withBom.encoding).toBe('utf-8-bom');
    expect(withBom.text).toBe('#EXTM3U\n');
  });

  it('decodes UTF-16LE and UTF-16BE BOMs', () => {
    const le = decodePlaylistBytes(utf16('Càmeres es.m3u', true));
    expect(le.encoding).toBe('utf-16le');
    expect(le.text).toBe('Càmeres es.m3u');
    const be = decodePlaylistBytes(utf16('Càmeres es.m3u', false));
    expect(be.encoding).toBe('utf-16be');
    expect(be.text).toBe('Càmeres es.m3u');
  });

  it('decodes BOM-less UTF-16 from its NUL pattern', () => {
    const bytes = utf16('A#EXTM3U', true).subarray(2);
    const decoded = decodePlaylistBytes(bytes);
    expect(decoded.encoding).toBe('utf-16le');
    expect(decoded.text).toBe('A#EXTM3U');
  });

  it('falls back to windows-1252 for invalid UTF-8 high bytes', () => {
    // `C\xE0meres` is `Càmeres` in windows-1252 and invalid UTF-8.
    const bytes = new Uint8Array([0x43, 0xe0, 0x6d, 0x65, 0x72, 0x65, 0x73]);
    const decoded = decodePlaylistBytes(bytes);
    expect(decoded.encoding).toBe('windows-1252');
    expect(decoded.text).toBe('Càmeres');
  });

  it('normalises CRLF to LF and strips a stray middle BOM', () => {
    expect(decodePlaylistBytes(utf8('a\r\nb\r\n')).text).toBe('a\nb\n');
    expect(decodePlaylistBytes(utf8('a\n\uFEFFb')).text).toBe('a\nb');
  });

  it('never throws on empty or binary input', () => {
    expect(decodePlaylistBytes(new Uint8Array())).toEqual({ text: '', encoding: 'utf-8' });
    const binary = new Uint8Array(1024);
    for (let i = 0; i < binary.length; i += 1) binary[i] = (i * 37) % 256;
    expect(() => decodePlaylistBytes(binary)).not.toThrow();
  });
});

describe('parseM3u — real upstream shapes', () => {
  it('parses the iptv-org excerpt with attributes, quality, geo flag and duplicates', () => {
    const playlist = parseM3u(utf8(M3U_EXCERPT));
    expect(playlist.stats.rejectedEntries).toBe(0);
    expect(playlist.stats.lines).toBeGreaterThan(10);
    const first = playlist.entries[0];
    expect(first).toMatchObject({ index: 0, line: 2, duration: -1, name: '3Cat Càmeres del temps (1080p)' });
    expect(first?.attributes).toEqual({ 'tvg-id': '3CatCameresdeltemps.es@SD' });
    expect(first?.url).toBe('https://directes-tv-int.3catdirectes.cat/live-content/beauties-hls/master.m3u8');
    expect(first?.urlLine).toBe(3);
    // Same tvg-id repeated with a different URL: both entries survive the parser.
    const exclusiu = playlist.entries.filter((entry) => entry.attributes['tvg-id'] === '3CatExclusiu1.es@SD');
    expect(exclusiu).toHaveLength(2);
    expect(exclusiu[0]?.url).not.toBe(exclusiu[1]?.url);
    expect(exclusiu[0]?.name).toContain('[Geo-blocked]');
  });

  it('reads #EXTVLCOPT:http-referrer and #EXTVLCOPT:http-user-agent directives', () => {
    const playlist = parseM3u(utf8(M3U_EXCERPT));
    const withReferer = playlist.entries.find((entry) => entry.name.startsWith('12TV'));
    expect(withReferer?.directives).toEqual({ 'http-referrer': 'https://www.12tv.es/' });
    const withAgent = playlist.entries.find((entry) => entry.name.startsWith('Canal Demo'));
    expect(withAgent?.directives['http-user-agent']).toContain('Chrome/147');
  });

  it('unwraps the observed malformed nesting of http-user-agent', () => {
    const playlist = parseM3u(utf8(M3U_EXCERPT));
    const nested = playlist.entries.find((entry) => entry.name.startsWith('Canal Demo'));
    const agent = nested?.directives['http-user-agent'] ?? '';
    expect(agent.startsWith('#EXTVLCOPT')).toBe(false);
    expect(agent.match(/Mozilla\/5\.0/g)).toHaveLength(1);
    expect(agent).toContain('AppleWebKit/537.36');
  });

  it('keeps junk suffixes (WOW64, Chrome build) inside the directive value', () => {
    const playlist = parseM3u(utf8(M3U_EXCERPT));
    const junk = playlist.entries.find((entry) => entry.name.startsWith('Canal Junk'));
    expect(junk?.directives['http-user-agent']).toContain('WOW64');
    expect(junk?.directives['http-user-agent']).toContain('Chrome/92.0.4515.131');
  });

  it('returns no entries for the empty leading line and keeps the file header empty', () => {
    const playlist = parseM3u(utf8(M3U_EXCERPT));
    expect(playlist.header).toEqual({ attributes: {}, xTvgUrlCount: 0, hasXTvgUrl: false, missing: false });
  });

  it('handles a name containing a comma', () => {
    const playlist = parseM3u(utf8('#EXTM3U\n#EXTINF:-1 tvg-id="x.es",News, Weather and More, live\nhttps://a.example/x.m3u8\n'));
    expect(playlist.entries[0]?.name).toBe('News, Weather and More, live');
  });

  it('does not treat a comma inside a quoted attribute as the name separator', () => {
    const playlist = parseM3u(utf8('#EXTM3U\n#EXTINF:-1 tvg-id="x.es" tvg-name="A, B",Real Name\thttps://a.example/x.m3u8\nhttps://a.example/x.m3u8\n'));
    expect(playlist.entries[0]?.attributes['tvg-name']).toBe('A, B');
    expect(playlist.entries[0]?.name).toBe('Real Name\thttps://a.example/x.m3u8');
  });

  it('parses Free-TV header attributes without storing the huge x-tvg-url', () => {
    const playlist = parseM3u(utf8(FREE_TV_HEADER_PLAYLIST));
    expect(playlist.header.hasXTvgUrl).toBe(true);
    expect(playlist.header.xTvgUrlCount).toBe(3);
    expect(JSON.stringify(playlist.header)).not.toContain('epgshare01');
    const entry = playlist.entries[0];
    expect(entry?.attributes).toMatchObject({
      'tvg-name': 'Kanali 7',
      'tvg-logo': 'https://i.imgur.com/rL2v9pM.png',
      'tvg-id': 'Kanali7.al',
      'tvg-country': 'AL',
      'group-title': 'Albania',
    });
    expect(entry?.name).toBe('Kanali 7 Ⓢ');
  });

  it('rejects the Free-TV placeholder and the rtsp URL with typed reasons and line numbers', () => {
    const playlist = parseM3u(utf8(FREE_TV_ENTRIES_PLAYLIST));
    expect(playlist.entries.map((entry) => entry.rejected)).toEqual([null, 'not-http', 'not-http']);
    expect(playlist.rejected).toEqual([
      { line: 5, reason: 'not-http', raw: '[NO PUBLIC STREAM]' },
      { line: 7, reason: 'not-http', raw: 'rtsp://185.50.56.16:554/neontelvizija' },
    ]);
    expect(playlist.stats.rejectedEntries).toBe(2);
  });
});

describe('parseM3u — malformed input never throws and is never silent', () => {
  it('reports an entry with no URL before the next #EXTINF', () => {
    const playlist = parseM3u(utf8('#EXTM3U\n#EXTINF:-1,One\n#EXTINF:-1,Two\nhttps://a.example/2.m3u8\n'));
    expect(playlist.entries.map((entry) => entry.rejected)).toEqual(['no-url', null]);
    expect(playlist.rejected).toContainEqual({ line: 2, reason: 'no-url', raw: '#EXTINF:-1,One' });
  });

  it('reports an entry with no URL at end of file', () => {
    const playlist = parseM3u(utf8('#EXTM3U\n#EXTINF:-1 ,Orphan\n'));
    expect(playlist.rejected).toEqual([{ line: 2, reason: 'no-url', raw: '#EXTINF:-1 ,Orphan' }]);
  });

  it('reports an href with no #EXTINF as no-extinf', () => {
    const playlist = parseM3u(utf8('#EXTM3U\nhttps://a.example/orphan.m3u8\n'));
    expect(playlist.rejected).toEqual([{ line: 2, reason: 'no-extinf', raw: 'https://a.example/orphan.m3u8' }]);
    expect(playlist.entries[0]).toMatchObject({ line: 2, rejected: 'no-extinf', url: 'https://a.example/orphan.m3u8' });
  });

  it('reports a missing name', () => {
    const playlist = parseM3u(utf8('#EXTM3U\n#EXTINF:-1 tvg-id="x.es"\nhttps://a.example/x.m3u8\n'));
    expect(playlist.rejected).toEqual([{ line: 2, reason: 'missing-name', raw: '#EXTINF:-1 tvg-id="x.es"' }]);
    expect(playlist.entries[0]?.rejected).toBe('missing-name');
  });

  it('rejects non-http schemes', () => {
    const playlist = parseM3u(utf8('#EXTM3U\n#EXTINF:-1,A\nrtmp://x.example/live\n#EXTINF:-1,B\nudp://@239.0.0.1:1234\n'));
    expect(playlist.entries.map((entry) => entry.rejected)).toEqual(['not-http', 'not-http']);
  });

  it('ignores blank lines, comments and garbage without losing entries', () => {
    const garbage = '\u0000\u0001#\t\n.m3u8\n\n\r\n   \n#EXTINF:-1,Good\nhttps://a.example/good.m3u8\n';
    const playlist = parseM3u(utf8(garbage));
    // `.m3u8` on its own is an href with no `#EXTINF`: it becomes a rejected entry.
    expect(playlist.entries).toHaveLength(2);
    expect(playlist.entries[1]).toMatchObject({ line: 6, name: 'Good', rejected: null });
    expect(playlist.rejected).toEqual([{ line: 2, reason: 'no-extinf', raw: '.m3u8' }]);
  });

  it('handles CRLF and LF line endings identically', () => {
    const body = '#EXTM3U\n#EXTINF:-1 tvg-id="x.es",X\nhttps://a.example/x.m3u8\n';
    const crlf = parseM3u(utf8(body.replace(/\n/g, '\r\n')));
    const lf = parseM3u(utf8(body));
    expect(crlf.entries).toEqual(lf.entries);
    expect(crlf.entries[0]?.url).toBe('https://a.example/x.m3u8');
    expect(crlf.entries[0]?.url?.endsWith('\r')).toBe(false);
  });

  it('parses UTF-16LE and UTF-16BE playlists', () => {
    const body = '#EXTM3U\n#EXTINF:-1,Càmeres\nhttps://a.example/c.m3u8\n';
    expect(parseM3u(utf16(body, true)).entries[0]?.name).toBe('Càmeres');
    expect(parseM3u(utf16(body, false)).entries[0]?.name).toBe('Càmeres');
  });

  it('parses a windows-1252 playlist', () => {
    const bytes = new Uint8Array([...utf8('#EXTM3U\n#EXTINF:-1,C'), 0xe0, ...utf8('meres\nhttps://a.example/c.m3u8\n')]);
    expect(parseM3u(bytes).entries[0]?.name).toBe('Càmeres');
  });

  it('tolerates unbalanced quotes in attributes', () => {
    const playlist = parseM3u(utf8('#EXTM3U\n#EXTINF:-1,   \nhttps://a.example/x.m3u8\n'));
    expect(playlist.entries).toHaveLength(1);
    expect(playlist.entries[0]?.name).toBe('');
    expect(playlist.entries[0]?.url).toBe('https://a.example/x.m3u8');
    expect(playlist.rejected.map((item) => item.reason)).toContain('missing-name');
  });

  it('survives an unbalanced quote inside attributes', () => {
    const playlist = parseM3u(utf8('#EXTM3U\n#EXTINF:-1 tvg-id="broken,Name\nhttps://a.example/x.m3u8\n'));
    expect(playlist.entries).toHaveLength(1);
    expect(playlist.entries[0]?.attributes['tvg-id']).toContain('broken');
    expect(playlist.entries[0]?.url).toBe('https://a.example/x.m3u8');
  });

  it('keeps a placeder-named entry: name falls back to tvg-name', () => {
    const playlist = parseM3u(utf8('#EXTM3U\n#EXTINF:-1 tvg-name="Kanal D Drama",\n[NO PUBLIC STREAM]\n'));
    expect(playlist.entries[0]).toMatchObject({ name: 'Kanal D Drama', rejected: 'not-http' });
    expect(playlist.rejected.map((item) => item.reason)).not.toContain('missing-name');
  });

  it('truncates absurdly long lines instead of buffering them', () => {
    const longName = 'x'.repeat(200_000);
    const playlist = parseM3u(utf8(`#EXTM3U\n#EXTINF:-1,${longName}\nhttps://a.example/long.m3u8\n`));
    expect(playlist.entries).toHaveLength(1);
    expect((playlist.entries[0]?.name ?? '').length).toBeLessThanOrEqual(200_000);
    expect(playlist.entries[0]?.url).toBe('https://a.example/long.m3u8');
  });

  it('drops over-long attribute values and records a bounded diagnostic', () => {
    const value = 'v'.repeat(MAX_ATTRIBUTE_VALUE_CHARS + 10);
    const playlist = parseM3u(utf8(`#EXTM3U\n#EXTINF:-1 tvg-name="${value}",X\nhttps://a.example/x.m3u8\n`));
    expect(playlist.entries[0]?.attributes['tvg-name']).toBe('');
    expect(playlist.diagnostics).toEqual([{ line: 2, reason: 'attribute-too-long', raw: 'tvg-name=…' }]);
  });

  it('records an unreadable #EXTVLCOPT as a typed diagnostic', () => {
    const playlist = parseM3u(utf8('#EXTM3U\n#EXTVLCOPT:===garbage===\n#EXTINF:-1,X\nhttps://a.example/x.m3u8\n'));
    expect(playlist.diagnostics.map((item) => item.reason)).toContain('directive-not-string');
    expect(playlist.entries[0]?.directives).toEqual({});
  });

  it('bounds the raw echo of a rejected line', () => {
    const playlist = parseM3u(utf8(`#EXTM3U\n${'z'.repeat(5_000)}\n`));
    const raw = playlist.rejected[0]?.raw ?? '';
    expect(raw.length).toBeLessThanOrEqual(MAX_RAW_BOUND_BYTES + 1);
  });

  it('flags a missing #EXTM3U header but still parses the entries', () => {
    const playlist = parseM3u(utf8('#EXTINF:-1,X\nhttps://a.example/x.m3u8\n'));
    expect(playlist.header.missing).toBe(true);
    expect(playlist.entries).toHaveLength(1);
  });

  it('never throws on a matrix of hostile inputs', () => {
    const inputs: Uint8Array[] = [
      new Uint8Array(),
      utf8('#EXTM3U'),
      utf8('#EXTINF'),
      utf8('#EXTINF:'),
      utf8('#EXTINF:,'),
      utf8('#EXTVLCOPT'),
      utf8('#EXTVLCOPT:'),
      utf8('#EXTVLCOPT:http-user-agent'),
      utf8('\uFEFF'),
      utf8('#EXTM3U x-tvg-url="'),
      utf8('#EXTINF:-1 tvg-name="'),
      utf8('#EXTINF:NaN,Name\nhttps://a.example/x\n'),
      utf8('#EXTINF:+5 junk,Name\nnotaurl\n'),
      new Uint8Array([0xff]),
      new Uint8Array([0xff, 0xfe, 0x41]),
      new Uint8Array([0xfe, 0xff, 0x00]),
      new Uint8Array([0xef, 0xbb]),
      new Uint8Array(512).fill(0x2c),
    ];
    for (const input of inputs) {
      expect(() => parseM3u(input)).not.toThrow();
      const playlist = parseM3u(input);
      expect(playlist.stats.entries).toBe(playlist.entries.length);
    }
  });
});
