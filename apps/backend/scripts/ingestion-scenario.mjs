/**
 * End-to-end ingestion scenarios with compact pass/fail lines.
 *
 *   node apps/backend/scripts/ingestion-scenario.mjs [--uri <mongodb-uri>] [--json]
 *
 * Every scenario runs against a real MongoDB and the real built modules, in a
 * disposable database (`tdt_scenario_<12 hex>`) that is dropped before exit —
 * also on failure. Nothing is read from or written to a non-disposable database
 * and nothing in the output is playlist text or a document body.
 *
 * Scenarios (one PASS/FAIL line each, then a summary line):
 *   malformed-m3u          every bad line is a typed rejection; the parser never throws
 *   duplicate-candidates   the same URL is one candidate per source, never a second channel
 *   slug-identity-collision  unique identity keys/slugs agree with the unique index
 *   country-normalisation  names/codes/accents resolve deterministically, never guessed
 *   provider-variants      La 1 from two providers is one channel with two sources
 *   incremental-import     snapshot A then B: B attaches La 1, adds only new stations
 *   idempotent-rerun       a repeated run creates zero channel and zero candidate ids
 *   run-rollback           a run rolls back to exactly the data it created
 *   migration-rollback     the migration CLI rolls back loudly and re-applies
 *
 * Exit codes: 0 every scenario passed, 1 a scenario failed, 2 usage error.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  assert,
  assertDeepEqual,
  assertEqual,
  catalogueCounts,
  defaultMongoUri,
  deterministicId,
  dropDisposable,
  ingestSnapshot,
  loadBackend,
  openDisposable,
  peakRssMiB,
  repositoryRoot,
  round,
  runMigrationCli,
  scenario,
} from './ingestion-core.mjs';

function usage(message) {
  process.stderr.write(`${message}\nUsage: node apps/backend/scripts/ingestion-scenario.mjs [--uri <mongodb-uri>] [--json]\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { uri: defaultMongoUri(), json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--uri':
        if (argv[index + 1] === undefined) usage('--uri needs a connection string');
        options.uri = argv[index + 1];
        index += 1;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        usage('Running the ingestion scenarios.');
        break;
      default:
        usage(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/* ------------------------------------------------------------------------- *
 * Synthetic snapshots, written exactly like the maintainer fetch tool does.
 * ------------------------------------------------------------------------- */

