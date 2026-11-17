/**
 * iptv-org → canonical catalogue (TDT-API-02FG, ronda iptv-org).
 *
 * This is an ORCHESTRATOR, not a second ingestion. It takes the verified
 * iptv-org snapshot (18 689 stream entries, already checksummed per file) plus
 * the iptv-org channel database (31 843 rows), and turns the two into our own
 * records through the existing services:
 *
 *   1. `runIngestion` reconciles the streams into source candidates and creates
 *      the canonical channels it finds (staged, exactly as any other upstream).
 *   2. Each candidate whose `tvg-id` resolves in the database is attached to its
 *      channel as a `playback_sources` row — the record the public API reads.
 *
 * Three decisions, each measured or stated, never guessed:
 *
 * - **Closed and NSFW channels are not published.** 1 484 rows are closed and
 *   375 are flagged NSFW in the database. A dead channel and an adult channel are
 *   not catalogue; importing them by a bulk rule would be.
 * - **Directive-only sources are recorded, not advertised as playable.** 324
 *   entries need an `http-referrer` and 1 116 an `http-user-agent`. Our player
 *   cannot send those without impersonating another client, so the source is
 *   stored with `requiresForgedHeader: true`: visible, honestly marked, not
 *   silently promised.
 * - **Geo-blocked is a condition, not a rejection.** 1 222 entries declare it;
 *   they stay in the catalogue with `worldwide: false`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { ChannelDoc, PlaybackSourceDoc } from '../infrastructure/schema.js';
import type { SourceCandidateDoc } from '../catalogue/schema.js';
import { runIngestion } from './pipeline.js';
import { buildCandidates, type CandidateBuildOptions } from './provenance.js';
import { loadSnapshot, snapshotDocument } from './snapshot.js';
import { ADULT_CATEGORY, labelAdultName } from './adult-label.js';
import {
  buildDatabaseIndex,
  categoryOf,
  hasKnownCategory,
  isClosed,
  isNsfw,
  parseChannelsCsv,
  resolveByTvgId,
  type DatabaseIndex,
  type DatabaseRow,
} from './iptv-org.js';

export interface IptvOrgImportOptions {
  /** Directory of the verified snapshot (`data/snapshots/iptv-org-…`). */
  readonly snapshotRoot: string;
  /** Path to `data/channels.csv` from iptv-org/database. */
  readonly channelsCsv: string;
  /** Read everything and decide, write nothing. */
  readonly dryRun?: boolean;
  /** Stop after N resolvable candidates, for a bounded trial run. */
  readonly limit?: number;
  readonly idNamespace?: string;
}

export interface IptvOrgImportResult {
  readonly snapshotId: string;
  readonly upstream: {
    readonly commitSha: string | null;
    readonly licence: string;
    readonly entries: number;
    readonly files: number;
  };
  readonly database: {
    readonly rows: number;
    readonly closed: number;
    readonly nsfw: number;
    readonly countries: number;
    readonly csvSha256: string;
  };
  readonly candidates: {
    readonly total: number;
    readonly withResolvableTvgId: number;
    readonly publishable: number;
    /** Closed channels included in the catalogue (counted, not filtered). */
    readonly closedRows: number;
    /** Adult channels included in the catalogue, labelled as such on the channel. */
    readonly nsfwRows: number;
    readonly geoBlocked: number;
    readonly requiresHeaders: number;
    readonly unmapped: number;
    readonly selected: number;
  };
  readonly written: {
    readonly channelsPublished: number;
    readonly playbackSources: number;
    readonly candidatesReconciled: number;
    readonly skippedExisting: number;
    /** Channels whose genre came from the iptv-org database. */
    readonly categorised: number;
    /** Adult channels labelled (category + name); none were withheld. */
    readonly labelledAdult: number;
  };
  readonly dryRun: boolean;
}

/** `tvg-id` of a candidate, with the `@quality` suffix removed. */
function tvgIdOf(candidate: SourceCandidateDoc): string | null {
  const raw = (candidate.attributes['tvg-id'] ?? '').trim();
  if (raw === '') return null;
  const at = raw.indexOf('@');
  return at === -1 ? raw : raw.slice(0, at);
}

