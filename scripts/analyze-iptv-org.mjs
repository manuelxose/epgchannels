/**
 * One-off analysis of the iptv-org source material, so the integration is
 * designed on measured numbers instead of assumptions.
 *
 * Reads (read-only):
 *   - the committed-and-verified snapshot  data/snapshots/iptv-org-20261116T145323Z
 *   - the iptv-org channel database        https://raw.githubusercontent.com/iptv-org/database/master/data/channels.csv
 *
 * Answers, per measurement:
 *   - how many streams, how many carry a tvg-id, how many distinct ids
 *   - how many distinct countries, and the top ones
 *   - how many tvg-ids resolve to a row in channels.csv (join key health)
 *   - how many existing canonical channels (ES / INT) would match by tvg-id
 *   - how many channels.csv rows are closed / NSFW (must not be published blind)
 *
 *   node scripts/analyze-iptv-org.mjs
 */
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { MongoClient } from 'mongodb';

const ROOT = resolve(import.meta.dirname, '..');
const SNAPSHOT = resolve(ROOT, '..', 'data', 'snapshots', 'iptv-org-20261116T145323Z');
const CHANNELS_CSV = resolve(ROOT, '..', 'data', 'snapshots', 'iptv-org-channels.csv');
const CSV_URL = 'https://raw.githubusercontent.com/iptv-org/database/master/data/channels.csv';

/** Reads the comma-separated CSV used by iptv-org/database (quoted fields, no embedded newlines in practice). */
function parseCsv(text) {
  const rows = [];
  const header = [];
  let field = '';
  let quoted = false;
  let row = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const splitLine = (line) => {
    field = '';
    quoted = false;
    row = [];
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (quoted) {
        if (char === '"' && line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else if (char === '"') {
          quoted = false;
        } else {
          field += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ',') {
        row.push(field);
        field = '';
      } else {
        field += char;
      }
    }
    row.push(field);
    return row;
  };
  header.push(...splitLine(lines[0]));
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue;
    const values = splitLine(lines[index]);
    const record = {};
    for (let column = 0; column < header.length; column += 1) record[header[column]] = values[column] ?? '';
    rows.push(record);
  }
  return rows;
}

