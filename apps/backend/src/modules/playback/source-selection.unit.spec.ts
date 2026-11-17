/**
 * Source selection over the four axes: authorization → compatibility → health →
 * quality.
 *
 * Every case here is a rule someone got wrong, or could get wrong tomorrow:
 *
 * - an unchecked source presented as available (the `unknown` → healthy defect);
 * - a healthy source used as a failover target although it has no right;
 * - a compatibility verdict inferred from a failure code;
 * - a health axis that never observed a YouTube source disabling it;
 * - a ledger row read through the wrong field names, which yields `undefined`
 *   and silently resolves `not-verified` forever.
 */
import { describe, expect, it } from 'vitest';
import type { PlaybackSourceDoc } from '../../infrastructure/schema.js';
import { recordedCheckOf } from '../../verification/source-health.js';
import {
  DEFAULT_REPRODUCTION_ENGINE,
  decideCandidate,
  NO_EVIDENCE,
  selectPlaybackCandidates,
  sourceHealth,
  type SourceEvidence,
} from './source-selection.js';
import type { AuthorizationRecord } from '../providers/authorization.js';

function source(overrides: Partial<PlaybackSourceDoc> = {}): PlaybackSourceDoc {
  return {
    _id: '00000000-0000-4000-8000-000000000001',
    channelId: '00000000-0000-4000-8000-0000000000aa',
    provider: 'emitter:example.org',
    type: 'hls',
    url: 'https://example.org/live/master.m3u8',
    officialPageUrl: 'https://example.org/directo',
    permission: 'emitter-public-stream',
    authorisationEvidence: 'evidencia',
    conditions: {
      embedAllowed: true,
      proxyAllowed: false,
      worldwide: true,
      restrictedRegions: [],
      browserCompatibility: 'all',
      requiresForgedHeader: false,
      emitterAppOnly: false,
      notes: null,
    },
    priority: 100,
    editorialStatus: 'published',
    // The platform's real state: no source row carries a verdict.
    technicalStatus: 'unknown',
    lastVerifiedAt: null,
    lastVerification: null,
    provenance: [],
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    revision: 1,
    ...overrides,
  };
}

function authorization(sourceId: string, verdict: AuthorizationRecord['verdict'] = 'permitted-direct-playback'): AuthorizationRecord {
  return {
    _id: `fixture:${sourceId}`,
    operatorId: 'fixture',
    sourceUrl: 'https://example.org/live/master.m3u8',
    providerKind: 'broadcaster_cdn',
    verdict,
    basis: verdict === 'permitted-direct-playback' ? 'written-licence' : 'published-terms',
    quotedClause: null,
    clauseUrl: 'https://fixture.invalid/licence.pdf',
    method: 'direct-playback',
    publicationScope: 'in-app',
    territory: { allowed: [], restricted: [], worldwide: true, geoBlocked: false },
    restrictions: [],
    attribution: 'Fixture',
    discovery: { upstream: null, snapshotId: null, path: null, line: null, sourceUrl: null, documentUrl: null, retrievedAt: null },
    lifecycle: 'active',
    expiresAt: null,
    validationTimestamp: null,
    authorizationTimestamp: new Date('2026-11-16T12:00:00.000Z'),
    reviewStatus: 'reviewed',
    notes: null,
  };
}

const PUBLISHED = { editorialStatus: 'published' };
const NOW = new Date('2026-11-17T12:00:00.000Z');

function authorizationsFor(...sources: PlaybackSourceDoc[]): ReadonlyMap<string, AuthorizationRecord> {
  return new Map(sources.map((entry) => [entry._id, authorization(entry._id)]));
}