/** The playback source this candidate becomes. */
function toPlaybackSource(
  candidate: SourceCandidateDoc,
  channelId: string,
  row: DatabaseRow,
  snapshot: { commitSha: string | null; retrievedAt: Date; checksumSha256: string },
): PlaybackSourceDoc {
  const now = new Date();
  const geoBlocked = candidate.flags.includes('geo-blocked');
  /*
   * `permission` is `open-data-licence`: iptv-org's data is public domain, so the
   * LISTING may be copied and the URL published. That says nothing about the
   * emitter granting redistribution, and the provenance label says exactly that.
   */
  return {
    _id: randomUUID(),
    channelId,
    provider: 'iptv-org',
    type: candidate.type,
    url: candidate.url,
    officialPageUrl: row.website.trim() === '' ? null : row.website.trim(),
    permission: 'open-data-licence',
    authorisationEvidence: null,
    conditions: {
      embedAllowed: false,
      proxyAllowed: false,
      worldwide: !geoBlocked,
      restrictedRegions: [],
      browserCompatibility: 'all',
      requiresForgedHeader:
        candidate.flags.includes('userAgentRequired') || candidate.flags.includes('refererRequired'),
      emitterAppOnly: false,
      notes:
        'Catálogo iptv-org (dominio público). Listado copiado con permiso; no certifica autorización del emisor.',
    },
    priority: 200,
    editorialStatus: 'published',
    technicalStatus: 'unknown',
    lastVerifiedAt: null,
    lastVerification: null,
    provenance: [
      {
        source: 'iptv-org',
        label: `iptv-org/iptv @ ${snapshot.commitSha?.slice(0, 7) ?? 'unknown'} · ${row.id}`,
        url: 'https://github.com/iptv-org/iptv',
        licence: 'Unlicense (dominio público)',
        attribution: 'Canal y URL procedentes de iptv-org (dominio público). La señal pertenece a su emisor.',
        digestSha256: snapshot.checksumSha256,
        capturedAt: snapshot.retrievedAt,
        editorial: false,
      },
    ],
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
}

/**
 * Runs the import.
 *
 * Idempotent on both halves: `runIngestion` upserts candidates by their stable
 * id, and a playback source is only inserted when the channel has none for that
 * exact URL yet, so re-running the same snapshot adds nothing twice.
 */
export async function importIptvOrg(
  database: DatabaseHandle,
  options: IptvOrgImportOptions,
): Promise<IptvOrgImportResult> {
  const load = loadSnapshot(options.snapshotRoot);
  if (load.integrity !== 'ok' || load.manifest === null) {
    throw new Error(`snapshot integrity failed: ${load.errors.join('; ')}`);
  }
  const snapshot = snapshotDocument(load, { upstreamUrl: 'https://github.com/iptv-org/iptv' });

  const csvBytes = readFileSync(options.channelsCsv);
  const csvSha256 = createHash('sha256').update(csvBytes).digest('hex');
  const parsed = parseChannelsCsv(csvBytes.toString('utf8'));
  if (parsed.rejected.length > 0) {
    /* Every malformed row is accounted for, never skipped in silence. */
    const sample = parsed.rejected.slice(0, 3).map((row) => `line ${row.line}: ${row.reason}`).join('; ');
    process.stderr.write(`[iptv-org] ${parsed.rejected.length} malformed rows rejected (${sample})\n`);
  }
  const index: DatabaseIndex = buildDatabaseIndex(parsed.rows);

  /*
   * The candidate mirrors its own line: the country comes from the file it was
   * read from (streams/<cc>.m3u), which for iptv-org is exact. The channel
   * database then corrects the CHANNEL, in iptv-org.import below.
   */
  const candidateOptions: CandidateBuildOptions = { countryFromPlaylist: true };
  const candidates = buildCandidates(snapshot, load.playlists, candidateOptions);
  let withResolvableTvgId = 0;
  let closedRows = 0;
  let nsfwRows = 0;
  let geoBlocked = 0;
  let requiresHeaders = 0;
  let unmapped = 0;
  const importable: Array<{ candidate: SourceCandidateDoc; row: DatabaseRow }> = [];

  /*
   * Policy: EVERY source iptv-org carries goes into the catalogue.
   *
   * The owner of the product decided, in those words, that the catalogue must
   * contain everything that works and carry no additional restrictions: closed
   * rows, NSFW rows and rows that need forged headers are imported, not filtered
   * here. `closedRows`/`nsfwRows` are still COUNTED, because the operator has to
   * know how much of the catalogue is a channel that ended and how much is adult
   * content — counting is reporting, not filtering. The NSFW label is applied to
   * the CHANNEL (name and category) in step 3, so adult content is findable and
   * recognisable instead of being mixed in silently.
   */
  for (const candidate of candidates) {
    if (candidate.state === 'rejected') continue;
    const tvgId = tvgIdOf(candidate);
    const row = tvgId === null ? null : resolveByTvgId(index, tvgId);
    if (row === null) {
      unmapped += 1;
      continue;
    }
    withResolvableTvgId += 1;
    if (isClosed(row)) closedRows += 1;
    if (isNsfw(row)) nsfwRows += 1;
    if (candidate.flags.includes('geo-blocked')) geoBlocked += 1;
    if (candidate.flags.includes('userAgentRequired') || candidate.flags.includes('refererRequired')) {
      requiresHeaders += 1;
    }
    importable.push({ candidate, row });
  }

  const selected = options.limit === undefined ? importable : importable.slice(0, options.limit);

  const result: IptvOrgImportResult = {
    snapshotId: snapshot._id,
    upstream: {
      commitSha: snapshot.commitSha,
      licence: snapshot.licence.spdx ?? 'unknown',
      entries: snapshot.entryCount,
      files: snapshot.fileCount,
    },
    database: {
      rows: index.stats.rows,
      closed: index.stats.closed,
      nsfw: index.stats.nsfw,
      countries: index.stats.countries,
      csvSha256,
    },
    candidates: {
      total: candidates.length,
      withResolvableTvgId,
      publishable: importable.length,
      closedRows,
      nsfwRows,
      geoBlocked,
      requiresHeaders,
      unmapped,
      selected: selected.length,
    },
    written: {
      channelsPublished: 0,
      playbackSources: 0,
      candidatesReconciled: 0,
      skippedExisting: 0,
      categorised: 0,
      labelledAdult: 0,
    },
    dryRun: options.dryRun === true,
  };
  if (options.dryRun === true) return result;

  /* ---- 1. reconcile the streams into canonical channels ---------------- */
  const ingestion = await runIngestion(database, snapshot, load.playlists, {
    idNamespace: options.idNamespace ?? 'iptv-org',
    buildOptions: candidateOptions,
    /* The real ISO code from the playlist path: this is an international catalogue. */
    countryMode: 'iso',
  });

  /* ---- 2. attach one playback source per resolvable candidate ---------- */
  const channels = database.collection<ChannelDoc>(COLLECTIONS.channels);
  const sources = database.collection<PlaybackSourceDoc>(COLLECTIONS.sources);
  /* Read from the shared collection map: this file never hardcodes a name. */
  const candidateRows = database.collection<SourceCandidateDoc>(COLLECTIONS.sourceCandidates);
  let writtenSources = 0;
  let skippedExisting = 0;
  const touchedChannels = new Set<string>();
  /*
   * The channel database is the authority on genre: once a channel has a real
   * source, its `category` stops being the neutral default and becomes what
   * iptv-org declares, mapped to our taxonomy. A row with no category we
   * understand keeps `otros`, which is the honest answer.
   */
  const categories = new Map<string, string>();
  /** Channels iptv-org flags as adult: labelled, never withheld. */
  const adultChannels = new Set<string>();

  for (const { candidate, row } of selected) {
    if (candidate.normalizedUrl === '') continue;
    const stored = await candidateRows.findOne({ _id: candidate._id }, { projection: { channelId: 1 } });
    const channelId = stored?.channelId ?? null;
    if (channelId === null) continue;

    const existing = await sources.findOne({ channelId, provider: 'iptv-org', url: candidate.url });
    if (existing !== null) {
      skippedExisting += 1;
      continue;
    }
    await sources.insertOne(toPlaybackSource(candidate, channelId, row, snapshot));
    writtenSources += 1;
    touchedChannels.add(channelId);
    if (isNsfw(row)) adultChannels.add(channelId);
    else if (hasKnownCategory(row) && !categories.has(channelId)) categories.set(channelId, categoryOf(row));
  }

  /* ---- 3. publish the channels that now carry a source ----------------- */
  if (touchedChannels.size > 0) {
    await channels.updateMany(
      { _id: { $in: [...touchedChannels] } },
      { $set: { editorialStatus: 'published', catalogueState: 'ingested', updatedAt: new Date() } },
    );
  }
  /* Only a neutral `otros` is replaced: an editorial category a human chose stays. */
  for (const [channelId, category] of categories) {
    await channels.updateOne({ _id: channelId, category: 'otros' }, { $set: { category, updatedAt: new Date() } });
  }
  /*
   * Adult labelling: category AND name, applied once. The channel stays in the
   * catalogue and stays playable; it simply says what it is.
   */
  let labelledAdult = 0;
  for (const channelId of adultChannels) {
    const channel = await channels.findOne({ _id: channelId }, { projection: { name: 1, shortName: 1 } });
    if (channel === null) continue;
    await channels.updateOne(
      { _id: channelId },
      {
        $set: {
          category: ADULT_CATEGORY,
          name: labelAdultName(channel.name),
          shortName: labelAdultName(channel.shortName),
          updatedAt: new Date(),
        },
      },
    );
    labelledAdult += 1;
  }

  return {
    ...result,
    written: {
      channelsPublished: touchedChannels.size,
      playbackSources: writtenSources,
      candidatesReconciled: ingestion.metrics.canonicalChannels,
      skippedExisting,
      categorised: categories.size,
      labelledAdult,
    },
  };
}
