/**
 * Persistence for 02C authorization decisions.
 *
 * Deliberately its own collection. The playback source document carries
 * `technicalStatus` (does it answer?) and nothing about rights; the decision lives
 * here (may we play it, and how?). Keeping them in separate documents is what
 * makes it impossible for a verification job to overwrite a right — and for a
 * right to be inferred from a successful probe.
 *
 * `COLLECTION` is registered in `ensureIndexes` of this module rather than in
 * `infrastructure/schema.ts`, so the 02C surface stays inside its own module.
 */
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import type { Collection } from 'mongodb';
import type { AuthorizationRecord } from './authorization.js';
import { OPERATOR_SEEDS, YOUTUBE_PLATFORM_SEED, seedDiscovery } from './operator-seeds.js';

/** Collection holding authorization decisions (never availability). */
export const AUTHORIZATION_COLLECTION = 'source_authorizations_02c';

interface AuthorizationDoc extends AuthorizationRecord {
  _id: string;
}

/** Lowercased host of a URL, or `null` when it does not parse. */
function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Hosts that belong to YouTube's own embed/player surface. Exact equality only:
 * a lookalike host never inherits the platform grant.
 */
const YOUTUBE_PLATFORM_HOSTS: ReadonlySet<string> = new Set([
  'www.youtube.com',
  'youtube.com',
  'm.youtube.com',
  'www.youtube-nocookie.com',
  'youtube-nocookie.com',
  'youtu.be',
]);

export class AuthorizationRepository {
  constructor(private readonly database: DatabaseHandle) {}

  private collection(): Collection<AuthorizationDoc> {
    // The 02C collection is not in the shared COLLECTIONS map; the cast keeps the
    // shared contract untouched while staying typed.
    return this.database.db.collection<AuthorizationDoc>(AUTHORIZATION_COLLECTION);
  }

  /** Ensures the lookup indexes exist. Idempotent. */
  async ensureIndexes(): Promise<void> {
    const collection = this.collection();
    await collection.createIndex({ operatorId: 1, verdict: 1 }, { name: 'auth02c_operator_verdict' });
    await collection.createIndex({ sourceUrl: 1 }, { name: 'auth02c_source' });
  }

  /** The recorded decision for one source, or `null` when none exists. */
  async forSourceUrl(sourceUrl: string): Promise<AuthorizationRecord | null> {
    return this.collection().findOne({ sourceUrl });
  }

  /**
   * Removes every decision owned by one source, matched on the source id
   * embedded in `_id`. Used when a source is genuinely withdrawn rather than
   * withdrawn editorially, and by tests that must express "no recorded right".
   */
  async deleteForSourceId(sourceId: string): Promise<number> {
    const suffix = `:${sourceId}`;
    const result = await this.collection().deleteMany({
      _id: { $in: [`editorial${suffix}`, `fixture${suffix}`] },
    });
    return result.deletedCount;
  }

  /**
   * The decision owned by one source, matched on the source id embedded in `_id`
   * (`editorial:<id>`, `fixture:<id>`). Prefers an editorial decision over a
   * fixture one when both exist, because the operator's own record is the
   * authoritative decision.
   */
  async forSourceId(sourceId: string): Promise<AuthorizationRecord | null> {
    const suffix = `:${sourceId}`;
    const rows = await this.collection()
      .find({ _id: { $in: [`editorial${suffix}`, `fixture${suffix}`] } })
      .toArray();
    const editorial = rows.find((row) => row._id.startsWith('editorial:'));
    return editorial ?? rows[0] ?? null;
  }

