/**
 * Snapshot loader — bounded, versioned, tamper-evident.
 *
 * Each test writes a tiny synthetic snapshot into a temporary directory (the
 * real ones are read-only upstream copies and must not be mutated): the point
 * is that a mismatch anywhere rejects the whole snapshot, never a subset.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES, loadSnapshot, parseManifest, snapshotDocument, type SnapshotLoadResult } from './snapshot.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

const GOOD_PLAYLIST = '#EXTM3U\n#EXTINF:-1 tvg-id="a.es@SD",A\nhttps://a.example/a.m3u8\n';
const SECOND_PLAYLIST = '#EXTM3U x-tvg-url="https://epg.example/a.xml, https://epg.example/b.xml"\n#EXTINF:-1,B\nhttps://b.example/b.m3u8\n';

interface FixtureOptions {
  files?: Record<string, string>;
  /** Overrides applied on top of the correct manifest. */
  mutateManifest?: (manifest: Record<string, unknown>) => void;
  omitFile?: string;
}

interface Fixture {
  root: string;
  manifest: Record<string, unknown>;
}

function writeSnapshot(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'tdt-snapshot-'));
  roots.push(root);
  const files = options.files ?? { 'streams/es.m3u': GOOD_PLAYLIST, 'streams/fr.m3u': SECOND_PLAYLIST };
  const entries: { path: string; sha256: string; bytes: number; entries: number }[] = [];
  for (const [path, text] of Object.entries(files)) {
    const bytes = Buffer.from(text, 'utf8');
    const target = join(root, ...path.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, bytes);
    entries.push({ path, sha256: sha256(bytes), bytes: bytes.length, entries: (text.match(/#EXTINF/g) ?? []).length });
    if (options.omitFile === path) rmSync(target);
  }
  const manifest: Record<string, unknown> = {
    schemaVersion: 'tdt-snapshot-manifest/1',
    upstream: 'iptv-org',
    repo: 'iptv-org/iptv',
    commitSha: '61b5e2ace91b35262d830e60cd266a9df64e3b1e',
    retrievedAt: '2026-11-16T14:53:23.231Z',
    licence: {
      spdx: 'Unlicense',
      url: 'https://github.com/iptv-org/iptv/blob/master/LICENSE',
      reuse: 'public-domain',
      notes: 'public-domain dedication',
    },
    fileCount: entries.length,
    entryCount: entries.reduce((sum, entry) => sum + entry.entries, 0),
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    files: entries,
  };
  options.mutateManifest?.(manifest);
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { root, manifest };
}

describe('loadSnapshot — verified snapshot', () => {
  it('loads every playlist when all digests match', () => {
    const { root } = writeSnapshot();
    const load = loadSnapshot(root);
    expect(load.integrity).toBe('ok');
    expect(load.errors).toEqual([]);
    expect(load.playlists.map((playlist) => playlist.path)).toEqual(['streams/es.m3u', 'streams/fr.m3u']);
    expect(load.playlists[0]?.playlist.entries[0]?.name).toBe('A');
    expect(load.playlists[1]?.playlist.header.xTvgUrlCount).toBe(2);
    expect(load.manifest?.commitSha).toBe('61b5e2ace91b35262d830e60cd266a9df64e3b1e');
    expect(load.manifest?.upstream).toBe('iptv-org');
  });

  it('records the recomputed digest, not the manifest claim', () => {
    const { root } = writeSnapshot();
    const load = loadSnapshot(root);
    const expected = sha256(Buffer.from(GOOD_PLAYLIST, 'utf8'));
    expect(load.playlists[0]?.sha256).toBe(expected);
  });
});

describe('loadSnapshot — rejection is total', () => {
  it('rejects the whole snapshot when a file digest does not match the manifest', () => {
    const { root } = writeSnapshot();
    writeFileSync(join(root, 'streams', 'fr.m3u'), `${SECOND_PLAYLIST}#EXTINF:-1,Injected\nhttps://evil.example/x.m3u8\n`);
    const load = loadSnapshot(root);
    expect(load.integrity).toBe('failed');
    expect(load.playlists).toEqual([]);
    expect(load.errors.length).toBeGreaterThan(0);
    expect(load.errors[0]).toContain('streams/fr.m3u');
    // The verified sibling is *not* returned: partial acceptance is forbidden.
    expect(load.manifest).not.toBeNull();
  });

  it('rejects a same-size byte flip on the digest alone', () => {
    const { root } = writeSnapshot();
    const flipped = `${SECOND_PLAYLIST.slice(0, -2)}Z\n`;
    expect(Buffer.byteLength(flipped)).toBe(Buffer.byteLength(SECOND_PLAYLIST));
    writeFileSync(join(root, 'streams', 'fr.m3u'), flipped);
    const load = loadSnapshot(root);
    expect(load.integrity).toBe('failed');
    expect(load.playlists).toEqual([]);
    expect(load.errors[0]).toContain('streams/fr.m3u');
    expect(load.errors[0]).toContain('sha256');
  });

  it('rejects a snapshot whose file size differs even when the digest would match', () => {
    const { root } = writeSnapshot();
    writeFileSync(join(root, 'streams', 'es.m3u'), GOOD_PLAYLIST);
    const load = loadSnapshot(root);
    expect(load.integrity).toBe('ok');
    const { root: root2 } = writeSnapshot({
      mutateManifest: (manifest) => {
        const files = manifest['files'] as { bytes: number }[];
        if (files[0] !== undefined) files[0].bytes += 1;
      },
    });
    const tampered = loadSnapshot(root2);
    expect(tampered.integrity).toBe('failed');
    expect(tampered.errors.join('\n')).toContain('size');
  });

  it('rejects a snapshot missing a listed file (partial copy)', () => {
    const { root } = writeSnapshot({ omitFile: 'streams/fr.m3u' });
    const load = loadSnapshot(root);
    expect(load.integrity).toBe('failed');
    expect(load.playlists).toEqual([]);
    expect(load.errors.join('\n')).toContain('unreadable');
  });

  it('rejects a snapshot without a manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'tdt-snapshot-'));
    roots.push(root);
    const load = loadSnapshot(root);
    expect(load.integrity).toBe('failed');
    expect(load.manifest).toBeNull();
  });

  it('rejects an unparseable manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'tdt-snapshot-'));
    roots.push(root);
    writeFileSync(join(root, 'manifest.json'), '{ not json');
    expect(loadSnapshot(root).integrity).toBe('failed');
  });

  it('rejects an unknown manifest schema version', () => {
    const { root } = writeSnapshot({ mutateManifest: (manifest) => (manifest['schemaVersion'] = 'tdt-snapshot-manifest/99') });
    const load = loadSnapshot(root);
    expect(load.integrity).toBe('failed');
    expect(load.errors[0]).toContain('schemaVersion');
  });

  it('rejects an unknown upstream', () => {
    const { root } = writeSnapshot({ mutateManifest: (manifest) => (manifest['upstream'] = 'mystery-tv') });
    const load = loadSnapshot(root);
    expect(load.integrity).toBe('failed');
    expect(load.errors[0]).toContain('upstream');
  });

  it('rejects path traversal in the manifest', () => {
    const { root } = writeSnapshot({
      mutateManifest: (manifest) => {
        const files = manifest['files'] as { path: string }[];
        if (files[0] !== undefined) files[0].path = '../escape.m3u';
      },
    });
    const load = loadSnapshot(root);
    expect(load.integrity).toBe('failed');
    expect(load.errors[0]).toContain('safe relative');
  });

  it('rejects a file larger than the bound', () => {
    const { root } = writeSnapshot({
      mutateManifest: (manifest) => {
        const files = manifest['files'] as { bytes: number }[];
        if (files[0] !== undefined) files[0].bytes = MAX_FILE_BYTES + 1;
      },
    });
    const load = loadSnapshot(root);
    expect(load.integrity).toBe('failed');
    expect(load.errors.join('\n')).toContain('exceeds the bound');
  });

  it('rejects an entry count that disagrees with the manifest', () => {
    const { root } = writeSnapshot({
      mutateManifest: (manifest) => {
        const files = manifest['files'] as { entries: number }[];
        if (files[0] !== undefined) files[0].entries = 99;
      },
    });
    const load = loadSnapshot(root);
    expect(load.integrity).toBe('failed');
    expect(load.errors.join('\n')).toContain('entries');
  });

  it('rejects a broken licence block', () => {
    const { root } = writeSnapshot({
      mutateManifest: (manifest) => (manifest['licence'] = { reuse: 'whatever' }),
    });
    const load = loadSnapshot(root);
    expect(load.integrity).toBe('failed');
    expect(load.errors.join('\n')).toContain('licence');
  });
});

describe('parseManifest', () => {
  it('returns typed errors instead of throwing', () => {
    for (const input of [null, 42, 'x', [], {}, { schemaVersion: 'tdt-snapshot-manifest/1' }]) {
      expect(() => parseManifest(input)).not.toThrow();
      expect(parseManifest(input).manifest).toBeNull();
    }
  });

  it('rejects duplicate file paths', () => {
    const { manifest } = writeSnapshot();
    const result = parseManifest({ ...manifest, files: [((manifest['files'] as unknown[])[0]), ((manifest['files'] as unknown[])[0])] });
    expect(result.errors.join('\n')).toContain('duplicate');
  });
});

describe('snapshotDocument', () => {
  it('describes a verified snapshot as ingested with a checksum id', () => {
    const { root } = writeSnapshot();
    const load = loadSnapshot(root);
    const doc = snapshotDocument(load, { now: new Date('2026-11-16T15:00:00Z') });
    expect(doc.status).toBe('ingested');
    expect(doc.rejectionReason).toBeNull();
    expect(doc._id).toMatch(/^[a-f0-9]{64}$/);
    expect(doc.checksumSha256).toBe(doc._id);
    expect(doc.fileCount).toBe(2);
    expect(doc.entryCount).toBe(2);
    expect(doc.retrievedAt.toISOString()).toBe('2026-11-16T14:53:23.231Z');
    expect(doc.licence.reuse).toBe('public-domain');
  });

  it('is deterministic: the same bytes yield the same snapshot id', () => {
    const a = snapshotDocument(loadSnapshot(writeSnapshot().root));
    const b = snapshotDocument(loadSnapshot(writeSnapshot().root));
    expect(a._id).toBe(b._id);
  });

  it('describes a failed load as rejected with the first error', () => {
    const { root } = writeSnapshot({ omitFile: 'streams/es.m3u' });
    const load: SnapshotLoadResult = loadSnapshot(root);
    const doc = snapshotDocument(load);
    expect(doc.status).toBe('rejected');
    expect(doc.rejectionReason).toContain('streams/es.m3u');
    expect(doc.entryCount).toBe(0);
  });
});
