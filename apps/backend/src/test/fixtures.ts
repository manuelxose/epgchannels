/**
 * Fixtures: records built through the **real services**, never inserted by hand,
 * so a test can never pass against a shape the application does not produce.
 */
import { randomUUID } from 'node:crypto';
import type { PlaybackSourceDoc, ChannelDoc } from '../infrastructure/schema.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { TestHarness } from './harness.js';

const ACTOR = { type: 'system' as const, id: 'test-harness' };

export function provenance(label = 'Fixture editorial') {
  return [
    {
      source: 'fixture',
      label,
      url: null,
      licence: 'editorial',
      attribution: null,
      editorial: true,
    },
  ];
}

export interface ChannelSpec {
  readonly name: string;
  readonly slug?: string;
  readonly country?: string;
  readonly category?: string;
  readonly kind?: string;
  readonly status?: 'draft' | 'review' | 'published' | 'withdrawn';
  readonly description?: string;
}

export async function createChannel(harness: TestHarness, spec: ChannelSpec): Promise<ChannelDoc> {
  return harness.context.editorial.createChannel(
    {
      name: spec.name,
      ...(spec.slug ? { slug: spec.slug } : {}),
      country: spec.country ?? 'ES',
      category: (spec.category ?? 'generalista') as never,
      ...(spec.kind ? { kind: spec.kind as never } : {}),
      ...(spec.description ? { description: spec.description } : {}),
      ...(spec.status ? { editorialStatus: spec.status } : {}),
      provenance: provenance(),
    },
    ACTOR,
    randomUUID(),
  );
}

export interface SourceSpec {
  readonly permission?: 'emitter-public-stream' | 'emitter-embeddable' | 'official-player-only' | 'open-data-licence' | 'explicit-permission';
  readonly type?: 'hls' | 'dash' | 'youtube' | 'official-embed' | 'external';
  readonly url?: string | null;
  readonly officialPageUrl?: string | null;
  readonly status?: 'draft' | 'review' | 'published' | 'withdrawn';
  readonly technicalStatus?: 'ok' | 'unreachable' | 'http-error' | 'invalid-manifest' | 'unknown' | 'blocked';
  readonly requiresForgedHeader?: boolean;
  readonly emitterAppOnly?: boolean;
  readonly worldwide?: boolean;
  readonly priority?: number;
}

export async function createSource(
  harness: TestHarness,
  channelId: string,
  spec: SourceSpec = {},
): Promise<PlaybackSourceDoc> {
  const type = spec.type ?? 'hls';
  const created = await harness.context.sources.create(
    {
      channelId,
      provider: 'emitter:example.org',
      type,
      url: spec.url === undefined ? 'https://example.org/live/master.m3u8' : spec.url,
      officialPageUrl: spec.officialPageUrl === undefined ? 'https://example.org/directo' : spec.officialPageUrl,
      permission: spec.permission ?? 'emitter-public-stream',
      authorisationEvidence: 'Fixture: emisor propio del operador de pruebas.',
      conditions: {
        embedAllowed: true,
        proxyAllowed: false,
        worldwide: spec.worldwide ?? true,
        restrictedRegions: [],
        browserCompatibility: 'all',
        requiresForgedHeader: spec.requiresForgedHeader ?? false,
        emitterAppOnly: spec.emitterAppOnly ?? false,
        notes: null,
      },
      ...(spec.priority === undefined ? {} : { priority: spec.priority }),
      ...(spec.status ? { editorialStatus: spec.status } : {}),
    },
    ACTOR,
    randomUUID(),
  );
  if (spec.technicalStatus) {
    await harness.context.database
      .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
      .updateOne(
        { _id: created._id },
        { $set: { technicalStatus: spec.technicalStatus, lastVerifiedAt: new Date(), updatedAt: new Date() } },
      );
    return { ...created, technicalStatus: spec.technicalStatus, lastVerifiedAt: new Date() };
  }
  return created;
}

/** A published channel with one healthy, authorised HLS source. */
export async function publishedPlayableChannel(
  harness: TestHarness,
  name = 'Canal Publicado',
): Promise<ChannelDoc> {
  const channel = await createChannel(harness, { name, status: 'published' });
  await createSource(harness, channel._id, { technicalStatus: 'ok' });
  return channel;
}