const COMMIT_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const COMMIT_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const COMMIT_C = 'cccccccccccccccccccccccccccccccccccccccc';

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Writes `<base>/<upstream>-<sha7>/` with a real manifest so `loadSnapshot` verifies digests. */
function writeSnapshot(base, upstream, commitSha, retrievedAt, files) {
  const root = join(base, `${upstream}-${commitSha.slice(0, 7)}`);
  const declared = files.map((file) => {
    const bytes = new Uint8Array(Buffer.from(file.text, 'utf8'));
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    writeFileSync(join(root, file.path), bytes);
    return {
      path: file.path,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      entries: (file.text.match(/^#EXTINF/gmu) ?? []).length,
    };
  });
  const manifest = {
    schemaVersion: 'tdt-snapshot-manifest/1',
    upstream,
    repo: upstream === 'iptv-org' ? 'iptv-org/iptv' : 'Free-TV/IPTV',
    commitSha,
    retrievedAt,
    licence:
      upstream === 'iptv-org'
        ? { spdx: 'Unlicense', url: 'https://github.com/iptv-org/iptv/blob/master/LICENSE', reuse: 'public-domain', notes: 'synthetic' }
        : { spdx: null, url: 'https://github.com/Free-TV/IPTV', reuse: 'unlicensed', notes: 'synthetic' },
    files: declared,
    fileCount: declared.length,
    entryCount: declared.reduce((total, file) => total + file.entries, 0),
    bytes: declared.reduce((total, file) => total + file.bytes, 0),
    truncated: false,
  };
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return root;
}

const SNAPSHOT_A_FILES = [
  {
    path: 'streams/es.m3u',
    text: [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="La 1.es@SD",La 1 (720p)',
      'https://la1.example.invalid/sd.m3u8',
      '#EXTINF:-1 tvg-id="La 1.es@HD",La 1 (1080p)',
      'https://la1.pluto.example.invalid/hd.m3u8',
      '#EXTINF:-1 tvg-id="Antena 3.es@SD",Antena 3',
      'https://antena3.example.invalid/live.m3u8',
    ].join('\n'),
  },
  {
    path: 'streams/fr.m3u',
    text: [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="TF1.fr@SD",TF1',
      'https://tf1.example.invalid/live.m3u8',
      '#EXTINF:-1 tvg-id="France 2.fr@SD",France 2',
      'https://france2.example.invalid/live.m3u8',
    ].join('\n'),
  },
];

/** The identical URL reported again on another line (its own provider file). */
const SNAPSHOT_A_DUPLICATE_FILE = {
  path: 'streams/es_provider2.m3u',
  text: [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="Antena 3.es@SD",Antena 3 (backup)',
    'https://antena3.example.invalid/live.m3u8',
  ].join('\n'),
};

/** Snapshot B (Free-TV grammar): a second source for La 1 plus two new stations. */
const SNAPSHOT_B_FILES = [
  {
    path: 'playlists/playlist_spain.m3u8',
    text: [
      '#EXTM3U x-tvg-url="https://example.invalid/free-epg.xml"',
      '#EXTINF:-1 tvg-name="La 1 HD" tvg-id="La 1.es" tvg-country="ES" group-title="Spain",La 1',
      'https://la1.freetv.example.invalid/live.m3u8',
      '#EXTINF:-1 tvg-name="Telecinco" tvg-id="Telecinco.es" tvg-country="ES" group-title="Spain",Telecinco',
      'https://telecinco.example.invalid/live.m3u8',
    ].join('\n'),
  },
  {
    path: 'playlists/playlist_mexico.m3u8',
    text: [
      '#EXTM3U',
      '#EXTINF:-1 tvg-name="Canal 5" tvg-id="Canal 5.mx" tvg-country="Mexico" group-title="Mexico",Canal 5',
      'https://canal5.example.invalid/live.m3u8',
    ].join('\n'),
  },
];

/** Snapshot C: one station no earlier scenario touched, used to prove the run rollback. */
const SNAPSHOT_C_FILES = [
  {
    path: 'streams/it.m3u',
    text: [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="Rai 1.it@SD",Rai 1',
      'https://rai1.example.invalid/live.m3u8',
      '#EXTINF:-1 tvg-id="Rai 2.it@SD",Rai 2',
      'https://rai2.example.invalid/live.m3u8',
    ].join('\n'),
  },
];

const MALFORMED_M3U = [
  '#EXTM3U x-tvg-url="https://example.invalid/epg.xml, https://example.invalid/epg2.xml"',
  '#EXTINF:-1 tvg-id="Canal Uno.es" tvg-country="Spain",Canal Uno',
  '#EXTVLCOPT:http-user-agent=Mozilla/5.0',
  '#EXTVLCOPT:http-referrer=https://example.invalid/',
  'https://a.example.invalid/uno.m3u8',
  '#EXTINF:-1 tvg-id="Canal Dos.es" tvg-country="Spain",Canal Dos',
  'https://b.example.invalid/dos.m3u8',
  '#EXTINF:-1 tvg-id="",',
  'https://c.example.invalid/nameless.m3u8',
  '#EXTINF:0 tvg-id="Sin Url.es",Sin Url',
  'ftp://not-http.example.invalid/x.m3u8',
  'https://orphan.example.invalid/orphan.m3u8',
  '#EXTINF:-1 tvg-id="Canal Tres.es",Canal Tres',
  'rtsp://not-http.example.invalid/tres',
  '#EXTINF:-1 tvg-id="Canal Cinco.es",Canal Cinco',
  '#EXTINF:-1 tvg-id="Canal Cuatro.es" tvg-country="Spain",Canal Cuatro',
  'https://d.example.invalid/cuatro.m3u8',
].join('\r\n');

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

async function loadSynthetic(backend, path) {
  const load = backend.snapshot.loadSnapshot(path);
  if (load.integrity !== 'ok') throw new Error(`synthetic snapshot did not verify: ${load.errors[0] ?? 'unknown'}`);
  const doc = backend.snapshot.snapshotDocument(load, { now: new Date('2026-11-16T14:00:00.000Z') });
  if (doc.status !== 'ingested') throw new Error(`synthetic snapshot rejected: ${doc.rejectionReason ?? 'unknown'}`);
  return { doc, playlists: load.playlists };
}

async function ids(database, collection) {
  const rows = await database.collection(collection).find({}, { projection: { _id: 1 } }).toArray();
  return rows.map((row) => row._id).sort();
}

/** Digest of the catalogue data (channels + candidates): the whole stored shape. */
async function dataDigest(backend, database) {
  const hash = createHash('sha256');
  for (const name of [backend.mongo.COLLECTIONS.channels, backend.mongo.COLLECTIONS.sourceCandidates]) {
    const rows = await database.collection(name).find({}).sort({ _id: 1 }).toArray();
    hash.update(`${name}:${rows.length}:${JSON.stringify(rows)}\n`, 'utf8');
  }
  return hash.digest('hex');
}

async function countOf(database, collection, filter = {}) {
  return database.collection(collection).countDocuments(filter);
}

/* ------------------------------------------------------------------------- *
 * Scenarios
 * ------------------------------------------------------------------------- */

async function main(argv) {
  const options = parseArgs(argv);
  const root = repositoryRoot();
  const backend = await loadBackend(root);
  const C = backend.mongo.COLLECTIONS;
  const base = mkdtempSync(join(tmpdir(), 'tdt-ingestion-scenarios-'));
  const { name, database } = await openDisposable(backend, options.uri, 'tdt_scenario_');

  const paths = {
    a: writeSnapshot(base, 'iptv-org', COMMIT_A, '2026-11-16T14:53:23.000Z', [...SNAPSHOT_A_FILES, SNAPSHOT_A_DUPLICATE_FILE]),
    b: writeSnapshot(base, 'free-tv', COMMIT_B, '2026-11-16T14:56:04.000Z', SNAPSHOT_B_FILES),
    c: writeSnapshot(base, 'iptv-org', COMMIT_C, '2026-11-16T15:10:00.000Z', SNAPSHOT_C_FILES),
  };

  const results = [];
  let failure = null;
  try {
    const migrations = await backend.runner.migrate(database);
    assert(migrations.applied.length > 0, 'the disposable database starts with pending migrations');

    const run = async (factory) => {
      const result = await factory();
      results.push(result);
    };

    await run(
      scenario('malformed-m3u', () => {
        // The production path is bytes-in: decode first (it normalises CRLF),
        // exactly as `loadSnapshot` does. `parsePlaylistText` alone splits on
        // `\n` only, so a CRLF fixture must be decoded, never hand-split.
        const decoded = backend.m3u.decodePlaylistBytes(new Uint8Array(Buffer.from(MALFORMED_M3U, 'utf8')));
        const playlist = backend.m3u.parsePlaylistText(decoded.text);
        const names = playlist.entries.filter((entry) => entry.rejected === null).map((entry) => entry.name);
        assertDeepEqual(names, ['Canal Uno', 'Canal Dos', 'Canal Cuatro'], 'valid entries survive around bad lines');
        const reasons = playlist.rejected.map((line) => line.reason);
        for (const expected of ['missing-name', 'no-url', 'not-http', 'no-extinf']) {
          assert(reasons.includes(expected), `expected a typed rejection for ${expected}, got ${reasons.join(',')}`);
        }
        assert(playlist.rejected.every((line) => line.line > 0), 'every rejection carries a line number');
        assertEqual(playlist.stats.rejectedEntries, playlist.rejected.length, 'stats agree with the rejection list');
        assertEqual(playlist.header.hasXTvgUrl, true, 'header attributes are accounted for');
        assertEqual(playlist.header.xTvgUrlCount, 2, 'x-tvg-url entries are counted, not stored');
        const uno = playlist.entries.find((entry) => entry.name === 'Canal Uno');
        const dos = playlist.entries.find((entry) => entry.name === 'Canal Dos');
        assertEqual(uno?.directives['http-user-agent'], 'Mozilla/5.0', 'EXTVLCOPT applies to the next entry');
        assertEqual(dos?.directives['http-user-agent'], undefined, 'EXTVLCOPT does not leak to later entries');
        let threw = false;
        try {
          backend.m3u.parsePlaylistText(`#EXTINF:-1 tvg-id="${'x'.repeat(100000)}`);
        } catch {
          threw = true;
        }
        assert(!threw, 'a hostile line is bounded, never thrown on');
        // CRLF is normalised by the byte decoder (the production entry point);
        // `parsePlaylistText` alone keeps the `\r`, which is a reported deviation.
        assert(!decoded.text.includes('\r'), 'the byte decoder normalises CRLF');
        return {
          entries: playlist.stats.entries,
          rejected: playlist.rejected.length,
          rejectionReasons: [...new Set(reasons)].sort(),
          xTvgUrlCount: playlist.header.xTvgUrlCount,
          encoding: decoded.encoding,
        };
      }),
    );

    await run(
      scenario('duplicate-candidates', async () => {
        const { doc, playlists } = await loadSynthetic(backend, paths.a);
        const ingest = await ingestSnapshot(backend, database, doc, playlists);
        assertEqual(ingest.counts.duplicates, 1, 'the repeated URL is recorded as one duplicate');
        assertEqual(ingest.counts.rejected, 0, 'no valid entry is rejected');
        const rows = await database
          .collection(C.sourceCandidates)
          .find({ snapshotId: doc._id }, { projection: { urlSha256: 1, state: 1, duplicateOf: 1 } })
          .toArray();
        // A repeated URL never becomes a second *source*: exactly one row is the
        // canonical source and any other row with that digest is a duplicate.
        const repeated = rows.filter((row) => row.state === 'duplicate');
        assertEqual(repeated.length, 1, 'exactly one row is marked duplicate');
        assert(
          repeated.every((row) => typeof row.duplicateOf === 'string' && row.duplicateOf !== ''),
          'a duplicate points at the source it repeats',
        );
        const canonical = rows.filter((row) => row.state !== 'duplicate');
        assertEqual(new Set(canonical.map((row) => row.urlSha256)).size, canonical.length, 'no two source rows share a URL digest');
        assertEqual(await countOf(database, C.channels), 4, 'four stations, four channels');
        assertEqual(await countOf(database, C.channels, { name: /^Antena 3/u }), 1, 'the repeated station stays one channel');
        return { duplicates: ingest.counts.duplicates, sources: canonical.length, channels: 4, antena3Channels: 1 };
      }),
    );

    await run(
      scenario('slug-identity-collision', async () => {
        const channels = await database.collection(C.channels).find({}).toArray();
        const keys = channels.map((channel) => channel.identity.key);
        const slugs = channels.map((channel) => channel.slug);
        assertEqual(new Set(keys).size, keys.length, 'identity keys are unique');
        assertEqual(new Set(slugs).size, slugs.length, 'slugs are unique');
        const indexes = await database.collection(C.channels).indexes();
        assertEqual(indexes.find((index) => index.name === 'identity_key_unique')?.unique, true, 'the unique partial identity index exists');
        const taken = new Set([backend.slug.slugify('La 1')]);
        const first = backend.slug.uniqueSlug('La 1', taken);
        assert(first !== backend.slug.slugify('La 1'), 'a colliding slug is not reused');
        assertEqual(backend.slug.uniqueSlug('La 1', taken), first, 'slug collision resolution is deterministic');
        let rejected = false;
        const clash = { ...channels[0], _id: deterministicId('clash'), slug: `${channels[0].slug}-clash` };
        try {
          await new backend.store.ChannelStore(database).upsertChannel(clash);
        } catch (error) {
          rejected = /duplicate key/iu.test(error instanceof Error ? error.message : String(error));
        }
        assert(rejected, 'the unique identity index rejects a second channel with the same key');
        return { channels: channels.length, identityIndexUnique: true, duplicateKeyRejected: true };
      }),
    );

    await run(
      scenario('country-normalisation', async () => {
        const normalize = backend.normalize;
        const cases = [
          ['Spain', 'ES'],
          ['es', 'ES'],
          ['ESPANA', 'ES'],
          ['España', 'ES'],
          ['Mexico', 'MX'],
          ['México', 'MX'],
          ['Atlantis', null],
          ['', null],
          [null, null],
        ];
        for (const [input, expected] of cases) {
          assertEqual(normalize.normalizeCountry(input), expected, `normalizeCountry(${JSON.stringify(input)})`);
        }
        assertEqual(normalize.normalizeLanguage('Spanish'), 'es', 'normalizeLanguage(Spanish)');
        assertEqual(normalize.normalizeLanguage('es-ES'), 'es', 'normalizeLanguage(es-ES)');
        assertEqual(normalize.normalizeLanguage(''), null, 'normalizeLanguage("")');
        assertEqual(
          normalize.identityKey(normalize.normalizeCountry('Spain'), normalize.normalizeChannelName('La 1 (1080p)')),
          normalize.identityKey('ES', 'la 1'),
          'the HD tag does not change the identity key',
        );
        const freeTv = await loadSynthetic(backend, paths.b);
        const byCountry = new Map(backend.provenance.buildCandidates(freeTv.doc, freeTv.playlists).map((row) => [row.name, row.country]));
        assertEqual(byCountry.get('Telecinco'), 'ES', 'free-tv tvg-country=ES resolves to ES');
        assertEqual(byCountry.get('Canal 5'), 'MX', 'free-tv tvg-country=Mexico resolves to MX');
        return {
          cases: cases.length + 5,
          resolved: { Spain: 'ES', Espana: 'ES', Mexico: 'MX' },
          neverGuessed: ['Atlantis', '', null],
        };
      }),
    );

    await run(
      scenario('provider-variants', async () => {
        // Snapshot A reports La 1 from two providers (two hosts, two qualities).
        const la1 = await database.collection(C.channels).find({ name: /^La 1/u }).toArray();
        assertEqual(la1.length, 1, 'provider variants collapse into one channel');
        const sources = await database.collection(C.sourceCandidates).find({ channelId: la1[0]._id }).toArray();
        assert(sources.length >= 2, `La 1 keeps ${sources.length} source(s)`);
        const hosts = new Set(sources.map((row) => new URL(row.normalizedUrl).hostname));
        assert(hosts.size >= 2, 'the two variants are distinct hosts');
        assert(
          sources.every((row) => row.state === 'reconciled' || row.state === 'staging'),
          'variant sources stay staged or reconciled, never published',
        );
        return { la1Channels: 1, sources: sources.length, distinctHosts: hosts.size };
      }),
    );

    let countsBeforeB;
    await run(
      scenario('incremental-import', async () => {
        const before = {
          channels: await countOf(database, C.channels),
          candidates: await countOf(database, C.sourceCandidates),
          snapshots: await countOf(database, C.sourceSnapshots),
        };
        const { doc, playlists } = await loadSynthetic(backend, paths.b);
        const ingest = await ingestSnapshot(backend, database, doc, playlists);
        assertEqual(await countOf(database, C.sourceSnapshots), before.snapshots + 1, 'snapshot B is recorded');
        assertEqual(await countOf(database, C.sourceCandidates), before.candidates + 3, 'snapshot B adds three candidates');
        assertEqual(ingest.createdChannelIds.length, 2, 'only Telecinco and Canal 5 are new channels');
        assert(ingest.counts.reconciled >= 1, 'La 1 from free-tv attaches to the existing channel');
        const la1 = await database.collection(C.channels).find({ name: /^La 1/u }).toArray();
        assertEqual(la1.length, 1, 'La 1 is still one channel after the second upstream');
        const upstreams = (await database.collection(C.sourceCandidates).distinct('upstream', { channelId: la1[0]._id })).sort();
        assertDeepEqual(upstreams, ['free-tv', 'iptv-org'], 'both upstreams point at the one La 1 channel');
        countsBeforeB = await catalogueCounts(backend, database);
        return {
          newCandidates: 3,
          newChannels: ingest.createdChannelIds.length,
          reconciled: ingest.counts.reconciled,
          la1Upstreams: upstreams,
        };
      }),
    );

    await run(
      scenario('idempotent-rerun', async () => {
        const channelsBefore = await ids(database, C.channels);
        const candidatesBefore = await ids(database, C.sourceCandidates);
        const digestBefore = await dataDigest(backend, database);
        const { doc, playlists } = await loadSynthetic(backend, paths.b);
        const first = await ingestSnapshot(backend, database, doc, playlists, { attempt: 1 });
        const second = await ingestSnapshot(backend, database, doc, playlists, { attempt: 1 });
        assertEqual(first.createdChannelIds.length + second.createdChannelIds.length, 0, 'zero new channel ids across two re-runs');
        assertEqual(first.createdCandidateIds.length + second.createdCandidateIds.length, 0, 'zero new candidate ids across two re-runs');
        assertDeepEqual(await ids(database, C.channels), channelsBefore, 'channel ids are unchanged');
        assertDeepEqual(await ids(database, C.sourceCandidates), candidatesBefore, 'candidate ids are unchanged');
        assertEqual(await dataDigest(backend, database), digestBefore, 'every stored document is byte-identical');
        const countsAfter = await catalogueCounts(backend, database);
        assertEqual(countsAfter.uniqueCanonicalChannels, countsBeforeB.uniqueCanonicalChannels, 'canonical channel count is identical');
        assertEqual(countsAfter.duplicateEntries, countsBeforeB.duplicateEntries, 'duplicate count is identical');
        return { newChannelIds: 0, newCandidateIds: 0, runs: 2, countsIdentical: true };
      }),
    );

    await run(
      scenario('run-rollback', async () => {
        const channelsBefore = await ids(database, C.channels);
        const candidatesBefore = await ids(database, C.sourceCandidates);
        const digestBefore = await dataDigest(backend, database);
        const { doc, playlists } = await loadSynthetic(backend, paths.c);
        const ingest = await ingestSnapshot(backend, database, doc, playlists);
        assertEqual(ingest.createdChannelIds.length, 2, 'the run created two channels');
        assertEqual(ingest.createdCandidateIds.length, 2, 'the run created two candidates');
        assert((await dataDigest(backend, database)) !== digestBefore, 'the run changed the catalogue');
        const store = new backend.store.ChannelStore(database);
        const removal = await store.rollbackRun(ingest.runId);
        assertEqual(removal.removed, 4, 'exactly the four records the run created were removed');
        assertDeepEqual(await ids(database, C.channels), channelsBefore, 'channel ids are back to the pre-run state');
        assertDeepEqual(await ids(database, C.sourceCandidates), candidatesBefore, 'candidate ids are back to the pre-run state');
        assertEqual(await dataDigest(backend, database), digestBefore, 'every stored document is byte-identical again');
        const ledger = await database.collection(C.ingestionRuns).findOne({ _id: ingest.runId });
        assertEqual(ledger?.status, 'rolled-back', 'the run survives as an audit record');
        assertEqual((await store.rollbackRun(deterministicId('missing'))).removed, 0, 'an unknown run removes nothing');
        assertEqual(await dataDigest(backend, database), digestBefore, 'the unknown rollback changed nothing');
        return { removed: removal.removed, runStatus: 'rolled-back', unknownRunRemoved: 0 };
      }),
    );

    await run(
      scenario('migration-rollback', async () => {
        const rolled = await runMigrationCli(root, options.uri, name, ['rollback', '006-incremental-dedup']);
        assertEqual(rolled.exitCode, 0, `the rollback CLI exits 0 (stderr: ${rolled.stderr.slice(0, 200)})`);
        assert(rolled.stdout.includes('006-incremental-dedup'), 'the CLI reports the migrated step it rolled back');
        const again = await runMigrationCli(root, options.uri, name, ['rollback', '006-incremental-dedup']);
        assert(again.exitCode !== 0, 'rolling the same step back twice exits non-zero');
        const reapply = await runMigrationCli(root, options.uri, name, []);
        // `run.js` exits 1 itself when `pendingAfter` is not empty; it applies
        // what is pending, so one rollback leaves a pending step until re-applied.
        assert(
          reapply.exitCode === 0 || reapply.stdout.includes('006-incremental-dedup'),
          `re-applying reports the pending step (exit ${reapply.exitCode})`,
        );
        const second = await runMigrationCli(root, options.uri, name, []);
        assertEqual(second.exitCode, 0, 'a second run of the migration CLI exits 0 with nothing pending');
        const indexes = await database.collection(C.channels).indexes();
        assert(indexes.some((index) => index.name === 'identity_key_unique'), 'the identity index is back after re-applying');
        return { rollbackExitCode: rolled.exitCode, secondRollbackExitCode: again.exitCode, reapplyExitCode: second.exitCode };
      }),
    );
  } catch (error) {
    failure = error;
    results.push({ name: 'harness', passed: false, ms: 0, facts: {}, error: error instanceof Error ? error.message : String(error) });
  } finally {
    const dropped = await dropDisposable(backend, options.uri, name, [database]).catch(() => false);
    rmSync(base, { recursive: true, force: true });
    if (!dropped) results.push({ name: 'drop-database', passed: false, ms: 0, facts: {}, error: 'disposable database was not dropped' });
  }

  const passed = results.filter((result) => result.passed).length;
  const allPassed = passed === results.length && failure === null;
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ command: 'ingestion-scenario', database: name, scenarios: results, passed, total: results.length, peakRssMiB: peakRssMiB() })}\n`);
  } else {
    for (const result of results) {
      const verdict = result.passed ? 'PASS' : 'FAIL';
      const detail = result.passed ? JSON.stringify(result.facts) : JSON.stringify({ error: result.error });
      process.stdout.write(`${verdict} ${result.name} ${result.ms}ms ${detail}\n`);
    }
    const totalMs = round(results.reduce((total, result) => total + result.ms, 0), 1);
    process.stdout.write(`SUMMARY ${passed}/${results.length} passed in ${totalMs}ms (peakRssMiB ${peakRssMiB()})\n`);
  }
  return allPassed ? 0 : 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${JSON.stringify({ command: 'ingestion-scenario', status: 'failed', error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
