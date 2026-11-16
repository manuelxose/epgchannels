/**
 * Regression test for TDT02B-REV-004 (independent review, round 2).
 *
 * A candidate whose reconciliation verdict is `review` must never be linked to a
 * canonical channel, however many signals would otherwise match. Before the fix
 * the pipeline nulled the proposed link and then immediately re-linked the
 * candidate by identity key, silently folding a regional feed into its national
 * station ("La 1" Asturias -> "La 1") with no human decision — the exact merge
 * this milestone forbids.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import { loadConfig } from '../config/config.js';
import { connectDatabase } from '../infrastructure/mongo.js';
import { ensureIndexes } from '../infrastructure/schema.js';
import type { SourceSnapshotDoc } from '../catalogue/schema.js';
import { decodePlaylistBytes, parsePlaylistText } from './m3u.js';
import { runIngestion } from './pipeline.js';

const MONGO_URI =
  process.env['TEST_MONGODB_URI'] ?? process.env['MONGODB_URI'] ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0';

let database: DatabaseHandle;
let databaseName = '';

function snapshotFor(retrievedAt: Date): SourceSnapshotDoc {
  return {
    _id: 'a'.repeat(64),
    upstream: 'iptv-org',
    upstreamUrl: 'https://github.com/iptv-org/iptv',
    commitSha: 'b'.repeat(40),
    retrievedAt,
    checksumSha256: 'a'.repeat(64),
    licence: { spdx: 'Unlicense', url: null, reuse: 'public-domain', notes: 'test fixture' },
    format: 'm3u',
    fileCount: 1,
    entryCount: 2,
    bytes: 100,
    status: 'ingested',
    rejectionReason: null,
    createdAt: retrievedAt,
  };
}

function playlistsFor(lines: readonly string[]) {
  const bytes = new TextEncoder().encode(lines.join('\n'));
  const decoded = decodePlaylistBytes(bytes);
  return [
    {
      path: 'streams/es.m3u',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
      entries: lines.filter((line) => line.startsWith('#EXTINF')).length,
      playlist: parsePlaylistText(decoded.text),
    },
  ];
}

beforeAll(async () => {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    MONGODB_URI: MONGO_URI,
  } as NodeJS.ProcessEnv);
  databaseName = `tdt_rev004_${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 10)}`;
  database = await connectDatabase(MONGO_URI, databaseName);
  await ensureIndexes(database.db);
});

afterAll(async () => {
  if (database) {
    await database.db.dropDatabase().catch(() => undefined);
    await database.close();
  }
});

describe('TDT02B-REV-004 — a reviewed candidate is never linked', () => {
  it('keeps a regional feed unlinked when its tvg-id region does not corroborate', async () => {
    const retrievedAt = new Date('2026-11-16T14:00:00.000Z');
    const playlists = playlistsFor([
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="La1.es",La 1',
      'https://national.example/live.m3u8',
      '#EXTINF:-1 tvg-id="La1.ast.es",La 1',
      'https://asturias.example/live.m3u8',
    ]);

    await runIngestion(database, snapshotFor(retrievedAt), playlists, { idNamespace: 'rev004' });

    const candidates = await database.db
      .collection('source_candidates')
      .find({})
      .sort({ 'provenance.line': 1 })
      .toArray();
    const reviews = await database.db.collection('reconciliation_review').find({}).toArray();

    // Exactly one of the two feeds owns the channel; the other must be unlinked.
    const linked = candidates.filter((candidate) => candidate.channelId !== null);
    const unlinked = candidates.filter((candidate) => candidate.channelId === null);

    expect(candidates).toHaveLength(2);
    expect(linked).toHaveLength(1);
    expect(unlinked).toHaveLength(1);

    // The unlinked one is the one whose tvg-id did not corroborate.
    expect(unlinked[0]!.state).toBe('unmatched');

    // It is queued for a person, and the review PROPOSES a link without making it.
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.channelId).toBeNull();
    expect(reviews[0]!.proposedChannelId).toBe(linked[0]!.channelId);
    expect(String(reviews[0]!.reason)).toContain('review');
  });
});
