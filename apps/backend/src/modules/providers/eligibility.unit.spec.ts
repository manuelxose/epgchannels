/**
 * The eligibility gate: fail-closed, positive and negative.
 *
 * The central test is `a healthy stream with unresolved authorization is NOT
 * playable`: the fixture's stream answers 200 with a valid HLS manifest
 * (`technicalStatus: 'ok'`), and it is still refused because no right is
 * recorded. Removing the gate makes it fail — that is the property under test.
 *
 * Positive tests use our own fixtures (a written licence we could actually hold),
 * never a broadcaster whose published terms were researched.
 */
import { describe, expect, it } from 'vitest';
import {
  decideEligibility,
  coversTerritory,
  isPubliclyPlayable,
} from './eligibility.js';
import {
  unresolvedRecord,
  type AuthorizationRecord,
  type DiscoveryEvidence,
  type EligibilityClass,
} from './authorization.js';
import { classifyHost, kindMayAuthorizePlayback, PROVIDER_KIND_FACTS } from './provider-kinds.js';
import { decideSourceEligibility } from './source-eligibility.js';
import {
  createDefaultAdapterRegistry,
  DuplicateAdapterError,
  ProviderAdapterRegistry,
  type ProviderAdapter,
} from './adapter.registry.js';
import type { PublicationContext } from '../playback/publication-policy.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');

const DISCOVERY: DiscoveryEvidence = {
  upstream: 'iptv-org',
  snapshotId: 'iptv-org-20261116T145323Z',
  path: 'es.m3u',
  line: 42,
  sourceUrl: 'https://example.test/live/master.m3u8',
  documentUrl: null,
  retrievedAt: NOW,
};

function record(overrides: Partial<AuthorizationRecord> = {}): AuthorizationRecord {
  return {
    _id: 'fixture:https://example.test/live/master.m3u8',
    operatorId: 'fixture-operator',
    sourceUrl: 'https://example.test/live/master.m3u8',
    providerKind: 'broadcaster_cdn',
    verdict: 'permitted-direct-playback',
    basis: 'written-licence',
    quotedClause: null,
    clauseUrl: 'https://example.test/licence-agreement.pdf',
    method: 'direct-playback',
    publicationScope: 'in-app',
    territory: { allowed: ['ES'], restricted: [], worldwide: false, geoBlocked: false },
    restrictions: [],
    attribution: 'Fixture Operator',
    discovery: DISCOVERY,
    lifecycle: 'active',
    expiresAt: null,
    validationTimestamp: NOW,
    authorizationTimestamp: NOW,
    reviewStatus: 'reviewed',
    notes: null,
    ...overrides,
  };
}

/** The publication context the existing policy receives for a healthy source. */
function healthyContext(overrides: Partial<PublicationContext> = {}): PublicationContext {
  return {
    channelStatus: 'published',
    sourceStatus: 'published',
    permission: 'emitter-public-stream' as PublicationContext['permission'],
    technicalStatus: 'ok',
    conditions: { requiresForgedHeader: false, emitterAppOnly: false },
    ...overrides,
  };
}

