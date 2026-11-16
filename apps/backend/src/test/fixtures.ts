/**
 * Fixtures: records built through the **real services**, never inserted by hand,
 * so a test can never pass against a shape the application does not produce.
 */
import { randomUUID } from 'node:crypto';
import type { PlaybackSourceDoc, ChannelDoc } from '../infrastructure/schema.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { TestHarness } from './harness.js';
import { AuthorizationRepository } from '../modules/providers/authorization.repository.js';
import type { AuthorizationRecord } from '../modules/providers/authorization.js';

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
  /**
   * 02C authorization posture. `own-emitter` (default) records a written-licence
   * decision for our own fixture emitter, so the two-sided gate has something to
   * allow. `none` records nothing — the healthy-but-unresolved case — while
   * `unresolved`/`restricted` record that verdict explicitly.
   */
  readonly authorization?: 'own-emitter' | 'none' | 'unresolved' | 'restricted';
}

/** Records the fixture's own-emitter decision, or the requested negative posture. */
async function recordFixtureAuthorization(
  harness: TestHarness,
  source: PlaybackSourceDoc,
  spec: SourceSpec,
): Promise<void> {
  const posture = spec.authorization ?? 'own-emitter';
  const repository = new AuthorizationRepository(harness.context.database);

  /*
   * `createSource` goes through the real service, and that service now records an
   * operator decision for every source it creates. A test that wants the
   * healthy-but-no-right case must therefore REMOVE that decision; skipping our
   * own write is not enough, because the service's record would still be there
   * and the source would play.
   */
  if (posture === 'none') {
    await repository.deleteForSourceId(source._id);
    return;
  }

  const permitted = posture === 'own-emitter';
  /*
   * The admin service already recorded a decision. Keep it for the default
   * posture, but for an explicit negative posture the service's permitted record
   * must be removed first, otherwise the requested verdict never takes effect and
   * the test silently asserts the opposite of what it says.
   */
  const existing = await repository.forSourceId(source._id);
  if (existing !== null) {
    if (permitted) return;
    await repository.deleteForSourceId(source._id);
  }
  /*
   * The class follows what the source actually IS, exactly as the gate expects:
   * an `external` source can only ever be a link, an embed can only be an embed,
   * and only a real in-app stream can be direct playback. Recording
   * `permitted-direct-playback` for an external link would be a lie the gate
   * rejects, and recording it would hide a real behaviour.
   */
  const isExternal = source.type === 'external';
  const isEmbed = source.type === 'youtube' || source.type === 'official-embed';
  const permittedVerdict = isExternal
    ? 'external-link-only'
    : isEmbed
      ? 'permitted-official-embed'
      : 'permitted-direct-playback';
  const record: AuthorizationRecord = {
    _id: `fixture:${source._id}`,
    operatorId: 'fixture-emitter',
    sourceUrl: source.url ?? `fixture:${source._id}`,
    providerKind: 'broadcaster',
    verdict: permitted ? permittedVerdict : posture,
    basis: permitted ? 'written-licence' : 'published-terms',
    quotedClause: permitted ? null : 'Fixture: derecho denegado o no resuelto.',
    clauseUrl: permitted ? 'https://fixture.test/licencia-firmada' : null,
    method: permitted ? (isExternal ? 'external-link' : isEmbed ? 'official-embed' : 'direct-playback') : 'none',
    publicationScope: permitted ? (isExternal ? 'external-only' : 'in-app') : 'none',
    territory: { allowed: [], restricted: [], worldwide: spec.worldwide ?? true, geoBlocked: false },
    restrictions: [],
    attribution: permitted ? 'Fixture' : null,
    discovery: {
      upstream: null,
      snapshotId: null,
      path: null,
      line: null,
      sourceUrl: source.url,
      documentUrl: permitted ? 'https://fixture.test/licencia-firmada' : null,
      retrievedAt: null,
    },
    lifecycle: 'active',
    expiresAt: null,
    validationTimestamp: null,
    authorizationTimestamp: new Date('2026-11-16T12:00:00.000Z'),
    reviewStatus: 'reviewed',
    notes: null,
  };
  await new AuthorizationRepository(harness.context.database).record(record);
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
  /*
   * 02C: a source is playable only with a recorded right, so a fixture that
   * represents our own emitter also records the decision, exactly as an
   * operator would. `authorization: 'none'` is how tests build the case the
   * mission cares about: a healthy stream with no right at all.
   */
  await recordFixtureAuthorization(harness, created, spec);
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
