/**
 * Prueba del MODO DEMO (D-016): la licencia de una fuente es procedencia, no una
 * norma. Una fuente que no declara licencia (Free-TV, `reuse: unlicensed`) debe
 * poder publicarse igual que cualquier otra.
 *
 * Antes de D-016, `promoteChannel` devolvía `licence-not-publishable` y Free-TV
 * no era publicable nunca. Este test fija el comportamiento vigente: si alguien
 * reintroduce el veto, falla.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import { connectDatabase } from '../infrastructure/mongo.js';
import type { SourceSnapshotDoc } from '../catalogue/schema.js';
import { ensureIndexes } from '../infrastructure/schema.js';
import { decodePlaylistBytes, parsePlaylistText } from '../ingestion/m3u.js';
import { runIngestion } from '../ingestion/pipeline.js';
import { promoteChannel, recordAuthorization } from '../catalogue/authorisation.js';

const MONGO_URI =
  process.env['TEST_MONGODB_URI'] ?? process.env['MONGODB_URI'] ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0';

let database: DatabaseHandle;

function unlicensedSnapshot(retrievedAt: Date): SourceSnapshotDoc {
  return {
    _id: 'f'.repeat(64),
    upstream: 'free-tv',
    upstreamUrl: 'https://github.com/Free-TV/IPTV',
    commitSha: 'e'.repeat(40),
    retrievedAt,
    checksumSha256: 'f'.repeat(64),
    // The whole point: no licence declared.
    licence: { spdx: null, url: null, reuse: 'unlicensed', notes: 'no licence declared upstream' },
    format: 'm3u',
    fileCount: 1,
    entryCount: 1,
    bytes: 100,
    status: 'ingested',
    rejectionReason: null,
    createdAt: retrievedAt,
  };
}

beforeAll(async () => {
  const databaseName = `tdt_demo_${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 10)}`;
  database = await connectDatabase(MONGO_URI, databaseName);
  await ensureIndexes(database.db);
});

afterAll(async () => {
  if (database) {
    await database.db.dropDatabase().catch(() => undefined);
    await database.close();
  }
});

describe('D-016 demo mode — a licence is provenance, not a rule', () => {
  it('publishes a source that declares no licence once an operator authorises it', async () => {
    const retrievedAt = new Date('2026-11-16T14:00:00.000Z');
    const lines = ['#EXTM3U', '#EXTINF:-1 tvg-id="Demo1.es",Demo Channel', 'https://demo.example/live.m3u8'];
    const bytes = new TextEncoder().encode(lines.join('\n'));
    const decoded = decodePlaylistBytes(bytes);
    const playlists = [
      {
        path: 'playlist_spain.m3u8',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.byteLength,
        entries: 1,
        playlist: parsePlaylistText(decoded.text),
      },
    ];

    await runIngestion(database, unlicensedSnapshot(retrievedAt), playlists, { idNamespace: 'demo' });

    const channel = await database.db.collection('channels').findOne({});
    const candidate = await database.db
      .collection('source_candidates')
      .findOne({ channelId: channel?._id, state: 'reconciled' });
    expect(channel).not.toBeNull();
    expect(candidate).not.toBeNull();

    // Ingesting never publishes: the staging gate is independent of licence.
    expect(channel?.editorialStatus).toBe('draft');
    expect(channel?.catalogueState).toBe('staging');

    await recordAuthorization(database, {
      _id: `${channel!._id}:${candidate!._id}`,
      candidateId: String(candidate!._id),
      channelId: String(channel!._id),
      decision: 'approved',
      licenceReuse: 'unlicensed',
      conditions: {
        embedAllowed: true,
        proxyAllowed: false,
        requiresForgedHeader: false,
        emitterAppOnly: false,
        worldwide: true,
        restrictedRegions: [],
      },
      decidedBy: 'demo-operator',
      decidedAt: new Date(),
      notes: 'demo mode',
    });

    const promotion = await promoteChannel(database, {
      channelId: String(channel!._id),
      candidateId: String(candidate!._id),
      decidedBy: 'demo-operator',
    });

    // The licence must NOT block the promotion any more.
    expect(promotion).toMatchObject({ promoted: true });

    const after = await database.db.collection('channels').findOne({ _id: channel!._id });
    expect(after?.catalogueState).toBe('approved');
    expect(after?.editorialStatus).toBe('published');

    // ...but it is still recorded, as provenance, on the audit trail.
    const audit = await database.db.collection('audit_log').findOne({ action: 'catalogue.promote' });
    expect(audit?.after?.licenceReuse).toBe('unlicensed');
  });
});