describe('eligibility gate — fail closed', () => {
  it('CENTRAL NEGATIVE: a healthy HLS stream with unresolved authorization is NOT playable', () => {
    const unresolved = unresolvedRecord(
      'rtve',
      'https://rtvelivestream.rtve.es/live/master.m3u8',
      'broadcaster_cdn',
      DISCOVERY,
    );

    const decision = decideEligibility({ record: unresolved, now: NOW });

    expect(decision.eligible).toBe(false);
    expect(decision.verdict).toBe('unresolved');

    // The stream itself is healthy: availability is a different axis and must not
    // rescue the verdict.
    const source = decideSourceEligibility({
      publication: healthyContext({ technicalStatus: 'ok' }),
      authorization: unresolved,
      type: 'hls',
      now: NOW,
    });
    expect(source.playable).toBe(false);
    if (!source.playable) {
      expect(source.publicationReason).toBeNull(); // the old policy allowed it
      expect(source.authorizationReason).toBe('authorization-unresolved');
    }
  });

  it('CENTRAL NEGATIVE: a healthy stream with restricted authorization is NOT playable', () => {
    const restricted = record({
      operatorId: 'atresmedia',
      verdict: 'restricted',
      basis: 'published-terms',
      quotedClause: '«Queda prohibido establecer frames o marcos de cualquier tipo…»',
      clauseUrl: 'https://statics.atresmedia.com/sites/assets/legal/legal.html',
      method: 'none',
      publicationScope: 'none',
      sourceUrl: 'https://example.test/atres/live/master.m3u8',
    });

    const source = decideSourceEligibility({
      publication: healthyContext({ technicalStatus: 'ok' }),
      authorization: restricted,
      type: 'hls',
      now: NOW,
    });

    expect(source.playable).toBe(false);
    if (!source.playable) expect(source.authorizationReason).toBe('authorization-restricted');
  });

  it('no record at all is denied', () => {
    const decision = decideEligibility({ record: null, now: NOW });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reason).toBe('no-authorization-record');
  });

  it('a shortener can never authorize, even with an "approved" record', () => {
    const forged = record({
      providerKind: 'shortener',
      verdict: 'permitted-direct-playback',
      basis: 'written-licence',
      sourceUrl: 'https://jmp2.uk/abc123',
    });
    const decision = decideEligibility({ record: forged, now: NOW });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reason).toBe('provider-kind-cannot-authorize');
  });

  it('a static CDN can never authorize', () => {
    const forged = record({ providerKind: 'cdn' });
    const decision = decideEligibility({ record: forged, now: NOW });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reason).toBe('provider-kind-cannot-authorize');
  });

  it('a catalogue reference can never authorize', () => {
    const forged = record({ providerKind: 'catalogue_reference' });
    const decision = decideEligibility({ record: forged, now: NOW });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reason).toBe('provider-kind-cannot-authorize');
  });

  it('a permitted verdict without a citable right is denied (green field, no evidence)', () => {
    const baseless = record({ basis: 'none', clauseUrl: null, quotedClause: null });
    const decision = decideEligibility({ record: baseless, now: NOW });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reason).toBe('authorization-missing-quote');
  });

  it('published terms without a quoted clause are denied', () => {
    const unquoted = record({ basis: 'published-terms', quotedClause: null });
    const decision = decideEligibility({ record: unquoted, now: NOW });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reason).toBe('authorization-missing-quote');
  });

  it('an expired decision is denied', () => {
    const expired = record({ expiresAt: new Date('2026-01-01T00:00:00.000Z') });
    const decision = decideEligibility({ record: expired, now: NOW });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reason).toBe('authorization-expired');
  });

  it('a non-active lifecycle is denied', () => {
    for (const lifecycle of ['draft', 'superseded', 'expired'] as const) {
      const decision = decideEligibility({ record: record({ lifecycle }), now: NOW });
      expect(decision.eligible).toBe(false);
      if (!decision.eligible) expect(decision.reason).toBe('authorization-not-active');
    }
  });

  it('external-link-only is not in-app playback', () => {
    const linkOnly = record({
      verdict: 'external-link-only',
      method: 'external-link',
      publicationScope: 'external-only',
      basis: 'written-licence',
    });
    expect(decideEligibility({ record: linkOnly, now: NOW }).eligible).toBe(false);
    expect(decideEligibility({ record: linkOnly, now: NOW, forInAppPlayback: false }).eligible).toBe(true);
  });

  it('rejects an official-embed record presented as direct playback', () => {
    const mixed = record({ verdict: 'permitted-official-embed', method: 'direct-playback' });
    const decision = decideEligibility({ record: mixed, now: NOW });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reason).toBe('authorization-method-mismatch');
  });
});

