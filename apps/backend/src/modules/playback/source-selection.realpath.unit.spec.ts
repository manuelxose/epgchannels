/**
 * D-023 real-path proof: the selector driven by the platform's own 02D
 * measurement, with no injected seam anywhere in the decision.
 *
 * The input is `evidence/verification-02d/catalogue-verification.json` — the
 * measured result of running `runValidation` with the real SSRF-guarded egress
 * against the 81 authorized catalogue sources. Nothing here restates the
 * measurement: the counts in the assertions are what the file says (81/63/18),
 * and they fail if the file ever says something else.
 *
 * The decision is made by the real `buildDescriptor` over real
 * `PlaybackSourceDoc` rows and a real ledger shape (`depth` + `timings.finishedAt`,
 * as `completeCheck` writes it, mapped by `recordedCheckOf`). The only thing this
 * test supplies is the authorization record, because the ledger for it is a
 * separate collection this task's write scope does not own; the record is built to
 * the exact conditions the 02C gate requires and the measurement reports
 * (`verdict: permitted-direct-playback`, `hasAuthorization: true` for all 81).
 *
 * ## Why a mutation is part of the proof
 *
 * A green suite proves nothing if the code under it cannot fail. `npm run
 * proof:mutation` applies the measured checklist to the source tree and reports
 * each one. Two mutations are *asserted here as behaviour*, so they can never
 * pass silently —
 *
 * - restoring `technicalStatus === 'unknown'` as healthy must break this suite;
 * - making health outrank authorization must break this suite.
 *
 * — and a third property (compat from a failure code) is closed by the type
 * system: `resolveCompatibility` accepts only a reproduction result, which is
 * asserted in `compatibility.unit.spec.ts`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlaybackSourceDoc } from '../../infrastructure/schema.js';
import type { AuthorizationRecord } from '../providers/authorization.js';
import { buildDescriptor } from './playback.service.js';
import { recordedCheckOf, type RecordedCheck } from '../../verification/source-health.js';

interface MeasuredResult {
  readonly sourceId: string;
  readonly host: string;
  readonly hasAuthorization: boolean;
  readonly verdict: string;
  readonly outcome: 'healthy' | 'failing';
  readonly failure: string | null;
  readonly depthReached: string;
  readonly uncertaintyNotes: readonly string[];
}

interface Measurement {
  readonly ok: boolean;
  readonly requested: number;
  readonly verified: number;
  readonly withAuthorization: number;
  readonly byOutcome: { readonly healthy: number; readonly failing: number };
  readonly byFailure: Readonly<Record<string, number>>;
  readonly results: readonly MeasuredResult[];
}

/**
 * Where the measurement lives, resolved from this file rather than from the
 * working directory: `apps/backend/src/modules/playback` → repository root.
 * Both the source tree and the compiled `dist` tree sit at the same depth under
 * `apps/backend`, so the same relative path works for both.
 */
export const MEASUREMENT_PATH = resolve(import.meta.dirname, '../../../../../evidence/verification-02d/catalogue-verification.json');

const measurement: Measurement = JSON.parse(readFileSync(MEASUREMENT_PATH, 'utf8')) as Measurement;

const NOW = new Date('2026-11-17T15:00:00.000Z');
const CHANNEL_ID = '00000000-0000-4000-8000-00000000c4a1';

function sourceRow(result: MeasuredResult, index: number): PlaybackSourceDoc {
  return {
    _id: result.sourceId,
    channelId: CHANNEL_ID,
    provider: `emitter:${result.host}`,
    type: 'hls',
    url: `https://${result.host}/live/source-${index}.m3u8`,
    officialPageUrl: `https://${result.host}/directo`,
    permission: 'emitter-public-stream',
    authorisationEvidence: '02D authorised catalogue',
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
    priority: index,
    editorialStatus: 'published',
    // The platform's measured state: no row carries a health verdict.
    technicalStatus: 'unknown',
    lastVerifiedAt: null,
    lastVerification: null,
    provenance: [],
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1,
  };
}

