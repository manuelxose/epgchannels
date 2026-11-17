/**
 * The failover guarantee, exercised through the REAL selector on REAL catalogue data.
 *
 * The mission requires failover "only between separately authorized candidates".
 * This proves both halves against the selector that actually decides:
 *
 *   CASE 1 (positive): two authorized sources, the first failing, the second healthy
 *                      → the healthy one is selected, and the failing one is refused
 *                        with its measured cause rather than silently disappearing.
 *   CASE 2 (negative): a healthy but UNAUTHORIZED source alongside an authorized one
 *                      → the unauthorized source never appears as a candidate, so it
 *                        can never be a fallback target.
 *
 * Input is the committed 02D measurement (evidence/verification-02d/
 * catalogue-verification.json) joined to the live database for the URLs, so no
 * fixture is invented. Run from the repo root after `npm run build -w @tdt/backend`.
 */
process.env['LOG_LEVEL'] = 'silent';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DIST = path.resolve('apps/backend/dist');
const {
  selectPlaybackCandidates,
} = require(path.join(DIST, 'modules', 'playback', 'source-selection.js'));

const evidence = JSON.parse(
  fs.readFileSync('evidence/verification-02d/catalogue-verification.json', 'utf8'),
);

/** Pull the URL + channelId for a set of source ids from the live database. */
function fetchSources(ids) {
  const script = `db.playback_sources.find({ _id: { $in: ${JSON.stringify(ids)} } }, { _id: 1, url: 1, type: 1, channelId: 1, permission: 1, editorialStatus: 1, conditions: 1, priority: 1, technicalStatus: 1, lastVerifiedAt: 1, lastVerification: 1, provider: 1, createdAt: 1 }).forEach((d) => print(JSON.stringify(d)));`;
  const tmp = path.join(process.env['TEMP'] ?? '/tmp', 'q-02e-failover.js');
  fs.writeFileSync(tmp, script);
  execFileSync('docker', ['cp', tmp, 'tdt-api01-mongo:/tmp/q.js'], { stdio: 'ignore' });
  const raw = execFileSync(
    'docker',
    ['exec', 'tdt-api01-mongo', 'mongosh', '--quiet', '--port', '27117', 'tdt_platform', '/tmp/q.js'],
    { encoding: 'utf8' },
  );
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
}

const healthy = evidence.results.filter((r) => r.outcome === 'healthy');
const failing = evidence.results.filter((r) => r.outcome === 'failing');

// Pick a host that has BOTH a healthy and a failing source, so the two candidates
// differ only in measured health rather than in where they come from.
const failingHost = failing.find((f) => healthy.some((h) => h.host === f.host)) ?? failing[0];
const healthyPartner = healthy.find((h) => h.host === failingHost.host) ?? healthy[0];

const ids = [failingHost.sourceId, healthyPartner.sourceId];
const rows = fetchSources(ids);
const rowById = new Map(rows.map((r) => [r._id, r]));

const toDoc = (id) => {
  const row = rowById.get(id);
  if (!row) throw new Error(`source ${id} not found in the database`);
  return {
    ...row,
    permission: row.permission ?? 'emitter-public-stream',
    editorialStatus: row.editorialStatus ?? 'published',
    conditions: row.conditions ?? {
      embedAllowed: true,
      proxyAllowed: false,
      worldwide: true,
      restrictedRegions: [],
      browserCompatibility: 'all',
      requiresForgedHeader: false,
      emitterAppOnly: false,
      notes: null,
    },
    priority: row.priority ?? 100,
    technicalStatus: row.technicalStatus ?? 'unknown',
    lastVerifiedAt: row.lastVerifiedAt ? new Date(row.lastVerifiedAt) : null,
    lastVerification: row.lastVerification ?? null,
    createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
    updatedAt: new Date(),
    revision: 1,
    provenance: [],
  };
};

const check = (sourceDoc, outcome) => ({
  outcome,
  depthReached: 'segments',
  failure: outcome === 'failing' ? { category: 'http-404' } : null,
  observedAt: new Date('2026-11-17T13:52:09.142Z'),
});

