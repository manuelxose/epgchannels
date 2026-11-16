/**
 * The researched Spanish operators, through the real gate.
 *
 * These tests do not use invented fixtures: they run the transcribed operator
 * seeds from `operator-seeds.ts` (which mirror
 * `docs/tdt-api02/RESEARCH_EVIDENCE-02C.md`) through the actual eligibility
 * decision. The expected outcome is the milestone's whole point — zero Spanish
 * operators are playable, and that is correct rather than a failure.
 */
import { describe, expect, it } from 'vitest';
import { OPERATOR_SEEDS, YOUTUBE_PLATFORM_SEED, seedDiscovery } from './operator-seeds.js';
import { decideEligibility } from './eligibility.js';
import type { AuthorizationRecord } from './authorization.js';
import { classifyHost, hostOf } from './provider-kinds.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');

/** Builds the record the repository would persist for one seed. */
function recordFor(seed: (typeof OPERATOR_SEEDS)[number]): AuthorizationRecord {
  return {
    _id: `operator:${seed.operatorId}`,
    operatorId: seed.operatorId,
    sourceUrl: seed.clauseUrl ?? `operator:${seed.operatorId}`,
    providerKind: seed.providerKind,
    verdict: seed.verdict,
    basis: seed.basis,
    quotedClause: seed.quotedClause,
    clauseUrl: seed.clauseUrl,
    method: seed.method,
    publicationScope: seed.publicationScope,
    territory: { allowed: [], restricted: [], worldwide: false, geoBlocked: false },
    restrictions: seed.restrictions,
    attribution: seed.attribution,
    discovery: seedDiscovery(seed),
    lifecycle: 'active',
    expiresAt: null,
    validationTimestamp: null,
    authorizationTimestamp: seed.verdict === 'unresolved' ? null : NOW,
    reviewStatus: seed.reviewStatus,
    notes: seed.notes,
  };
}

describe('researched Spanish operators are all blocked', () => {
  it('no Spanish operator produces a permitted class', () => {
    const permitted = OPERATOR_SEEDS.filter(
      (seed) => seed.verdict === 'permitted-direct-playback' || seed.verdict === 'permitted-official-embed',
    );
    expect(permitted).toEqual([]);
  });

  it('every Spanish operator is denied by the gate, territory named or not', () => {
    for (const seed of OPERATOR_SEEDS) {
      const record = recordFor(seed);
      expect(decideEligibility({ record, now: NOW }).eligible, seed.operatorId).toBe(false);
      expect(decideEligibility({ record, now: NOW, requestedTerritory: 'ES' }).eligible, seed.operatorId).toBe(false);
    }
  });

  it('classifies each operator with the verdict the research recorded', () => {
    const expected: Record<string, string> = {
      rtve: 'unresolved',
      atresmedia: 'restricted',
      ccma: 'restricted',
      rtva: 'restricted',
      eitb: 'restricted',
      cacvsa: 'restricted',
      mediaset: 'unresolved',
      crtvg: 'unresolved',
      'pluto-tv': 'restricted',
      'rakuten-tv': 'unresolved',
      'samsung-tv-plus': 'unresolved',
      yowi: 'unresolved',
    };
    for (const seed of OPERATOR_SEEDS) {
      expect(seed.verdict, seed.operatorId).toBe(expected[seed.operatorId]);
    }
  });

  it('every restricted operator cites a literal clause and a URL', () => {
    for (const seed of OPERATOR_SEEDS.filter((s) => s.verdict === 'restricted')) {
      expect(seed.quotedClause, seed.operatorId).toBeTruthy();
      expect(seed.clauseUrl, seed.operatorId).toMatch(/^https:\/\//);
      expect(seed.basis, seed.operatorId).toBe('published-terms');
    }
  });

  it('operators with a licensing channel are escalatable, not permanently excluded', () => {
    const escalatable = OPERATOR_SEEDS.filter((s) => s.reviewStatus === 'requires-written-licence');
    expect(escalatable.map((s) => s.operatorId).sort()).toEqual(['atresmedia', 'cacvsa', 'ccma', 'eitb', 'rtva']);
    for (const seed of escalatable) {
      expect(seed.licensingChannel, seed.operatorId).toMatch(/^https:\/\//);
      // Blocked, but not a dead end: the verdict must not be a form of permanent exclusion.
      expect(seed.verdict).toBe('restricted');
    }
  });

  it('an unresolved operator records no authorization timestamp', () => {
    for (const seed of OPERATOR_SEEDS.filter((s) => s.verdict === 'unresolved')) {
      expect(recordFor(seed).authorizationTimestamp, seed.operatorId).toBeNull();
    }
  });

  it('every operator host in the measured set classifies as a grant-capable kind', () => {
    for (const seed of OPERATOR_SEEDS) {
      for (const host of seed.hosts) {
        const classification = classifyHost(`https://${host}/live/master.m3u8`, { upstream: 'iptv-org' });
        expect(classification.host, host).toBe(hostOf(`https://${host}/x`));
        expect(['broadcaster', 'broadcaster_cdn', 'fast_platform'], host).toContain(classification.kind);
      }
    }
  });
});

describe('the one permitted integration is platform-scoped', () => {
  it('YouTube is permitted-official-embed, never direct playback', () => {
    expect(YOUTUBE_PLATFORM_SEED.verdict).toBe('permitted-official-embed');
    expect(YOUTUBE_PLATFORM_SEED.method).toBe('official-embed');
    expect(YOUTUBE_PLATFORM_SEED.providerKind).toBe('platform');
  });

  it('the YouTube record passes the gate only as an official embed', () => {
    const record: AuthorizationRecord = {
      _id: 'operator:youtube',
      operatorId: 'youtube',
      sourceUrl: YOUTUBE_PLATFORM_SEED.clauseUrl,
      providerKind: YOUTUBE_PLATFORM_SEED.providerKind,
      verdict: YOUTUBE_PLATFORM_SEED.verdict,
      basis: YOUTUBE_PLATFORM_SEED.basis,
      quotedClause: YOUTUBE_PLATFORM_SEED.quotedClause,
      clauseUrl: YOUTUBE_PLATFORM_SEED.clauseUrl,
      method: YOUTUBE_PLATFORM_SEED.method,
      publicationScope: YOUTUBE_PLATFORM_SEED.publicationScope,
      territory: { allowed: [], restricted: [], worldwide: true, geoBlocked: false },
      restrictions: YOUTUBE_PLATFORM_SEED.restrictions,
      attribution: YOUTUBE_PLATFORM_SEED.attribution,
      discovery: {
        upstream: null,
        snapshotId: null,
        path: null,
        line: null,
        sourceUrl: null,
        documentUrl: YOUTUBE_PLATFORM_SEED.clauseUrl,
        retrievedAt: null,
      },
      lifecycle: 'active',
      expiresAt: null,
      validationTimestamp: null,
      authorizationTimestamp: NOW,
      reviewStatus: 'reviewed',
      notes: null,
    };
    const decision = decideEligibility({ record, now: NOW });
    expect(decision.eligible).toBe(true);
    if (decision.eligible) expect(decision.verdict).toBe('permitted-official-embed');
  });
});
