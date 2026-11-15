/**
 * Guide ingestion: fetches an *enabled* guide source, normalises it and
 * reconciles it against our canonical channels.
 *
 * Reconciliation is explicit and invertible: a guide's upstream channel id is
 * matched to one of our channels through the `epg` namespace alias, and every
 * unmapped upstream channel is reported rather than guessed. Ingestion never
 * creates a channel.
 */
import type { EpgIngestResult } from '@tdt/contracts';
import { randomUUID } from 'node:crypto';
import type { EgressOptions } from '../../infrastructure/egress.js';
import { fetchWithPolicy } from '../../infrastructure/egress.js';
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { ChannelDoc, EpgSourceDoc, JobRunDoc } from '../../infrastructure/schema.js';
import { parseJsonGuide, parseXmltv, type ParseResult } from './epg.parsers.js';
import { EpgService } from './epg.service.js';

export interface ReconciliationReport {
  readonly upstreamChannels: string[];
  readonly matched: string[];
  readonly unmapped: string[];
}

export class EpgIngestionService {
  constructor(
    private readonly database: DatabaseHandle,
    private readonly epg: EpgService,
  ) {}

  private epgSources() {
    return this.database.collection<EpgSourceDoc>(COLLECTIONS.epgSources);
  }

  private channels() {
    return this.database.collection<ChannelDoc>(COLLECTIONS.channels);
  }

  /** Maps upstream guide ids to our channels via the `epg` alias namespace. */
  async reconcile(upstreamChannels: readonly string[]): Promise<ReconciliationReport> {
    if (upstreamChannels.length === 0) {
      return { upstreamChannels: [], matched: [], unmapped: [] };
    }
    const docs = await this.channels()
      .find({ 'aliases.namespace': 'epg', 'aliases.value': { $in: [...upstreamChannels] } })
      .toArray();
    const byUpstream = new Map<string, ChannelDoc>();
    for (const channel of docs) {
      for (const alias of channel.aliases) {
        if (alias.namespace === 'epg' && upstreamChannels.includes(alias.value)) {
          byUpstream.set(alias.value, channel);
        }
      }
    }
    return {
      upstreamChannels: [...upstreamChannels],
      matched: [...byUpstream.keys()],
      unmapped: upstreamChannels.filter((id) => !byUpstream.has(id)),
    };
  }

  /** Parses a guide payload according to the source kind. Pure. */
  static parse(source: Pick<EpgSourceDoc, 'kind'>, payload: string, timezone: string): ParseResult {
    if (source.kind === 'xmltv') {
      return parseXmltv(payload, timezone);
    }
    if (source.kind === 'json-tdtchannels') {
      return parseJsonGuide(JSON.parse(payload) as unknown);
    }
    return { events: [], rejected: 0, channels: [] };
  }

  /**
   * Runs one source. The run record is always written, success or failure, so a
   * silent guide outage is impossible.
   */
  async runSource(sourceId: string, egress: EgressOptions, triggeredBy: string): Promise<EpgIngestResult> {
    const runId = randomUUID();
    const source = await this.epgSources().findOne({ _id: sourceId });
    const startedAt = new Date();
    const fail = async (message: string): Promise<EpgIngestResult> => {
      await this.epgSources().updateOne(
        { _id: sourceId },
        { $set: { lastRunAt: startedAt, lastRunStatus: 'failed', lastRunProgrammes: 0, updatedAt: new Date() } },
      );
      await this.database.collection<JobRunDoc>(COLLECTIONS.jobRuns).insertOne({
        _id: runId,
        job: `epg:${source?.name ?? sourceId}`,
        status: 'failed',
        startedAt,
        finishedAt: new Date(),
        message,
        details: { sourceId, triggeredBy },
      });
      return {
        sourceId,
        runId,
        status: 'failed',
        programmes: 0,
        channelsMatched: 0,
        rejected: 0,
        message,
      };
    };

    if (!source) return fail('Fuente de guía no encontrada.');
    if (!source.ingestionEnabled) return fail('La ingesta está deshabilitada para esta fuente.');
    if (!source.url) return fail('La fuente no tiene URL de descarga.');

    let parsed: ParseResult;
    try {
      const fetched = await fetchWithPolicy(source.url, { ...egress, maxBytes: 32 * 1024 * 1024 });
      if (!fetched.ok || fetched.body === null) {
        return fail(`HTTP ${fetched.status} al descargar la guía.`);
      }
      parsed = EpgIngestionService.parse(source, fetched.body, 'Europe/Madrid');
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }

    const report = await this.reconcile(parsed.channels);
    const channels = await this.channels()
      .find({ 'aliases.namespace': 'epg', 'aliases.value': { $in: report.matched } })
      .toArray();
    const byAlias = new Map<string, ChannelDoc>();
    for (const channel of channels) {
      for (const alias of channel.aliases) {
        if (alias.namespace === 'epg') byAlias.set(alias.value, channel);
      }
    }

    let written = 0;
    let rejected = parsed.rejected;
    const perChannel = new Map<string, typeof parsed.events>();
    for (const event of parsed.events) {
      const list = perChannel.get(event.upstreamChannel) ?? [];
      list.push(event);
      perChannel.set(event.upstreamChannel, list);
    }
    for (const [upstreamId, events] of perChannel) {
      const channel = byAlias.get(upstreamId);
      if (!channel) continue;
      const result = await this.epg.upsertChannelGuide(
        channel._id,
        source._id,
        events.map((event) => ({
          title: event.title,
          description: event.description,
          genre: event.genre,
          coverUrl: event.coverUrl,
          start: event.start,
          end: event.end,
          externalKey: event.externalKey,
        })),
      );
      written += result.written;
      rejected += result.rejected;
      await this.channels().updateOne(
        { _id: channel._id },
        { $set: { epg: { sourceId: source._id, externalId: upstreamId } } },
      );
    }

    const finishedAt = new Date();
    await this.epgSources().updateOne(
      { _id: sourceId },
      {
        $set: {
          lastRunAt: finishedAt,
          lastRunStatus: 'ok',
          lastRunProgrammes: written,
          updatedAt: finishedAt,
        },
      },
    );
    await this.database.collection<JobRunDoc>(COLLECTIONS.jobRuns).insertOne({
      _id: runId,
      job: `epg:${source.name}`,
      status: 'ok',
      startedAt,
      finishedAt,
      message: null,
      details: {
        triggeredBy,
        programmes: written,
        rejected,
        channelsMatched: report.matched.length,
        unmapped: report.unmapped.length,
      },
    });
    return {
      sourceId,
      runId,
      status: 'ok',
      programmes: written,
      channelsMatched: report.matched.length,
      rejected,
      message: null,
    };
  }

  /** Scheduled entry point: runs every enabled source, one at a time. */
  async runAll(egress: EgressOptions): Promise<EpgIngestResult[]> {
    const sources = await this.epgSources().find({ ingestionEnabled: true, status: 'published' }).toArray();
    const results: EpgIngestResult[] = [];
    for (const source of sources) {
      results.push(await this.runSource(source._id, egress, 'scheduled'));
    }
    return results;
  }
}