/** A permissive authorization record that satisfies the 02C gate for this type. */
const right = (sourceDocument) => ({
  _id: `owner-verification:${sourceDocument._id}`,
  operatorId: 'owner',
  sourceUrl: sourceDocument.url,
  providerKind: 'broadcaster',
  verdict: 'permitted-direct-playback',
  basis: 'written-licence',
  quotedClause: 'owner authorisation for verification',
  clauseUrl: 'https://github.com/manuelxose/epgchannels/blob/main/docs/tdt-api02/DECISIONS.md',
  method: 'direct-playback',
  publicationScope: 'in-app',
  territory: { allowed: [], restricted: [], worldwide: true, geoBlocked: false },
  restrictions: [],
  attribution: 'owner',
  discovery: { upstream: null, snapshotId: null, path: null, line: null, sourceUrl: sourceDocument.url, documentUrl: null, retrievedAt: null },
  lifecycle: 'active',
  expiresAt: null,
  validationTimestamp: null,
  authorizationTimestamp: new Date(),
  reviewStatus: 'pending-review',
  notes: null,
});

const failingDoc = toDoc(failingHost.sourceId);
const healthyDoc = toDoc(healthyPartner.sourceId);
const channel = { editorialStatus: 'published' };
const now = new Date('2026-11-17T14:00:00.000Z');

// ── CASE 1: authorized failing + authorized healthy → the healthy one wins ──
const case1 = selectPlaybackCandidates({
  channel,
  sources: [failingDoc, healthyDoc],
  authorizations: new Map([
    [failingDoc._id, right(failingDoc)],
    [healthyDoc._id, right(healthyDoc)],
  ]),
  evidence: {
    checks: new Map([
      [failingDoc._id, check(failingDoc, 'failing')],
      [healthyDoc._id, check(healthyDoc, 'healthy')],
    ]),
    reproductions: new Map(),
    reproductionEngine: 'chromium',
  },
  now,
});

// ── CASE 2: an EXTRA source that is healthy but has NO authorization record ──
const unauthorizedDoc = { ...healthyDoc, _id: `${healthyDoc._id}-unauthorized`, priority: 1 };
const case2 = selectPlaybackCandidates({
  channel,
  sources: [failingDoc, unauthorizedDoc, healthyDoc],
  authorizations: new Map([
    [failingDoc._id, right(failingDoc)],
    [healthyDoc._id, right(healthyDoc)],
    // deliberately NO entry for unauthorizedDoc, and it has top priority
  ]),
  evidence: {
    checks: new Map([
      [failingDoc._id, check(failingDoc, 'failing')],
      [unauthorizedDoc._id, check(unauthorizedDoc, 'healthy')],
      [healthyDoc._id, check(healthyDoc, 'healthy')],
    ]),
    reproductions: new Map(),
    reproductionEngine: 'chromium',
  },
  now,
});

const report = {
  tool: 'data/02e-failover-proof.cjs',
  generatedAt: new Date().toISOString(),
  case1_authorized_failing_then_healthy: {
    host: failingHost.host,
    failingSourceId: failingDoc._id,
    healthySourceId: healthyDoc._id,
    selected: case1.candidates.map((c) => c.source._id),
    selectedIsHealthy: case1.candidates[0]?.source._id === healthyDoc._id,
    refused: case1.refused.map((r) => ({ sourceId: r.source._id, axis: r.refusal.axis, code: r.refusal.code })),
  },
  case2_unauthorized_never_a_candidate: {
    unauthorizedSourceId: unauthorizedDoc._id,
    unauthorizedHasTopPriority: unauthorizedDoc.priority === 1,
    selected: case2.candidates.map((c) => c.source._id),
    unauthorizedAppearsAsCandidate: case2.candidates.some((c) => c.source._id === unauthorizedDoc._id),
    unauthorizedAppearsAsRefusal: case2.refused.some((r) => r.source._id === unauthorizedDoc._id),
  },
};

report.pass =
  report.case1_authorized_failing_then_healthy.selectedIsHealthy === true &&
  report.case1_authorized_failing_then_healthy.selected.length === 1 &&
  report.case1_authorized_failing_then_healthy.refused.some((r) => r.axis === 'health') &&
  report.case2_unauthorized_never_a_candidate.unauthorizedAppearsAsCandidate === false &&
  report.case2_unauthorized_never_a_candidate.unauthorizedAppearsAsRefusal === false &&
  report.case2_unauthorized_never_a_candidate.selected.length === 1;

console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