describe('eligibility gate — positives (fixture rights only)', () => {
  /*
   * These fixtures carry an explicit `requestedTerritory: 'ES'` because the gate
   * now denies a territory-limited right when the caller names no territory (a
   * geo-restricted right must not become playable by not asking). See the
   * "territory-less request cannot dodge" tests below.
   */
  it('a written licence for our own fixture is playable', () => {
    const decision = decideEligibility({ record: record(), now: NOW, requestedTerritory: 'ES' });
    expect(decision.eligible).toBe(true);
    if (decision.eligible) {
      expect(decision.verdict).toBe('permitted-direct-playback');
      expect(decision.method).toBe('direct-playback');
    }
  });

  it('a healthy fixture source with a written licence is playable end to end', () => {
    const result = decideSourceEligibility({
      publication: healthyContext(),
      authorization: record(),
      type: 'hls',
      now: NOW,
      requestedTerritory: 'ES',
    });
    expect(result.playable).toBe(true);
  });

  it('YouTube embed is permitted as an official embed under platform terms', () => {
    const youtube = record({
      operatorId: 'youtube',
      providerKind: 'platform',
      verdict: 'permitted-official-embed',
      basis: 'published-terms',
      quotedClause: 'La integración IFrame pública de YouTube permite insertar el reproductor oficial.',
      clauseUrl: 'https://developers.google.com/youtube/terms/api-services-terms-of-service',
      method: 'official-embed',
      publicationScope: 'in-app',
      territory: { allowed: [], restricted: [], worldwide: true, geoBlocked: false },
    });
    const result = decideSourceEligibility({
      publication: healthyContext(),
      authorization: youtube,
      type: 'youtube',
      now: NOW,
    });
    expect(result.playable).toBe(true);
  });

  it('the YouTube grant never authorises the broadcaster HLS manifest', () => {
    const youtube = record({
      operatorId: 'youtube',
      providerKind: 'platform',
      verdict: 'permitted-official-embed',
      basis: 'published-terms',
      quotedClause: 'insert',
      method: 'official-embed',
      publicationScope: 'in-app',
    });
    const result = decideSourceEligibility({
      publication: healthyContext(),
      authorization: youtube,
      type: 'hls',
      now: NOW,
    });
    expect(result.playable).toBe(false);
  });

  it('a permitted source is still denied when the publication policy refuses it', () => {
    const result = decideSourceEligibility({
      publication: healthyContext({ technicalStatus: 'blocked' }),
      authorization: record(),
      type: 'hls',
      now: NOW,
      requestedTerritory: 'ES',
    });
    expect(result.playable).toBe(false);
    if (!result.playable) expect(result.publicationReason).toBe('disallowed-integration');
  });
});

describe('territory scope', () => {
  it('a territory-less request cannot dodge a geo-restricted right', () => {
    const geo = record({
      territory: { allowed: ['ES'], restricted: [], worldwide: false, geoBlocked: true },
    });
    // Omitting the territory must not turn a geo-restricted right into a playable one.
    const omitted = decideEligibility({ record: geo, now: NOW });
    expect(omitted.eligible).toBe(false);
    if (!omitted.eligible) expect(omitted.reason).toBe('authorization-restricted');

    // …and the same right with no allowed territory at all is equally unplayable.
    const geoNoAllow = record({ territory: { allowed: [], restricted: [], worldwide: false, geoBlocked: true } });
    expect(decideEligibility({ record: geoNoAllow, now: NOW }).eligible).toBe(false);
  });

  it('a territory-less request cannot dodge a country-limited right either', () => {
    const limited = record({ territory: { allowed: ['ES'], restricted: [], worldwide: false, geoBlocked: false } });
    expect(decideEligibility({ record: limited, now: NOW }).eligible).toBe(false);
    // Naming the covered territory is fine.
    expect(decideEligibility({ record: limited, now: NOW, requestedTerritory: 'ES' }).eligible).toBe(true);
  });

  it('a worldwide right is playable with or without a named territory', () => {
    const worldwide = record({ territory: { allowed: [], restricted: [], worldwide: true, geoBlocked: false } });
    expect(decideEligibility({ record: worldwide, now: NOW }).eligible).toBe(true);
    expect(decideEligibility({ record: worldwide, now: NOW, requestedTerritory: 'MX' }).eligible).toBe(true);
  });

  it('a right recorded for ES does not cover MX', () => {
    const decision = decideEligibility({ record: record(), now: NOW, requestedTerritory: 'MX' });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reason).toBe('authorization-restricted');
  });

  it('a geo-blocked record with no allowed territory covers nothing', () => {
    const geo = record({ territory: { allowed: [], restricted: [], worldwide: false, geoBlocked: true } });
    expect(coversTerritory(geo, 'ES')).toBe(false);
  });

  it('a restricted territory is excluded even when worldwide', () => {
    const rec = record({ territory: { allowed: [], restricted: ['DE'], worldwide: true, geoBlocked: false } });
    expect(coversTerritory(rec, 'DE')).toBe(false);
    expect(coversTerritory(rec, 'FR')).toBe(true);
  });
});