  /**
   * Decisions that apply to the given sources, keyed by source id, for the
   * playback gate.
   *
   * A decision applies when its `sourceUrl` names the source URL exactly or is
   * the operator page the decision was recorded against (`operator:<id>`): the
   * measured operator seeds are decision-level, not per-stream, because a stream
   * URL is availability data and rights are decided per operator. A source with
   * no matching decision is simply absent from the map, and the gate reads
   * absence as "no right" — never as permission.
   */
  async decisionsForSources(
    sources: readonly { readonly _id: string; readonly url: string | null }[],
  ): Promise<Map<string, AuthorizationRecord>> {
    const result = new Map<string, AuthorizationRecord>();
    if (sources.length === 0) return result;

    const urls = sources.map((source) => source.url).filter((url): url is string => url !== null);
    const operators = [...new Set([...OPERATOR_SEEDS, YOUTUBE_PLATFORM_SEED].map((seed) => seed.operatorId))];
    /*
     * Operator decisions are keyed by `_id` (`operator:<id>`), NOT by
     * `sourceUrl`: a seeded row stores its citation page there, so querying
     * `sourceUrl` for the operator key matched nothing and left every source
     * without a decision. That still failed closed, but for the wrong reason —
     * "no record" instead of the operator's real restricted/unresolved verdict —
     * which would have hidden the entire operator research from the gate.
     */
    const candidates: AuthorizationRecord[] = await this.collection()
      .find({
        $or: [
          ...(urls.length === 0 ? [] : [{ sourceUrl: { $in: urls } }]),
          { _id: { $in: operators.map((id) => `operator:${id}`) } },
        ],
      })
      .toArray();
    if (candidates.length === 0) return result;

    /*
     * Non-operator decisions belong to ONE source. Match them by the source id
     * embedded in their `_id` (`editorial:<sourceId>` / `fixture:<sourceId>`)
     * rather than by URL: two different sources can legitimately share a URL,
     * and matching by URL then let one source inherit another's class. The URL is
     * only a fallback for legacy rows that carry no source id.
     */
    const bySourceId = new Map<string, AuthorizationRecord>();
    const byUrl = new Map<string, AuthorizationRecord[]>();
    for (const row of candidates) {
      if (row._id.startsWith('operator:')) continue;
      const separator = row._id.indexOf(':');
      if (separator > 0) bySourceId.set(row._id.slice(separator + 1), row);
      const list = byUrl.get(row.sourceUrl) ?? [];
      list.push(row);
      byUrl.set(row.sourceUrl, list);
    }
    const byOperatorId = new Map(
      candidates.filter((row) => row._id.startsWith('operator:')).map((row) => [row._id.slice('operator:'.length), row]),
    );

    for (const source of sources) {
      const own = bySourceId.get(source._id);
      if (own !== undefined) {
        result.set(source._id, own);
        continue;
      }
      const sameUrl = source.url === null ? undefined : byUrl.get(source.url);
      if (sameUrl !== undefined && sameUrl.length === 1) {
        result.set(source._id, sameUrl[0]!);
        continue;
      }
      const host = source.url === null ? null : hostOfUrl(source.url);
      /*
       * YouTube is a platform grant, not an operator: its decision attaches only
       * when the source really lives on an official YouTube host. Comparison is
       * exact equality, so a lookalike such as
       * `www.youtube.com.attacker.example.org` can never inherit the grant.
       */
      const operatorSeed =
        host === null
          ? undefined
          : (OPERATOR_SEEDS.find((seed) => seed.hosts.some((known) => known.toLowerCase() === host)) ??
            (YOUTUBE_PLATFORM_HOSTS.has(host) ? YOUTUBE_PLATFORM_SEED : undefined));
      const row = operatorSeed === undefined ? undefined : byOperatorId.get(operatorSeed.operatorId);
      if (row !== undefined) result.set(source._id, row);
    }
    return result;
  }

  /** Every decision for one operator. */
  async forOperator(operatorId: string): Promise<AuthorizationRecord[]> {
    return this.collection().find({ operatorId }).toArray();
  }

  /** Upserts one decision, keyed by its stable `_id`. */
  async record(record: AuthorizationRecord): Promise<void> {
    await this.collection().updateOne({ _id: record._id }, { $set: record }, { upsert: true });
  }

  /**
   * Seeds the measured operator decisions. Never promotes anything: every row
   * comes from `OPERATOR_SEEDS`, which is transcribed from published terms and
   * contains no permitted Spanish operator.
   */
  async seedOperators(now: Date): Promise<number> {
    let written = 0;
    for (const seed of OPERATOR_SEEDS) {
      const record: AuthorizationRecord = {
        _id: `operator:${seed.operatorId}`,
        operatorId: seed.operatorId,
        // Operator-level decisions are attached to the documented page, not to a
        // stream URL: a stream URL is availability data, which is a different axis.
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
        // No decision was taken: nothing is authorized, so there is no timestamp.
        authorizationTimestamp: seed.verdict === 'unresolved' ? null : now,
        reviewStatus: seed.reviewStatus,
        notes: seed.notes,
      };
      await this.record(record);
      written += 1;
    }
    return written;
  }

  /** Seeds the single permitted platform integration (YouTube embed). */
  async seedPlatforms(now: Date): Promise<void> {
    await this.record({
      _id: `operator:${YOUTUBE_PLATFORM_SEED.operatorId}`,
      operatorId: YOUTUBE_PLATFORM_SEED.operatorId,
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
      authorizationTimestamp: now,
      reviewStatus: 'reviewed',
      notes: 'Permiso de la plataforma, acotado a `platform: youtube`.',
    });
  }
}