async function loadDatabase() {
  try {
    const existing = readFileSync(CHANNELS_CSV, 'utf8');
    return { rows: parseCsv(existing), source: 'local copy' };
  } catch {
    process.stderr.write('[analyze] downloading channels.csv…\n');
    const response = await fetch(CSV_URL);
    if (!response.ok) throw new Error(`channels.csv download failed: HTTP ${response.status}`);
    const text = await response.text();
    writeFileSync(CHANNELS_CSV, text, 'utf8');
    return { rows: parseCsv(text), source: 'downloaded' };
  }
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(SNAPSHOT, 'manifest.json'), 'utf8'));
  const streamsDir = join(SNAPSHOT, 'streams');
  const files = readFileSync(join(ROOT, '..', 'data', 'snapshots', 'iptv-org-20261116T145323Z', 'manifest.json'), 'utf8');

  /* ---- streams: one EXTINF line per stream entry -------------- */
  let entries = 0;
  let withId = 0;
  let geoBlocked = 0;
  const ids = new Map(); // tvg-id -> stream count
  const byCountry = new Map(); // file base name -> entries
  const httpHeaders = { referrer: 0, userAgent: 0 };

  const { readdirSync } = await import('node:fs');
  for (const name of readdirSync(streamsDir)) {
    if (!name.endsWith('.m3u')) continue;
    const file = join(streamsDir, name);
    const country = name.replace(/\.m3u$/, '');
    const reader = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of reader) {
      if (line.startsWith('#EXTINF')) {
        entries += 1;
        byCountry.set(country, (byCountry.get(country) ?? 0) + 1);
        const id = /tvg-id="([^"]+)"/.exec(line)?.[1];
        if (id) {
          withId += 1;
          ids.set(id, (ids.get(id) ?? 0) + 1);
        }
        if (/Geo-blocked/i.test(line)) geoBlocked += 1;
      } else if (line.startsWith('#EXTVLCOPT')) {
        if (/http-referrer/i.test(line)) httpHeaders.referrer += 1;
        if (/http-user-agent/i.test(line)) httpHeaders.userAgent += 1;
      }
    }
  }

  /* ---- channel database --------------------------------------- */
  const { rows, source } = await loadDatabase();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const closed = rows.filter((row) => row.closed && row.closed.trim() !== '').length;
  const nsfw = rows.filter((row) => row.is_nsfw === 'TRUE').length;
  const dbCountries = new Set(rows.map((row) => row.country).filter(Boolean));
  const resolved = [...ids.keys()].filter((id) => byId.has(stripQuality(id)));
  const unresolved = [...ids.keys()].filter((id) => !byId.has(stripQuality(id)));

  /* ---- existing canonical catalogue --------------------------- */
  const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0', {
    serverSelectionTimeoutMS: 3_000,
  });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB ?? 'tdt_platform');
  const existing = await db
    .collection('channels')
    .find({ editorialStatus: 'published', mergedInto: null }, { projection: { name: 1, slug: 1, aliases: 1, country: 1 } })
    .toArray();
  await client.close();
  const existingIds = new Set();
  for (const channel of existing) {
    for (const alias of channel.aliases ?? []) {
      if (alias.namespace === 'epg') existingIds.add(alias.value);
    }
    for (const alias of channel.aliases ?? []) {
      if (alias.namespace === 'iptv-org') existingIds.add(alias.value);
    }
  }
  const matchedExisting = [...ids.keys()].filter((id) => existingIds.has(stripQuality(id)) || existingIds.has(id));

  const report = {
    measuredAt: new Date().toISOString(),
    snapshot: {
      commitSha: manifest.commitSha,
      licence: manifest.licence,
      filesInManifest: manifest.fileCount,
      entriesInManifest: manifest.entryCount,
      truncatedInManifest: manifest.truncated,
      streamsFilesRead: readdirSync(streamsDir).filter((name) => name.endsWith('.m3u')).length,
      entriesRead: entries,
      entriesWithTvgId: withId,
      entriesWithoutTvgId: entries - withId,
      distinctTvgIds: ids.size,
      geoBlockedEntries: geoBlocked,
      httpReferrerDirectives: httpHeaders.referrer,
      httpUserAgentDirectives: httpHeaders.userAgent,
      countriesByFile: byCountry.size,
      topCountries: [...byCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
    },
    database: {
      source,
      rows: rows.length,
      distinctCountries: dbCountries.size,
      rowsWithCategory: rows.filter((row) => row.categories).length,
      rowsWithWebsite: rows.filter((row) => row.website).length,
      rowsWithLogoNote: 'logos live in the separate iptv-org/logos repository',
      closedRows: closed,
      nsfwRows: nsfw,
      topCategories: [...new Set(rows.flatMap((row) => row.categories.split(';').filter(Boolean)))]
        .slice(0, 5),
    },
    join: {
      tvgIdsResolvingToDatabase: resolved.length,
      tvgIdsUnresolved: unresolved.length,
      unresolvedSample: unresolved.slice(0, 10),
      existingChannelsMatchedByTvgId: matchedExisting.length,
      existingPublishedChannels: existing.length,
    },
    interpretation: {
      licence: 'iptv-org/iptv and iptv-org/database are public domain (Unlicense/CC0): copying is permitted; it is NOT an emitter authorisation, and every source must carry that distinction.',
      playability: 'Only geo-blocked entry counts are measured here; actual playability requires the verification engine (02D), never the list itself.',
    },
  };
  const out = join(ROOT, 'evidence', 'iptv-org', 'analysis.json');
  (await import('node:fs')).mkdirSync(join(ROOT, 'evidence', 'iptv-org'), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n[analyze] written to ${out}`);
  void files;
}

/** iptv-org ids carry an `@Quality` suffix that the database does not use. */
function stripQuality(id) {
  return id.split('@')[0];
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});