describe('source selection — authorization first, fail-closed', () => {
  it('refuses a source with no recorded right, whatever its health says', () => {
    const healthy = source({ _id: '00000000-0000-4000-8000-0000000000b1', technicalStatus: 'ok' });
    const decision = decideCandidate(healthy, { channel: PUBLISHED, sources: [healthy], authorizations: new Map(), now: NOW });
    expect(decision.selectable).toBe(false);
    if (decision.selectable) throw new Error('unreachable');
    expect(decision.refusal).toEqual({ axis: 'authorization', code: 'no-authorization-record' });
  });

  it('never lists an unauthorized source as a fallback, even when it is the healthiest one', () => {
    const denied = source({ _id: '00000000-0000-4000-8000-0000000000b2', technicalStatus: 'ok', priority: 1 });
    const allowed = source({ _id: '00000000-0000-4000-8000-0000000000b3', technicalStatus: 'ok', priority: 50 });
    const selection = selectPlaybackCandidates({
      channel: PUBLISHED,
      sources: [denied, allowed],
      authorizations: new Map([[allowed._id, authorization(allowed._id)]]),
      now: NOW,
    });
    expect(selection.candidates.map((entry) => entry.source._id)).toEqual([allowed._id]);
    // A denial is not a fallback with a reason: it is not a candidate at all.
    expect(selection.refused).toEqual([]);
  });

  it('never lets a higher-priority healthy source outrank an authorization denial', () => {
    const deniedFirst = source({ _id: '00000000-0000-4000-8000-0000000000b4', technicalStatus: 'ok', priority: 1 });
    const allowedSecond = source({ _id: '00000000-0000-4000-8000-0000000000b5', technicalStatus: 'ok', priority: 2 });
    const selection = selectPlaybackCandidates({
      channel: PUBLISHED,
      sources: [deniedFirst, allowedSecond],
      authorizations: new Map([[allowedSecond._id, authorization(allowedSecond._id)]]),
      now: NOW,
    });
    expect(selection.candidates[0]?.source._id).toBe(allowedSecond._id);
  });
});