describe('provider kinds', () => {
  it('only grant-capable kinds may authorize', () => {
    const capable = (['shortener', 'cdn', 'catalogue_reference'] as const).map(kindMayAuthorizePlayback);
    expect(capable).toEqual([false, false, false]);
    expect(PROVIDER_KIND_FACTS.broadcaster.mayAuthorizePlayback).toBe(true);
    expect(PROVIDER_KIND_FACTS.platform.mayAuthorizePlayback).toBe(true);
  });

  it('classifies the measured snapshot hosts', () => {
    expect(classifyHost('https://jmp2.uk/xyz').kind).toBe('shortener');
    expect(classifyHost('https://cdn.jsdelivr.net/x/y.m3u8').kind).toBe('cdn');
    expect(classifyHost('https://rtvelivestream.rtve.es/live/master.m3u8').kind).toBe('broadcaster_cdn');
    expect(classifyHost('https://directes-tv-cat.3catdirectes.cat/x.m3u8').kind).toBe('broadcaster_cdn');
    expect(classifyHost('https://cdn1.etbon.eus/x.m3u8').kind).toBe('broadcaster_cdn');
  });

  it('a FAST playlist makes an unknown destination a fast_platform', () => {
    expect(classifyHost('https://unknown.test/a.m3u8', { upstreamPath: 'es_pluto.m3u' }).kind).toBe('fast_platform');
  });

  it('an unknown host reached through a catalogue falls back to catalogue_reference', () => {
    expect(classifyHost('https://unknown.test/a.m3u8', { upstream: 'iptv-org' }).kind).toBe('catalogue_reference');
  });
});

describe('adapter registry is extensible by registration', () => {
  function fixtureAdapter(id: string): ProviderAdapter {
    return {
      descriptor: {
        id,
        name: id,
        types: ['dash'],
        providerKinds: ['broadcaster'],
        requiresAuthorization: 'written-licence',
        grants: 'permitted-direct-playback',
        method: 'direct-playback',
        territoryScope: null,
        attribution: { required: false, notice: null },
        platform: null,
        description: 'test',
        enabled: true,
      },
      accepts: (type) => type === 'dash',
      verify: (r) => ({ satisfied: r.verdict === 'permitted-direct-playback', reason: null }),
    };
  }

  it('registers a new adapter without changing existing ones', () => {
    const registry = new ProviderAdapterRegistry();
    expect(registry.list()).toHaveLength(0);
    registry.register(fixtureAdapter('custom-dash'));
    expect(registry.list().map((d) => d.id)).toEqual(['custom-dash']);
    expect(registry.get('custom-dash')).toBeDefined();
    expect(registry.verify(record(), 'dash').satisfied).toBe(true);
  });

  it('refuses a duplicate adapter id', () => {
    const registry = new ProviderAdapterRegistry([fixtureAdapter('dup')]);
    expect(() => registry.register(fixtureAdapter('dup'))).toThrow(DuplicateAdapterError);
  });

  it('fails closed for an unregistered type', () => {
    const registry = createDefaultAdapterRegistry();
    const verdict = registry.verify(record(), 'dash');
    // broadcaster-direct covers hls+dash, so this one is satisfied…
    expect(verdict.satisfied).toBe(true);
    // …but a type no adapter claims is not.
    const empty = new ProviderAdapterRegistry();
    expect(empty.verify(record(), 'hls').satisfied).toBe(false);
  });

  it('the default registry declares the five required properties per adapter', () => {
    for (const descriptor of createDefaultAdapterRegistry().list()) {
      expect(descriptor.id.length).toBeGreaterThan(0);
      expect(descriptor.types.length).toBeGreaterThan(0);
      expect(descriptor.requiresAuthorization).toBeTruthy();
      expect(descriptor.grants).toBeTruthy();
      expect(descriptor.attribution).toBeDefined();
    }
  });
});

describe('the five classes are exhaustive and exclusive', () => {
  it('every verdict behaves consistently with its class', () => {
    const cases: Array<[EligibilityClass, boolean]> = [
      ['permitted-direct-playback', true],
      ['permitted-official-embed', true],
      ['external-link-only', false],
      ['restricted', false],
      ['unresolved', false],
    ];
    expect(cases).toHaveLength(5);
    for (const [verdict, expected] of cases) {
      const base = record({ verdict });
      const rec =
        verdict === 'external-link-only'
          ? { ...base, method: 'external-link' as const, publicationScope: 'external-only' as const }
          : verdict === 'permitted-official-embed'
            ? { ...base, method: 'official-embed' as const }
            : verdict === 'restricted' || verdict === 'unresolved'
              ? {
                  ...base,
                  method: 'none' as const,
                  publicationScope: 'none' as const,
                  basis: 'published-terms' as const,
                  quotedClause: 'no',
                  clauseUrl: 'https://example.test/legal',
                }
              : base;
      // A named territory: a territory-limited right denies a territory-less call.
      expect(decideEligibility({ record: rec, now: NOW, requestedTerritory: 'ES' }).eligible).toBe(expected);
    }
  });
});
