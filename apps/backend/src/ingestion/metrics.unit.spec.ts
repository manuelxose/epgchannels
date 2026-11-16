/**
 * Ingestion metrics — the shared shape every module imports.
 *
 * The accumulator must be deterministic and idempotent: a run is often rebuilt
 * from the same candidate list (retry after a partial write), so re-accumulating
 * must not double-count.
 */
import { describe, expect, it } from 'vitest';
import { accumulateMetrics, emptyMetrics, mergeMetrics } from './metrics.js';
import type { SourceCandidateDoc } from './provenance.js';

const RETRIEVED_AT = new Date('2026-11-16T14:53:23.231Z');

function candidate(overrides: Partial<SourceCandidateDoc>): SourceCandidateDoc {
  return {
    _id: 'c-0',
    channelId: null,
    snapshotId: 'a'.repeat(64),
    upstream: 'iptv-org',
    url: 'https://cdn.example/live.m3u8',
    normalizedUrl: 'https://cdn.example/live.m3u8',
    urlSha256: 'f'.repeat(64),
    type: 'hls',
    name: 'X',
    attributes: {},
    country: null,
    provider: null,
    groupTitle: null,
    language: null,
    quality: null,
    flags: [],
    provenance: {
      snapshotId: 'a'.repeat(64),
      upstream: 'iptv-org',
      upstreamPath: 'streams/es.m3u',
      line: 2,
      rawName: 'X',
      rawAttributes: {},
      retrievedAt: RETRIEVED_AT,
      checksumSha256: 'b'.repeat(64),
    },
    state: 'staging',
    rejectionReason: null,
    duplicateOf: null,
    createdAt: RETRIEVED_AT,
    updatedAt: RETRIEVED_AT,
    ...overrides,
  };
}

describe('accumulateMetrics', () => {
  it('produces the contract shape', () => {
    const metrics = emptyMetrics('iptv-org');
    expect(Object.keys(metrics).sort()).toEqual(
      [
        'byCountry', 'byGroup', 'byLanguage', 'candidatesPerChannel', 'canonicalChannels', 'duplicateCandidates',
        'durationMs', 'importedEntries', 'manualReview', 'newChannels', 'rejectedEntries', 'unmatchedEntries', 'upstream',
      ].sort(),
    );
    expect(metrics.candidatesPerChannel).toEqual({ avg: 0, max: 0, histogram: {} });
  });

  it('counts states, countries, languages and groups', () => {
    const metrics = accumulateMetrics({
      upstream: 'iptv-org',
      candidates: [
        candidate({ _id: 'c-1', channelId: 'ch-1', country: 'ES', language: 'es', groupTitle: 'Spain' }),
        candidate({ _id: 'c-2', channelId: 'ch-1', country: 'ES', language: 'es', groupTitle: 'Spain' }),
        candidate({ _id: 'c-3', channelId: 'ch-2', country: 'FR', groupTitle: 'France', state: 'unmatched' }),
        candidate({ _id: 'c-4', state: 'duplicate', duplicateOf: 'c-1', country: 'ES' }),
        candidate({ _id: 'c-5', state: 'rejected', rejectionReason: 'not-http' }),
      ],
      rejectedEntries: 2,
      durationMs: 1500,
    });
    expect(metrics).toMatchObject({
      upstream: 'iptv-org',
      importedEntries: 4,
      rejectedEntries: 3,
      duplicateCandidates: 1,
      unmatchedEntries: 1,
      canonicalChannels: 2,
      durationMs: 1500,
    });
    expect(metrics.byCountry).toEqual({ ES: 3, FR: 1 });
    expect(metrics.byLanguage).toEqual({ es: 2 });
    expect(metrics.byGroup).toEqual({ Spain: 2, France: 1 });
    expect(metrics.candidatesPerChannel).toEqual({ avg: 1.5, max: 2, histogram: { '1': 1, '2-5': 1 } });
  });

  it('is idempotent for a repeated candidate id', () => {
    const list = [candidate({ _id: 'c-1', channelId: 'ch-1', country: 'ES' }), candidate({ _id: 'c-1', channelId: 'ch-1', country: 'ES' })];
    const metrics = accumulateMetrics({ upstream: 'iptv-org', candidates: list });
    expect(metrics.importedEntries).toBe(1);
    expect(metrics.byCountry).toEqual({ ES: 1 });
  });

  it('treats an empty candidate list as empty metrics', () => {
    const metrics = accumulateMetrics({ upstream: 'free-tv', candidates: [] });
    expect(metrics.importedEntries).toBe(0);
    expect(metrics.candidatesPerChannel).toEqual({ avg: 0, max: 0, histogram: {} });
  });

  it('does not mutate its input', () => {
    const list = [candidate({ _id: 'c-1', channelId: 'ch-1' })];
    const snapshot = JSON.stringify(list);
    accumulateMetrics({ upstream: 'iptv-org', candidates: list });
    expect(JSON.stringify(list)).toBe(snapshot);
  });
});

describe('mergeMetrics', () => {
  it('sums counts across runs of the same upstream', () => {
    const a = accumulateMetrics({ upstream: 'iptv-org', candidates: [candidate({ _id: 'c-1', channelId: 'ch-1', country: 'ES' })], durationMs: 10 });
    const b = accumulateMetrics({ upstream: 'iptv-org', candidates: [candidate({ _id: 'c-2', channelId: 'ch-2', country: 'FR' })], durationMs: 20 });
    const merged = mergeMetrics('iptv-org', [a, b]);
    expect(merged.importedEntries).toBe(2);
    expect(merged.canonicalChannels).toBe(2);
    expect(merged.durationMs).toBe(30);
    expect(merged.byCountry).toEqual({ ES: 1, FR: 1 });
  });
});