describe('source selection — health is tri-state and only governs what it observed', () => {
  it('reports not-verified for a row nobody checked, never healthy', () => {
    const unchecked = source();
    const verdict = sourceHealth(unchecked, NO_EVIDENCE);
    expect(verdict).toEqual({ state: 'not-verified', origin: 'none', depth: null, failure: null, observedAt: null });
  });

  it('still offers an hls source nobody has checked (not-verified is not failing)', () => {
    const unchecked = source();
    const selection = selectPlaybackCandidates({
      channel: PUBLISHED,
      sources: [unchecked],
      authorizations: authorizationsFor(unchecked),
      now: NOW,
    });
    expect(selection.candidates).toHaveLength(1);
    expect(selection.candidates[0]?.axes.health.state).toBe('not-verified');
  });

  it('refuses an hls source whose recorded check failed, and names the failure', () => {
    const failing = source({ _id: '00000000-0000-4000-8000-0000000000c1' });
    const evidence: SourceEvidence = {
      checks: new Map([
        [
          failing._id,
          {
            outcome: 'failing',
            depth: 'transport',
            failure: { category: 'http-404' },
            observedAt: new Date('2026-11-17T11:00:00.000Z'),
          },
        ],
      ]),
      reproductions: new Map(),
      reproductionEngine: DEFAULT_REPRODUCTION_ENGINE,
    };
    const decision = decideCandidate(failing, {
      channel: PUBLISHED,
      sources: [failing],
      authorizations: authorizationsFor(failing),
      evidence,
      now: NOW,
    });
    expect(decision.selectable).toBe(false);
    if (decision.selectable) throw new Error('unreachable');
    expect(decision.refusal).toEqual({ axis: 'health', code: 'http-404' });
  });

  it('does not disable a youtube source for a health axis that never observed it', () => {
    const youtube = source({
      _id: '00000000-0000-4000-8000-0000000000c2',
      type: 'youtube',
      url: 'https://www.youtube.com/channel/UC0000000000000000000000/live',
    });
    /*
     * A YouTube right is scoped to the platform itself (the adapter refuses any
     * other operator with `platform-scope-violation`), so the record must be the
     * platform's, exactly as the 02C seeds record it. `published-terms` requires a
     * QUOTED CLAUSE plus a real citation — a `written-licence` basis with a null
     * clause is refused as `authorization-missing-quote`, correctly.
     */
    const youtubeRight: AuthorizationRecord = {
      ...authorization(youtube._id, 'permitted-official-embed'),
      operatorId: 'youtube',
      providerKind: 'platform',
      method: 'official-embed',
      basis: 'published-terms',
      quotedClause: 'Fixture: la integración de inserción del reproductor oficial está permitida.',
      clauseUrl: 'https://www.youtube.com/t/terms',
      /*
       * `published-terms` with no named territory means a worldwide platform
       * embed right. An empty allow-list would mean "territory not established",
       * which the gate correctly refuses for a territory-less request.
       */
      territory: { allowed: [], restricted: [], worldwide: true, geoBlocked: false },
    };
    const evidence: SourceEvidence = {
      checks: new Map([
        [
          youtube._id,
          {
            outcome: 'failing',
            depth: 'transport',
            failure: { category: 'http-404' },
            observedAt: new Date('2026-11-17T11:00:00.000Z'),
          },
        ],
      ]),
      reproductions: new Map(),
      reproductionEngine: DEFAULT_REPRODUCTION_ENGINE,
    };
    const decision = decideCandidate(youtube, {
      channel: PUBLISHED,
      sources: [youtube],
      authorizations: new Map([[youtube._id, youtubeRight]]),
      evidence,
      now: NOW,
    });
    expect(decision.selectable ? null : decision.refusal).toBeNull();
    // A recorded failure on a type the health engine never probes is not evidence
    // about that type: the axis reports `not-verified` and does not disable it.
    expect(decision.selectable).toBe(true);
    if (!decision.selectable) throw new Error('unreachable');
    expect(decision.axes.health.state).toBe('not-verified');
    expect(decision.axes.health.origin).toBe('none');
  });

  it('reads a real ledger row through the canonical mapping (depth, not depthReached)', () => {
    /*
     * The row below is the shape `completeCheck` writes: `depth` and
     * `timings.finishedAt`. Reading `depthReached`/`observedAt` off it would
     * yield `undefined` and resolve `not-verified` forever, which is why the
     * mapping lives in one function instead of a cast.
     */
    const ledgerRow = {
      _id: '00000000-0000-4000-8000-0000000000c3:2026-11-17T11:00:00.000Z',
      sourceId: '00000000-0000-4000-8000-0000000000c3',
      state: 'done',
      outcome: 'healthy',
      depth: 'segments',
      failure: null,
      timings: { queuedAt: new Date('2026-11-17T10:59:00.000Z'), startedAt: new Date('2026-11-17T10:59:00.000Z'), finishedAt: new Date('2026-11-17T11:00:00.000Z'), latencyMs: 500 },
      createdAt: new Date('2026-11-17T10:59:00.000Z'),
    };
    const mapped = recordedCheckOf(ledgerRow);
    expect(mapped).toEqual({
      outcome: 'healthy',
      depth: 'segments',
      failure: null,
      observedAt: new Date('2026-11-17T11:00:00.000Z'),
    });

    const checked = source({ _id: ledgerRow.sourceId });
    expect(sourceHealth(checked, { checks: new Map([[checked._id, mapped!]]), reproductions: new Map(), reproductionEngine: DEFAULT_REPRODUCTION_ENGINE })).toMatchObject({
      state: 'healthy',
      origin: 'health-ledger',
      depth: 'segments',
      observedAt: new Date('2026-11-17T11:00:00.000Z'),
    });
  });

  it('refuses a ledger row that is not a completed check', () => {
    expect(recordedCheckOf({ state: 'running', outcome: null, depth: 'eligibility', timings: { finishedAt: null }, createdAt: NOW })).toBeNull();
    expect(recordedCheckOf({ state: 'done', outcome: 'healthy', depth: 'segments', timings: { finishedAt: null }, createdAt: null })).toBeNull();
  });

  it('does not treat an eligibility refusal in the ledger as a stream failure', () => {
    const refused = source({ _id: '00000000-0000-4000-8000-0000000000c4' });
    const evidence: SourceEvidence = {
      checks: new Map([
        [
          refused._id,
          { outcome: 'ineligible', depth: 'eligibility', failure: { category: 'ineligible' }, observedAt: NOW },
        ],
      ]),
      reproductions: new Map(),
      reproductionEngine: DEFAULT_REPRODUCTION_ENGINE,
    };
    expect(sourceHealth(refused, evidence).state).toBe('not-verified');
    const decision = decideCandidate(refused, {
      channel: PUBLISHED,
      sources: [refused],
      authorizations: authorizationsFor(refused),
      evidence,
      now: NOW,
    });
    expect(decision.selectable).toBe(true);
  });
});

