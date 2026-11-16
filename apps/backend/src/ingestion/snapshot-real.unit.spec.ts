/**
 * Whole-snapshot behaviour against the real upstream copies, when present.
 *
 * These are read-only checks against the maintainer's local snapshot
 * (`data/snapshots/...`); they skip instead of failing when the snapshot is not
 * on the machine, so CI without the data stays green. The point is that the
 * parser and the candidate builder survive *all* 23 162 real entries without
 * throwing and account for every line.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCandidates, type SourceSnapshotDoc } from './provenance.js';
import { loadSnapshot, snapshotDocument } from './snapshot.js';

const DATA = 'C:/Users/Admin/Documents/workspace/streaming/data/snapshots';
const IPTV = `${DATA}/iptv-org-20261116T145323Z`;
const FREE_TV = `${DATA}/free-tv-20261116T145604Z`;

const hasSnapshot = (root: string): boolean => existsSync(`${root}/manifest.json`);

function candidatesFor(root: string): { doc: SourceSnapshotDoc; count: number; lines: number } {
  const load = loadSnapshot(root);
  expect(load.integrity).toBe('ok');
  const doc = snapshotDocument(load);
  const candidates = buildCandidates(doc, load.playlists);
  const lines = load.playlists.reduce((sum, playlist) => sum + playlist.playlist.entries.length, 0);
  return { doc, count: candidates.length, lines };
}

describe.skipIf(!hasSnapshot(IPTV))('real iptv-org snapshot', () => {
  it('verifies 400 files and turns every entry into one candidate', () => {
    const load = loadSnapshot(IPTV);
    expect(load.integrity).toBe('ok');
    expect(load.playlists).toHaveLength(400);
    const { doc, count, lines } = candidatesFor(IPTV);
    expect(doc.status).toBe('ingested');
    expect(count).toBe(lines);
    expect(count).toBeGreaterThan(18_000);
  });

  it('never loses a line: rejections + staging equal the entry count', () => {
    const load = loadSnapshot(IPTV);
    const candidates = buildCandidates(snapshotDocument(load), load.playlists);
    const staging = candidates.filter((candidate) => candidate.state === 'staging').length;
    const rejected = candidates.filter((candidate) => candidate.state === 'rejected').length;
    expect(staging + rejected).toBe(candidates.length);
    for (const candidate of candidates) {
      // Shape only: real snapshots contain `streams/<cc>.m3u` and `tests/__data__` fixtures.
      expect(candidate.provenance.upstreamPath).toMatch(/^[^/]+(?:[/][^/]+)*\.m3u8?$/);
      expect(candidate.provenance.line).toBeGreaterThan(0);
      expect(candidate.provenance.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('detects the observed directive shapes across the whole snapshot', () => {
    const load = loadSnapshot(IPTV);
    const byHost = new Map<string, number>();
    let referer = 0;
    let agent = 0;
    let nestedLeak = 0;
    for (const playlist of load.playlists) {
      for (const entry of playlist.playlist.entries) {
        if (entry.directives['http-referrer'] !== undefined) referer += 1;
        if (entry.directives['http-user-agent'] !== undefined) agent += 1;
        if ((entry.directives['http-user-agent'] ?? '').includes('#EXTVLCOPT')) nestedLeak += 1;
        const key = entry.url !== null ? new URL(entry.url).hostname : '';
        byHost.set(key, (byHost.get(key) ?? 0) + 1);
      }
    }
    expect(referer).toBeGreaterThan(0);
    expect(agent).toBeGreaterThan(0);
    expect(nestedLeak).toBe(0);
  });
});

describe.skipIf(!hasSnapshot(FREE_TV))('real free-tv snapshot', () => {
  it('verifies the snapshot and stores no x-tvg-url value on candidates', () => {
    const load = loadSnapshot(FREE_TV);
    expect(load.integrity).toBe('ok');
    expect(load.playlists.length).toBeGreaterThan(0);
    const candidates = buildCandidates(snapshotDocument(load), load.playlists);
    expect(candidates.length).toBeGreaterThan(4_000);
    expect(JSON.stringify(candidates)).not.toContain('epgshare01');
  });

  it('reads the country from the upstream file name', () => {
    const load = loadSnapshot(FREE_TV);
    const candidates = buildCandidates(snapshotDocument(load), load.playlists);
    const albania = candidates.find((candidate) => candidate.provenance.upstreamPath === 'playlists/playlist_albania.m3u8');
    expect(albania?.country).toBe('AL');
  });
});