/** The 02C right the measurement reports for every one of the 81 sources. */
function rightFor(result: MeasuredResult): AuthorizationRecord {
  return {
    _id: `fixture-operator:${result.sourceId}`,
    operatorId: 'fixture-operator',
    sourceUrl: `fixture:${result.sourceId}`,
    providerKind: 'broadcaster_cdn',
    verdict: 'permitted-direct-playback',
    basis: 'written-licence',
    quotedClause: null,
    clauseUrl: 'https://fixture.invalid/licencia-02d.pdf',
    method: 'direct-playback',
    publicationScope: 'in-app',
    territory: { allowed: [], restricted: [], worldwide: true, geoBlocked: false },
    restrictions: [],
    attribution: 'Fixture',
    discovery: { upstream: null, snapshotId: null, path: null, line: null, sourceUrl: null, documentUrl: null, retrievedAt: null },
    lifecycle: 'active',
    expiresAt: null,
    validationTimestamp: NOW,
    authorizationTimestamp: NOW,
    reviewStatus: 'reviewed',
    notes: null,
  };
}

/**
 * The ledger row `completeCheck` would have written for this measured result, in
 * the persisted vocabulary (`depth`, `timings.finishedAt`) — so the test exercises
 * the canonical mapping instead of a shape that already matches the reader.
 */
function ledgerRow(result: MeasuredResult, observedAt: Date): Record<string, unknown> {
  return {
    _id: `${result.sourceId}:${observedAt.toISOString()}`,
    sourceId: result.sourceId,
    kind: 'scheduled',
    state: 'done',
    outcome: result.outcome,
    depth: result.depthReached,
    failure: result.failure === null ? null : { category: result.failure, depth: result.depthReached },
    timings: { queuedAt: observedAt, startedAt: observedAt, finishedAt: observedAt, latencyMs: 100 },
    createdAt: observedAt,
  };
}

const channel = {
  _id: CHANNEL_ID,
  slug: 'canal-medido',
  name: 'Canal medido',
  shortName: 'Medido',
  country: 'ES',
  region: null,
  locality: null,
  languageTag: 'es',
  category: 'generalista',
  kind: 'linear',
  websiteUrl: null,
  description: '',
  branding: null,
  editorialStatus: 'published',
  timezone: 'Europe/Madrid',
  provenance: [],
  aliases: [],
  searchText: 'canal medido',
  epg: null,
  mergedInto: null,
  reviewedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  revision: 1,
} as const;

/** Ledger rows keyed by source, with the failure row observed most recently. */
function measuredEvidence(): Map<string, RecordedCheck> {
  const checks = new Map<string, RecordedCheck>();
  for (const result of measurement.results) {
    const observedAt = result.outcome === 'failing'
      ? new Date('2026-11-17T14:00:00.000Z')
      : new Date('2026-11-17T13:00:00.000Z');
    const mapped = recordedCheckOf(ledgerRow(result, observedAt));
    expect(mapped, `ledger row for ${result.sourceId} must map`).not.toBeNull();
    checks.set(result.sourceId, mapped as RecordedCheck);
  }
  return checks;
}

function decide(rows: readonly PlaybackSourceDoc[], rights: ReadonlyMap<string, AuthorizationRecord>, checks: ReadonlyMap<string, RecordedCheck>) {
  return buildDescriptor(
    channel as never,
    rows,
    NOW,
    new Map(),
    new Set(),
    rights,
    {
      checks,
      reproductions: new Map(),
      reproductionEngine: 'chromium',
    },
  );
}