describe('source selection — compatibility is measured, never inferred', () => {
  const tricky = source({ _id: '00000000-0000-4000-8000-0000000000d1' });

  it.each(['unsupported-format', 'content-type-not-allowed', 'scheme-not-allowed', 'http-404', 'missing-segments'])(
    'keeps compatibility unknown for a %s failure, which is not a browser fact',
    (category) => {
      const evidence: SourceEvidence = {
        checks: new Map([
          [tricky._id, { outcome: 'failing', depth: 'transport', failure: { category }, observedAt: NOW }],
        ]),
        reproductions: new Map(),
        reproductionEngine: DEFAULT_REPRODUCTION_ENGINE,
      };
      const decision = decideCandidate(tricky, {
        channel: PUBLISHED,
        sources: [tricky],
        authorizations: authorizationsFor(tricky),
        evidence,
        now: NOW,
      });
      if (decision.selectable) {
        expect(decision.axes.compatibility.state).toBe('unknown');
      } else {
        expect(decision.refusal.axis).toBe('health');
      }
    },
  );

  it('refuses a source only when a reproduction probe measured incompatibility', () => {
    const evidence: SourceEvidence = {
      checks: new Map([[tricky._id, { outcome: 'healthy', depth: 'segments', failure: null, observedAt: NOW }]]),
      reproductions: new Map([
        [
          tricky._id,
          {
            depthReached: 'browser',
            failure: { category: 'browser-incompatible' },
            observedAt: new Date('2026-11-17T11:30:00.000Z'),
          },
        ],
      ]),
      reproductionEngine: 'chromium',
    };
    const decision = decideCandidate(tricky, {
      channel: PUBLISHED,
      sources: [tricky],
      authorizations: authorizationsFor(tricky),
      evidence,
      now: NOW,
    });
    expect(decision.selectable).toBe(false);
    if (decision.selectable) throw new Error('unreachable');
    expect(decision.refusal).toEqual({ axis: 'compatibility', code: 'browser-incompatible' });
  });
});

describe('source selection — quality is a tie-break only', () => {
  it('orders selectable candidates by priority and never promotes a refused one', () => {
    const high = source({ _id: '00000000-0000-4000-8000-0000000000e1', priority: 1 });
    const low = source({ _id: '00000000-0000-4000-8000-0000000000e2', priority: 9 });
    const selection = selectPlaybackCandidates({
      channel: PUBLISHED,
      sources: [low, high],
      authorizations: authorizationsFor(high, low),
      evidence: {
        checks: new Map([[high._id, { outcome: 'failing', depth: 'transport', failure: { category: 'http-404' }, observedAt: NOW }]]),
        reproductions: new Map(),
        reproductionEngine: DEFAULT_REPRODUCTION_ENGINE,
      },
      now: NOW,
    });
    expect(selection.candidates.map((entry) => entry.source._id)).toEqual([low._id]);
    expect(selection.refused.map((entry) => entry.refusal.axis)).toEqual(['health']);
  });
});


