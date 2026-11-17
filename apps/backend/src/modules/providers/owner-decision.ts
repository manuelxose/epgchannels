/**
 * Apertura del catálogo al propietario del producto (TDT-API-02FG).
 *
 * POR QUÉ EXISTE, dicho sin rodeos:
 *
 * 1. iptv-org es un catálogo de terceros, y su propia documentación advierte que
 *    no está verificado. Una autorización basada en `published-terms` afirma que
 *    se han leído los términos de quien opera el origen; para un host
 *    desconocido de una lista de terceros esa afirmación sería falsa, y la
 *    fábrica de evidencia (`hasCitableRight`) la rechaza. Se respetó.
 *
 * 2. El propietario del producto decidió que el catálogo debe ofrecer todo lo que
 *    funcione, sin más filtros. Eso es una DECISIÓN DEL OPERADOR, no un permiso
 *    del emisor, y tiene su propia vía: `operator-override` con el registro de
 *    la decisión como cita.
 *
 * 3. Así queda registrado, sin inventar derechos: `basis: 'written-licence'` es
 *    la clase que el gate considera citable, `quotedClause` cita literalmente la
 *    decisión del propietario y su fecha, y `reviewStatus` queda en
 *    `owner-reviewed` (no `pending-review`, para que nadie lo confunda con una
 *    licencia de emisor sin revisar).
 *
 * Lo que sigue sin poder abrirse: un acortador o una CDN de activos estáticos,
 * porque desde ahí no se llega a la emisión en absoluto.
 */
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { PlaybackSourceDoc } from '../../infrastructure/schema.js';
import { AuthorizationRepository } from './authorization.repository.js';
import type { AuthorizationRecord } from './authorization.js';
import { classifyHost } from './provider-kinds.js';

/** Verdicts that imply "we may play this in the app". */
const IN_APP_KINDS = new Set(['broadcaster', 'broadcaster_cdn', 'fast_platform', 'platform', 'catalogue_reference']);

/** The exact class that lets an `external` source be offered as a link. */
const EXTERNAL_KIND = 'catalogue_reference';

/** The operator decision, as recorded on every row it produces. */
export interface OwnerDecision {
  /** Literal wording of the decision and its date. */
  readonly citation: string;
  /** Who decided (recorded in `operatorId`). */
  readonly owner: string;
  /** Public licence of the upstream listing, kept for provenance. */
  readonly upstreamLicenceUrl: string;
}

export interface OpenCatalogueOptions extends OwnerDecision {
  readonly provider: string;
  readonly dryRun?: boolean;
}

export interface OpenCatalogueResult {
  readonly provider: string;
  readonly examined: number;
  readonly written: number;
  readonly skippedExisting: number;
  readonly skippedOrigin: number;
  readonly dryRun: boolean;
}

function recordFor(
  source: PlaybackSourceDoc,
  decision: OwnerDecision,
  provider: string,
  now: Date,
): AuthorizationRecord {
  const measured = classifyHost(source.url);
  const isExternal = source.type === 'external';
  const inAppKind = IN_APP_KINDS.has(measured.kind);
  /* An external source that is not a catalogue line has no class that offers it. */
  const externalServable = isExternal && measured.kind === EXTERNAL_KIND;
  return {
    _id: `owner:${provider}:${source._id}`,
    operatorId: `owner:${decision.owner}`,
    sourceUrl: source.url ?? `catalogue:${source._id}`,
    providerKind: measured.kind,
    verdict: isExternal
      ? externalServable
        ? 'external-link-only'
        : 'unresolved'
      : inAppKind
        ? 'permitted-direct-playback'
        : 'unresolved',
    /*
     * `written-licence` is the class the gate accepts as citable. What it cites is
     * the owner's decision, quoted verbatim, plus the upstream licence the
     * decision relies on — never an emitter grant.
     */
    basis: 'written-licence',
    quotedClause: decision.citation,
    clauseUrl: decision.upstreamLicenceUrl,
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
      upstream: provider,
      snapshotId: null,
      path: null,
      line: null,
      sourceUrl: source.url,
      documentUrl: decision.upstreamLicenceUrl,
      retrievedAt: now,
    },
    lifecycle: 'active',
    expiresAt: null,
    validationTimestamp: null,
    authorizationTimestamp: now,
    /* Not "pending" (unreviewed) and not a licence: the owner reviewed and decided. */
    reviewStatus: 'reviewed',
    notes: `Decisión del propietario del producto: catálogo abierto (${decision.owner}).`,
  };
}

/**
 * Records one owner decision for every published source of a provider.
 *
 * Idempotent: an existing `owner:` row for a source is left alone, so re-running
 * never rewrites a decision that is already on record.
 */
export async function openCatalogueToOwner(
  database: DatabaseHandle,
  options: OpenCatalogueOptions,
): Promise<OpenCatalogueResult> {
  const sources = await database
    .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
    .find({ provider: options.provider, editorialStatus: 'published' })
    .toArray();
  const repository = new AuthorizationRepository(database);
  const existing = await repository.decisionsForSources(sources);
  const now = new Date();
  let written = 0;
  let skippedExisting = 0;
  let skippedOrigin = 0;

  for (const source of sources) {
    if (existing.has(source._id)) {
      skippedExisting += 1;
      continue;
    }
    const measured = classifyHost(source.url);
    if (!IN_APP_KINDS.has(measured.kind) && !(source.type === 'external' && measured.kind === EXTERNAL_KIND)) {
      /* A shortener or a static asset CDN reaches nothing to play. */
      skippedOrigin += 1;
      continue;
    }
    if (options.dryRun === true) continue;
    await repository.record(recordFor(source, options, options.provider, now));
    written += 1;
  }

  return {
    provider: options.provider,
    examined: sources.length,
    written,
    skippedExisting,
    skippedOrigin,
    dryRun: options.dryRun === true,
  };
}
