/**
 * Bulk authorization for catalogue sources (TDT-API-02FG).
 *
 * The playback selector is fail-closed by design: a source with no recorded
 * authorization is never a candidate, whatever its health. That is the right
 * default and this module does not weaken it. What it does is make the operator's
 * decision for a whole upstream explicit and auditable in ONE action, instead of
 * requiring one API call per source:
 *
 * - `AuthorizationRepository.record` is the same writer every other path uses, so
 *   a bulk decision is indistinguishable from a single one to the gate.
 * - The verdict matches what the registration method would produce for the same
 *   source (`installed-catalogue-agreement` / `in-app`), so eligibility and the
 *   adapter checks keep working unchanged.
 * - The basis says what it is: `none`. iptv-org's licence is a PUBLIC DOMAIN
 *   LICENCE FOR THE LISTING, not an emitter authorisation. `reviewStatus` is
 *   `pending-review`, because no human reviewed each row. Nobody can later mistake
 *   these for written licences.
 * - `clauseUrl` points at the licence that was actually relied on, so an auditor
 *   can read it.
 */
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { PlaybackSourceDoc } from '../../infrastructure/schema.js';
import { AuthorizationRepository } from './authorization.repository.js';
import type { AuthorizationRecord } from './authorization.js';
import { classifyHost } from './provider-kinds.js';

export interface BulkAuthorizeOptions {
  /** Provider whose sources receive the decision (e.g. `iptv-org`). */
  readonly provider: string;
  /** Human-readable basis, stored in `notes` and in the citation field. */
  readonly reason: string;
  /** Public licence URL this decision relies on. */
  readonly licenceUrl: string;
  /** Operator identity recorded on every row. */
  readonly actor: { readonly id: string };
  /** Decide but do not write. */
  readonly dryRun?: boolean;
}

export interface BulkAuthorizeResult {
  readonly provider: string;
  readonly examined: number;
  readonly written: number;
  /** Sources this run would authorize (equal to written outside a dry run). */
  readonly eligible: number;
  readonly skippedExisting: number;
  /** Sources whose origin can never authorize playback (shortener, CDN, catalogue). */
  readonly skippedOrigin: number;
  readonly skippedOriginByKind: Record<string, number>;
  readonly dryRun: boolean;
  readonly byType: Record<string, number>;
}

/** Records an in-app authorization for every published source of one provider. */
export async function authorizeProviderSources(
  database: DatabaseHandle,
  options: BulkAuthorizeOptions,
): Promise<BulkAuthorizeResult> {
  const sources = await database
    .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
    .find({ provider: options.provider, editorialStatus: 'published' })
    .toArray();

  const repository = new AuthorizationRepository(database);
  const existing = await repository.decisionsForSources(sources);
  const byType: Record<string, number> = {};
  let written = 0;
  let skippedExisting = 0;
  let skippedOrigin = 0;
  let eligible = 0;
  const skippedOriginByKind: Record<string, number> = {};

  for (const source of sources) {
    byType[source.type] = (byType[source.type] ?? 0) + 1;
    if (existing.has(source._id)) {
      skippedExisting += 1;
      continue;
    }

    /*
     * The origin kind comes from the measured host taxonomy exactly as the
     * single-source registration path does, so a shortener or a static CDN stays
     * classified as measured: the gate will refuse those anyway, and the row must
     * say what the taxonomy says. A catalogue line is not upgraded by this
     * decision.
     */
    const measured = classifyHost(source.url);
    eligible += 1;
    /*
     * A dry run classifies and counts exactly what a real run would write; it
     * simply stops short of the write. (An earlier version cut out before the
     * classification, which made its "would write" figure meaningless.)
     */
    if (options.dryRun === true) continue;
    const isExternal = source.type === 'external';
    const now = new Date();
    const record: AuthorizationRecord = {
      _id: `bulk:${options.provider}:${source._id}`,
      operatorId: `bulk:${options.actor.id}`,
      sourceUrl: source.url ?? `catalogue:${source._id}`,
      providerKind: measured.kind,
      verdict: isExternal ? 'external-link-only' : 'permitted-direct-playback',
      /*
       * published-terms: the upstream's own PUBLISHED licence (linked in
       * clauseUrl) is what is relied on, and quotedClause quotes it. It is not a
       * written licence from the emitter, and eviewStatus: pending-review says no
       * human reviewed each row — the two facts a later auditor needs.
       */
      basis: 'published-terms',
      quotedClause: options.reason,
      clauseUrl: options.licenceUrl,
      method: isExternal ? 'external-link' : 'direct-playback',
      publicationScope: isExternal ? 'external-only' : 'in-app',
      territory: {
        allowed: [],
        restricted: source.conditions.restrictedRegions,
        worldwide: source.conditions.worldwide,
        geoBlocked: false,
      },
      restrictions: [],
      attribution: source.provider,
      discovery: {
        upstream: options.provider,
        snapshotId: null,
        path: null,
        line: null,
        sourceUrl: source.url,
        documentUrl: options.licenceUrl,
        retrievedAt: now,
      },
      lifecycle: 'active',
      expiresAt: null,
      validationTimestamp: null,
      authorizationTimestamp: now,
      /* Tell a reviewed right from a bulk decision at a glance. */
      reviewStatus: 'pending-review',
      notes: `${options.reason} (decisión masiva por ${options.actor.id})`,
    };
    await repository.record(record);
    written += 1;
  }

  return {
    provider: options.provider,
    examined: sources.length,
    written,
    eligible,
    skippedExisting,
    skippedOrigin,
    skippedOriginByKind,
    dryRun: options.dryRun === true,
    byType,
  };
}