describe('D-023 real path: the selector over the measured 02D catalogue', () => {
  it('the measurement file is the one the task describes (81 / 63 / 18)', () => {
    expect(measurement.requested).toBe(81);
    expect(measurement.verified).toBe(81);
    expect(measurement.withAuthorization).toBe(81);
    expect(measurement.byOutcome).toEqual({ healthy: 63, failing: 18 });
    expect(measurement.byFailure).toEqual({ 'http-404': 9, 'missing-segments': 1, 'unsupported-format': 8 });
    expect(measurement.results).toHaveLength(81);
    expect(measurement.results.every((result) => result.hasAuthorization && result.verdict === 'permitted-direct-playback')).toBe(true);
  });

  it('yields exactly 63 selectable and 18 refused, matching the measured causes', () => {
    const rows = measurement.results.map((result, index) => sourceRow(result, index));
    const rights = new Map(measurement.results.map((result) => [result.sourceId, rightFor(result)]));
    const descriptor = decide(rows, rights, measuredEvidence());

    const selectable = descriptor.playback.options.map((option) => option.sourceId);
    const healthyIds = measurement.results.filter((result) => result.outcome === 'healthy').map((result) => result.sourceId);
    expect(selectable).toHaveLength(63);
    expect(new Set(selectable)).toEqual(new Set(healthyIds));

    const refused = descriptor.playback.unavailableOptions ?? [];
    expect(refused).toHaveLength(18);
    // The axis and code are the measured cause, not a heuristic.
    const byCode = new Map<string, number>();
    for (const entry of refused) {
      expect(entry.axis).toBe('health');
      byCode.set(entry.code, (byCode.get(entry.code) ?? 0) + 1);
    }
    expect(Object.fromEntries(byCode)).toEqual({ 'http-404': 9, 'missing-segments': 1, 'unsupported-format': 8 });

    // The measured failing hosts are the ones refused, and no others.
    const failingHosts = new Set(measurement.results.filter((result) => result.outcome === 'failing').map((result) => result.host));
    expect([...failingHosts].sort()).toEqual(['laxarxames.cat', 'www.laxarxames.cat', 'ztnr.rtve.es']);
  });

  it('reports the measured depth and failure on each option, and never invents a compatibility verdict', () => {
    const rows = measurement.results.map((result, index) => sourceRow(result, index));
    const rights = new Map(measurement.results.map((result) => [result.sourceId, rightFor(result)]));
    const descriptor = decide(rows, rights, measuredEvidence());
    const byId = new Map(measurement.results.map((result) => [result.sourceId, result]));

    for (const option of descriptor.playback.options) {
      const measured = byId.get(option.sourceId);
      expect(measured).toBeDefined();
      expect(option.health).toMatchObject({ state: 'healthy', origin: 'health-ledger', depth: 'segments' });
      /*
       * The 02D run never injected a browser probe (its only uncertainty note is
       * `dns-not-observed`), so this axis was not observed. Reporting anything
       * other than `unknown` here would be a claim nobody made.
       */
      expect(option.compatibility).toEqual({ state: 'unknown' });
    }
  });

  it('MUTATION CHECK (unknown-as-healthy): a row with no recorded check is still offered because the axis reports not-verified, not healthy', () => {
    /*
     * With no ledger evidence every row falls back to its own record, which is
     * `unknown`. The selector offers them and reports `not-verified`. If
     * `isSourceHealthy` semantics ever leak back in (unknown ⇒ healthy), this
     * assertion flips to `healthy` and fails; if they leak the other way
     * (unknown ⇒ failing) the candidates disappear and it fails too.
     */
    const rows = measurement.results.map((result, index) => sourceRow(result, index));
    const rights = new Map(measurement.results.map((result) => [result.sourceId, rightFor(result)]));
    const descriptor = decide(rows, rights, new Map());
    expect(descriptor.playback.options).toHaveLength(81);
    expect(descriptor.playback.options.every((option) => option.health?.state === 'not-verified')).toBe(true);
  });

  it('MUTATION CHECK (health outranking authorization): removing every right makes the healthiest catalogue offer nothing', () => {
    /*
     * Same 81 rows, all with a measured healthy ledger row, and NO authorization
     * records. If any axis could be consulted before authorization — or if a
     * healthy stream could be offered without a right — this descriptor would
     * still be `available` with 63 options.
     */
    const rows = measurement.results.map((result, index) => sourceRow(result, index));
    const descriptor = decide(rows, new Map(), measuredEvidence());
    expect(descriptor.playback.status).toBe('unavailable');
    expect(descriptor.playback.options).toEqual([]);
    expect(descriptor.playback.unavailableOptions ?? []).toEqual([]);
  });

  it('MUTATION CHECK (compatibility inferred from a failure code): the 8 unsupported-format refusals stay health refusals', () => {
    /*
     * `unsupported-format` is exactly the category that is NOT a browser fact (the
     * egress layer also produces it for a refused content type, and
     * `scheme-not-allowed` maps to it too). It must be reported on the health
     * axis, never promoted to `incompatible`.
     */
    const rows = measurement.results.map((result, index) => sourceRow(result, index));
    const rights = new Map(measurement.results.map((result) => [result.sourceId, rightFor(result)]));
    const descriptor = decide(rows, rights, measuredEvidence());
    const incompatible = (descriptor.playback.unavailableOptions ?? []).filter((entry) => entry.axis === 'compatibility');
    expect(incompatible).toEqual([]);
  });
});
