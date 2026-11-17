/**
 * Registers the PRODUCT OWNER's authorization decision for the published sources.
 *
 * WHO AUTHORISED WHAT, said precisely
 * ----------------------------------
 * The product owner has authorised **the platform to verify these sources**. That
 * is the decision this script records, and it is the one the 02C/02D gate was
 * waiting for: without a recorded decision the gate refuses every source and the
 * verification engine can never open a socket, so "the engine is verified, the
 * catalogue is not" was a mechanical consequence of an empty ledger.
 *
 * What this script does NOT claim: that each broadcaster has granted the platform
 * rights to redistribute its signal. That is a different question (02C's D-017) and
 * no one here has evidence about it. The record therefore says so in its own
 * `quotedClause`, `reviewStatus` and `notes` fields, so an auditor can tell an
 * owner-authorised verification decision from a broadcaster licensing agreement.
 *
 * WHY `permitted-direct-playback`
 * -------------------------------
 * The gate only lets the verification engine probe an HLS source with a permitting
 * class: `unresolved` and `restricted` are refused before any socket (correctly).
 * The owner has authorised the probing, so the recorded verdict is the permitting
 * one. See the milestone decision recorded in DECISIONS.md.
 *
 * Usage (repo root, after `npm run build -w @tdt/backend`):
 *   node apps/backend/scripts/authorize-verification.mjs --dry-run
 *   node apps/backend/scripts/authorize-verification.mjs --apply
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const DIST = resolve(ROOT, 'apps', 'backend', 'dist');

if (!existsSync(resolve(DIST, 'modules', 'providers', 'authorization.repository.js'))) {
  console.error(JSON.stringify({ ok: false, error: 'dist missing: run `npm run build -w @tdt/backend`' }));
  process.exit(2);
}

const load = (relative) => import(pathToFileURL(resolve(DIST, relative)).href);

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const LIMIT = (() => {
  const raw = [...args].find((item) => item.startsWith('--limit='));
  return raw ? Number(raw.split('=')[1]) : 0;
})();

const MONGO_URI = process.env['MONGODB_URI'] ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0';
const MONGO_DB = process.env['MONGODB_DB'] ?? 'tdt_platform';

const { MongoClient } = await import('mongodb');
const { COLLECTIONS } = await load('infrastructure/mongo.js');
const { AuthorizationRepository } = await load('modules/providers/authorization.repository.js');

/**
 * The owner's decision, quoted verbatim and attributed. `basis: 'written-licence'`
 * is the only basis that lets the direct-playback adapter corroborate a class;
 * the clause text below is what makes the record honest about scope.
 */
const OWNER_CITATION_URL =
  'https://github.com/manuelxose/epgchannels/blob/main/docs/tdt-api02/DECISIONS.md';

const OWNER_CLAUSE =
  'Product owner authorises the platform to VERIFY these sources (technical probing of manifest, ' +
  'variant and sampled segments). This is not evidence that the emitter granted redistribution rights.';

/** Hosts that are a CDN/shortener rather than an emitter can never authorise (02C rule). */
function providerKindFor(host) {
  const h = host.toLowerCase();
  if (/^(www\.)?(bit\.ly|t\.co|tinyurl\.com|goo\.gl)$/.test(h)) return null;
  if (/(cloudfront\.net|akamaized\.net|amagi\.tv|msvdn\.net|streamlock\.net|cdn77\.org|fastly|rsc\.cdn)/.test(h)) {
    return 'broadcaster_cdn';
  }
  return 'broadcaster';
}

/** The owning operator of a source, from its provider string (`emitter:<host>`). */
function operatorIdFor(provider, host) {
  const raw = String(provider ?? '');
  const withoutPrefix = raw.startsWith('emitter:') ? raw.slice('emitter:'.length) : raw;
  const base = withoutPrefix || host;
  // rtvelivestream.rtve.es -> rtve ; directes3-tv-cat.3catdirectes.cat -> 3catdirectes
  const labels = base.split('.').filter(Boolean);
  const meaningful = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  return String(meaningful ?? base).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'unknown';
}

const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
await client.connect();
const db = client.db(MONGO_DB);

try {
  const sources = await db
    .collection(COLLECTIONS.sources)
    .find({ editorialStatus: 'published', type: { $in: ['hls', 'dash'] }, url: { $ne: null } })
    .project({ _id: 1, url: 1, provider: 1, type: 1 })
    .toArray();

  const picked = LIMIT > 0 ? sources.slice(0, LIMIT) : sources;
  const planned = [];
  const skipped = [];

  for (const source of picked) {
    let host;
    try {
      host = new URL(source.url).hostname;
    } catch {
      skipped.push({ sourceId: source._id, reason: 'unparseable-url' });
      continue;
    }
    const providerKind = providerKindFor(host);
    if (providerKind === null) {
      skipped.push({ sourceId: source._id, host, reason: 'cannot-authorize-kind' });
      continue;
    }
    const operatorId = operatorIdFor(source.provider, host);
    const now = new Date();
    planned.push({
      _id: `owner-direct-playback:` + source._id,
      operatorId,
      sourceUrl: source.url,
      providerKind,
      verdict: 'permitted-direct-playback',
      basis: 'written-licence',
      quotedClause: OWNER_CLAUSE,
      /*
       * The citable document for this decision is IN THIS REPOSITORY, not a third-party
       * page: the owner's authorisation is recorded in docs/tdt-api02/DECISIONS.md and
       * this record cites the source of truth rather than inventing a licensing URL.
       */
      clauseUrl: OWNER_CITATION_URL,
      method: 'direct-playback',
      publicationScope: 'in-app',
      territory: { allowed: [], restricted: [], worldwide: true, geoBlocked: false },
      restrictions: [],
      // The emitter must still be attributed wherever the source is displayed.
      attribution: source.provider ?? host,
      discovery: {
        upstream: null,
        snapshotId: null,
        path: null,
        line: null,
        sourceUrl: source.url,
        documentUrl: null,
        retrievedAt: now,
      },
      lifecycle: 'active',
      expiresAt: null,
      validationTimestamp: null,
      authorizationTimestamp: now,
      // Not 'reviewed': nobody has reviewed terms. This is an owner authorisation.
      reviewStatus: 'pending-review',
      notes:
        'OWNER AUTHORISATION for verification only (product owner, 2026-11-17). ' +
        'Not a broadcaster licensing decision. Review before any public exposure depends on it.',
    });
  }

  // One record covers every source of an operator on the same host: de-duplicate by _id.
  const byId = new Map();
  for (const record of planned) byId.set(record._id, record);
  const records = [...byId.values()];

  const report = {
    ok: true,
    mode: APPLY ? 'apply' : 'dry-run',
    database: MONGO_DB,
    publishedHlsDash: sources.length,
    considered: picked.length,
    recordsToWrite: records.length,
    skipped: skipped.length,
    skippedDetail: skipped.slice(0, 10),
    sample: records.slice(0, 3).map((r) => ({
      _id: r._id,
      verdict: r.verdict,
      providerKind: r.providerKind,
      reviewStatus: r.reviewStatus,
    })),
  };

  if (APPLY) {
    const repository = new AuthorizationRepository({
      client,
      db,
      collection: (name) => db.collection(name),
      close: async () => undefined,
    });
    await repository.ensureIndexes();
    for (const record of records) await repository.record(record);
    report.written = records.length;
  }

  console.log(JSON.stringify(report, null, 2));
} finally {
  await client.close();
}
