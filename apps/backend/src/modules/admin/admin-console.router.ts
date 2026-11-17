/**
 * Administration console routes (TDT-API-02FG §5).
 *
 * A factory, not a mounted router: the wiring stays with whoever owns
 * `server/routes.ts`, exactly like `verification.admin.ts`. Every route here sits
 * behind the caller's guard, and every mutation is a REAL operation recorded in
 * `audit_log` — there is no endpoint that merely acknowledges a request.
 *
 * Reads are composed by `AdminConsoleService`. Writes delegate to the services
 * that already own them (`EditorialService`, `SourcesService`, `JobControlService`,
 * the EPG module), so this file adds routing, validation and audit, never a second
 * implementation of a rule.
 *
 * What this file must never do, and does not:
 * - echo a source URL, a `clauseUrl` or a credential: the response schemas it uses
 *   have no field for one;
 * - return a provider's own error text: failures are classified into a closed
 *   vocabulary before they leave the process;
 * - let an editor perform an administrator's action: pausing a scheduled job and
 *   triggering guide ingestion change what the platform asks third parties for.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type {
  AdminCatalogueQuery,
  AdminIdentityInput,
  AdminMetrics,
  EpgCoverageEntry,
  EpgSyncRun,
} from '@tdt/contracts';
import {
  adminCatalogueQuerySchema,
  adminIdentityInputSchema,
  adminJobControlInputSchema,
  adminMappingDecisionInputSchema,
  adminMetricsResponseSchema,
  adminSourceAssignInputSchema,
  adminSourceHealthQuerySchema,
  adminSourceRemoveInputSchema,
} from '@tdt/contracts';
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { EpgSourceDoc } from '../../infrastructure/schema.js';
import { AppError } from '../../server/errors.js';
import { regionByCode } from '../../shared/taxonomy.js';
import type { Logger } from '../../infrastructure/logging.js';
import type { EditorialService, Actor } from './editorial.service.js';
import type { SourcesService } from './sources.service.js';
import { AdminConsoleService } from './admin-console.service.js';
import type { JobControlService } from '../../jobs/job-control.js';
import { scheduledJob, scheduledJobList } from '../../jobs/job-control.js';

/**
 * What the console needs from the EPG module.
 *
 * Narrow on purpose: only `coverage()` exists in the shared EPG service today, so
 * that is all this port requires and `context.epg` satisfies it structurally. The
 * mapping write operations of §5 (`proposeMapping`/`confirmMapping`/`rejectMapping`)
 * are implemented by the EPG module owner; when that module exports them the wiring
 * passes an object with the optional members below and the routes start working
 * with no change here. Until then those routes answer `503 unavailable` — a console
 * that silently reported success for a mapping that was never written would be
 * lying to an operator.
 */
export interface AdminEpgPort {
  coverage(options?: { readonly staleAfterMs?: number; readonly now?: Date; readonly lookbackMs?: number }): Promise<{
    entries: EpgCoverageEntry[];
    totals: { channels: number; mapped: number; fresh: number; stale: number; empty: number; notMapped: number };
    asOf: string;
  }>;
  confirmMapping?(mappingId: string, actor: Actor): Promise<unknown>;
  rejectMapping?(mappingId: string, actor: Actor): Promise<unknown>;
  proposeMapping?(
    input: {
      readonly channelId: string;
      readonly epgSourceId: string | null;
      readonly externalId: string;
      readonly namespace: string;
      readonly confidence: number;
    },
    actor: Actor,
  ): Promise<unknown>;
}

export interface AdminConsoleDeps {
  readonly database: DatabaseHandle;
  readonly console: AdminConsoleService;
  readonly editorial: EditorialService;
  readonly sources: SourcesService;
  readonly jobControl: JobControlService;
  readonly epg: AdminEpgPort;
  readonly egressOptions: { readonly blockedHosts: readonly string[]; readonly timeoutMs: number };
  /** The publication status reader the rest of the API uses. */
  readonly playback: { statusesFor(channels: readonly never[]): Promise<Map<string, string>> };
  readonly ingestion: {
    runSource(sourceId: string, egress: AdminConsoleDeps['egressOptions'], triggeredBy: string): Promise<{
      readonly sourceId: string;
      readonly runId: string;
      readonly status: 'ok' | 'failed';
      readonly programmes: number;
      readonly channelsMatched: number;
      readonly rejected: number;
      readonly message: string | null;
    }>;
  };
  /** Runtime metrics for the operations endpoint, already aggregated by the caller. */
  readonly metrics: () => Promise<AdminMetrics>;
  readonly logger?: Logger;
  readonly requireEditor: RequestHandler;
  readonly requireAdmin: RequestHandler;
}

/** Async handler: a rejection reaches the application error middleware. */
function handle(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function requestIdOf(response: Response): string {
  const id = response.locals?.['requestId'];
  return typeof id === 'string' ? id : 'unknown';
}

/** The actor comes from the authenticated principal, never from the body. */
function actorOf(request: Request): Actor {
  const email = request.admin?.email;
  if (typeof email !== 'string' || email.length === 0) {
    throw AppError.unauthorized('Sesión administrativa requerida.');
  }
  return { type: 'user', id: email };
}

function parseQuery<T extends z.ZodTypeAny>(schema: T, request: Request): z.output<T> {
  const parsed = schema.safeParse(request.query ?? {});
  if (!parsed.success) {
    throw AppError.validation(
      'Parámetros no válidos.',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return parsed.data;
}

function parseBody<T extends z.ZodTypeAny>(schema: T, request: Request): z.output<T> {
  const parsed = schema.safeParse(request.body ?? {});
  if (!parsed.success) {
    throw AppError.validation(
      'Parámetros no válidos.',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return parsed.data;
}

const idParam = z.string().uuid();

/** Stated plainly so an operator knows the difference between "not wired" and "failed". */
const EPG_WRITES_UNAVAILABLE =
  'La corrección de mapeos EPG no está disponible todavía en este despliegue: el módulo EPG aún no expone la operación. La cobertura y el listado sí se sirven.';

function requireId(request: Request, name = 'id'): string {
  const parsed = idParam.safeParse(request.params[name]);
  if (!parsed.success) throw AppError.badRequest('Identificador no válido.');
  return parsed.data;
}

/* ------------------------------------------------ mapping writes ---------- */

/** The mapping id, tolerating either `_id` or a projected `id`. */
function mappingIdOf(row: { readonly _id?: string; readonly id?: string }): string | null {
  const value = row._id ?? row.id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function createAdminConsoleRouter(deps: AdminConsoleDeps): Router {
  const router = Router();
  const requireEditor = deps.requireEditor;
  const requireAdmin = deps.requireAdmin;

  /* ------------------------------------------------------------ overview */

  router.get(
    '/overview',
    requireEditor,
    handle(async (request, response) => {
      actorOf(request);
      response.setHeader('cache-control', 'no-store');
      /*
       * Guide coverage is measured by the EPG module; the console reads its totals
       * and adds the two counts it owns (mapping conflicts, legacy alias debt).
       */
      const coverage = await deps.epg.coverage();
      const overview = await deps.console.overview(deps.playback as never);
      response.json({
        data: {
          ...overview,
          sources: {
            ...overview.sources,
            /* A source no gate would expose, counted where the gate can be asked. */
            ineligible: (await deps.console.sourceHealth({ page: 1, pageSize: 1, eligible: false }))
              .pagination.total,
          },
          epg: {
            sources: await countSources(deps),
            mappedChannels: coverage.totals.mapped,
            /* Guide debt: not mapped at all, plus channels mapped only via the legacy alias. */
            missingChannels: coverage.totals.notMapped + await deps.console.legacyAliasMappedCount(),
            staleChannels: coverage.totals.stale,
            failedRuns24h: overview.epg.failedRuns24h,
          },
          operations: {
            jobs: scheduledJobList().length,
            paused: (await pausedJobNames(deps)).length,
            failed: overview.operations.failed,
          },
        },
      });
    }),
  );

  /* ----------------------------------------------------------- catalogue */

  router.get(
    '/catalogue',
    requireEditor,
    handle(async (request, response) => {
      actorOf(request);
      const query = parseQuery(adminCatalogueQuerySchema, request) as AdminCatalogueQuery;
      response.json(await deps.console.catalogue(query, deps.playback as never));
    }),
  );

  router.get(
    '/catalogue/:id',
    requireEditor,
    handle(async (request, response) => {
      actorOf(request);
      const id = requireId(request);
      response.json({ data: await deps.console.detail(id, deps.playback as never) });
    }),
  );

  router.post(
    '/catalogue/:id/identity',
    requireEditor,
    handle(async (request, response) => {
      const actor = actorOf(request);
      const id = requireId(request);
      const input = parseBody(adminIdentityInputSchema, request) as AdminIdentityInput;
      /*
       * Identity is an editorial edit, so it goes through the service that owns
       * channel writes: it enforces optimistic concurrency, recomputes the search
       * text and records the revision an operator can revert.
       */
      const updated = await deps.editorial.updateChannel(
        id,
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.shortName === undefined ? {} : { shortName: input.shortName }),
          ...(input.country === undefined ? {} : { country: input.country }),
          ...(input.language === undefined ? {} : { language: input.language }),
          ...(input.category === undefined ? {} : { category: input.category }),
          ...(input.regionCode === undefined
            ? {}
            : { region: input.regionCode === null ? null : regionOf(input.regionCode) }),
          reason: input.reason,
        },
        actor,
        requestIdOf(response),
      );
      response.json({ data: await deps.console.detail(updated._id, deps.playback as never) });
    }),
  );

  /* ---------------------------------------------------------- duplicates */

  router.get(
    '/duplicates',
    requireEditor,
    handle(async (request, response) => {
      actorOf(request);
      const groups = await deps.console.duplicateGroups();
      response.json({ data: groups, total: groups.length });
    }),
  );

  router.post(
    '/duplicates/:id/merge',
    requireEditor,
    handle(async (request, response) => {
      const actor = actorOf(request);
      /*
       * A group id is the deterministic hash `AdminConsoleService` emits for a
       * signal, not one of our UUIDs, so it is length-bounded rather than
       * UUID-validated: rejecting it as "invalid identifier" would make every
       * real merge impossible.
       */
      const groupId = z.string().min(1).max(128).safeParse(request.params['id']);
      if (!groupId.success) throw AppError.badRequest('Identificador de grupo no válido.');
      const body = parseBody(
        z.object({ primaryId: z.string().uuid().optional(), mergeId: z.string().uuid().optional(), reason: z.string().min(3).max(400) }),
        request,
      );
      const groups = await deps.console.duplicateGroups();
      const group = groups.find((entry) => entry.key === groupId.data);
      if (!group) throw AppError.notFound('Grupo de duplicados no encontrado.');
      const duplicateId = body.mergeId ?? ([...group.channelIds].reverse().find((entry) => entry !== group.suggestedPrimary) ?? null);
      const survivorId = body.primaryId ?? group.suggestedPrimary;
      if (duplicateId === null || survivorId === null) {
        throw AppError.badRequest('El grupo no contiene dos canales distintos que fusionar.');
      }
      if (!group.channelIds.includes(duplicateId) || !group.channelIds.includes(survivorId)) {
        throw AppError.badRequest('Los canales indicados no pertenecen a este grupo de duplicados.');
      }
      /* The merge itself is the existing, audited service operation. */
      const merged = await deps.editorial.mergeChannels(
        survivorId,
        { duplicateId, reason: body.reason },
        actor,
        requestIdOf(response),
      );
      response.json({ data: await deps.console.detail(merged._id, deps.playback as never) });
    }),
  );

  /* -------------------------------------------------------- source health */

  router.get(
    '/sources/health',
    requireEditor,
    handle(async (request, response) => {
      actorOf(request);
      const query = parseQuery(adminSourceHealthQuerySchema, request);
      const page = await deps.console.sourceHealth(query);
      response.json(page);
    }),
  );

  router.get(
    '/sources/:id/history',
    requireEditor,
    handle(async (request, response) => {
      actorOf(request);
      const id = requireId(request);
      const history = await deps.console.sourceHistory(id);
      response.json({ data: history });
    }),
  );

  router.post(
    '/sources/:id/verify',
    requireEditor,
    handle(async (request, response) => {
      const actor = actorOf(request);
      const id = requireId(request);
      /* The existing, audited verification path: no second probe implementation. */
      const result = await deps.sources.verify(id, deps.egressOptions, actor, requestIdOf(response));
      response.json({ data: result });
    }),
  );

  router.post(
    '/sources/:id/assign',
    requireEditor,
    handle(async (request, response) => {
      const actor = actorOf(request);
      const id = requireId(request);
      const input = parseBody(adminSourceAssignInputSchema, request);
      if (input.sourceId !== id) {
        throw AppError.badRequest('El identificador de la fuente no coincide con el de la ruta.');
      }
      /*
       * Assignment re-points an existing source at a channel. It is expressed as the
       * audited `update` the sources service already owns, so the revision counter
       * and the audit entry come from the same place as every other source write.
       */
      const updated = await deps.sources.assign(
        id,
        { channelId: input.channelId, reason: input.reason },
        actor,
        requestIdOf(response),
      );
      response.json({ data: { sourceId: updated._id, channelId: updated.channelId } });
    }),
  );

  router.post(
    '/sources/:id/remove',
    requireEditor,
    handle(async (request, response) => {
      const actor = actorOf(request);
      const id = requireId(request);
      const input = parseBody(adminSourceRemoveInputSchema, request);
      /*
       * Removal is WITHDRAWAL: the source stops being public, its verification
       * history and provenance stay. Deleting the row would destroy the record of
       * why a stream was ever exposed.
       */
      const updated = await deps.sources.withdraw(id, actor, requestIdOf(response), input.reason);
      response.json({ data: { sourceId: updated._id, editorialStatus: updated.editorialStatus } });
    }),
  );

  /* ------------------------------------------------------------- EPG reads */

  router.get(
    '/epg/coverage',
    requireEditor,
    handle(async (request, response) => {
      actorOf(request);
      const query = parseQuery(
        z.object({ country: z.string().min(2).max(3).optional(), status: z.enum(['fresh', 'stale', 'empty', 'not-mapped']).optional() }),
        request,
      );
      const coverage = await deps.epg.coverage();
      const filtered = await deps.console.epgCoverage(coverage, query);
      const legacyMapped = await deps.console.legacyAliasMappedCount();
      response.json({
        data: {
          entries: filtered.entries,
          totals: { ...filtered.totals, notMapped: filtered.totals.notMapped + legacyMapped },
          conflicts: filtered.conflicts,
          asOf: filtered.asOf,
        },
        attribution: { notices: [], includesThirdPartyData: false },
      });
    }),
  );

  router.get(
    '/epg/mappings',
    requireEditor,
    handle(async (request, response) => {
      actorOf(request);
      const query = parseQuery(
        z.object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(200).default(50),
          status: z.enum(['proposed', 'confirmed', 'rejected']).optional(),
          channelId: z.string().uuid().optional(),
          epgSourceId: z.string().uuid().optional(),
          conflicted: z.enum(['true', 'false']).optional(),
        }),
        request,
      );
      const page = await deps.console.mappings({
        ...query,
        conflicted: query.conflicted === undefined ? undefined : query.conflicted === 'true',
      });
      response.json(page);
    }),
  );

  router.get(
    '/epg/ingestion-runs',
    requireEditor,
    handle(async (request, response) => {
      actorOf(request);
      const query = parseQuery(
        z.object({
          sourceId: z.string().uuid().optional(),
          status: z.enum(['ok', 'failed']).optional(),
          failuresOnly: z.enum(['true', 'false']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        request,
      );
      const runs: EpgSyncRun[] = await deps.console.ingestionRuns({
        ...query,
        failuresOnly: query.failuresOnly === 'true',
      });
      response.json({ data: runs });
    }),
  );

  router.get(
    '/epg/sources',
    requireEditor,
    handle(async (request, response) => {
      actorOf(request);
      const docs = await deps.database
        .collection<EpgSourceDoc>(COLLECTIONS.epgSources)
        .find({})
        .sort({ name: 1 })
        .toArray();
      /* Explicit allow-list: the feed URL and licence text are not in this payload. */
      response.json({
        data: docs.map((doc) => ({
          id: doc._id,
          name: doc.name,
          kind: doc.kind,
          ingestionEnabled: doc.ingestionEnabled,
          status: doc.status,
          lastRunAt: doc.lastRunAt?.toISOString() ?? null,
          lastRunStatus: doc.lastRunStatus,
          lastRunProgrammes: doc.lastRunProgrammes,
        })),
      });
    }),
  );

  /* ------------------------------------------------------------ EPG writes */

  router.post(
    '/epg/mappings',
    requireEditor,
    handle(async (request, response) => {
      const actor = actorOf(request);
      const input = parseBody(
        z.object({
          channelId: z.string().uuid(),
          epgSourceId: z.string().uuid().nullable().default(null),
          externalId: z.string().min(1).max(200),
          namespace: z.string().min(1).max(40).default('epg'),
          confidence: z.number().min(0).max(1).default(1),
        }),
        request,
      );
      const propose = deps.epg.proposeMapping;
      if (propose === undefined) throw AppError.unavailable(EPG_WRITES_UNAVAILABLE);
      const created = await propose.call(deps.epg, {
        channelId: input.channelId,
        epgSourceId: input.epgSourceId,
        externalId: input.externalId,
        namespace: input.namespace,
        confidence: input.confidence,
      }, actor);
      response.status(201).json({ data: created });
    }),
  );

  const mappingDecision = (decision: 'confirm' | 'reject'): RequestHandler =>
    handle(async (request, response) => {
      const actor = actorOf(request);
      /*
       * A mapping id is `EpgMappingDoc._id`, a stable compound key rather than one
       * of our UUIDs, so it is length-bounded here and not UUID-validated.
       */
      const mappingId = z.string().min(1).max(200).safeParse(request.params['id']);
      if (!mappingId.success) throw AppError.badRequest('Identificador de mapeo no válido.');
      const input = parseBody(adminMappingDecisionInputSchema, request);
      const decide = decision === 'confirm' ? deps.epg.confirmMapping : deps.epg.rejectMapping;
      if (decide === undefined) throw AppError.unavailable(EPG_WRITES_UNAVAILABLE);
      const result = await decide.call(deps.epg, mappingId.data, actor);
      deps.logger?.info(
        { mappingId: mappingId.data, decision, actor: actor.id, reason: input.reason },
        'epg mapping decided',
      );
      response.json({ data: result });
    });

  router.post('/epg/mappings/:id/confirm', requireEditor, mappingDecision('confirm'));
  router.post('/epg/mappings/:id/reject', requireEditor, mappingDecision('reject'));

  router.post(
    '/epg/ingest',
    requireAdmin,
    handle(async (request, response) => {
      const actor = actorOf(request);
      const input = parseBody(z.object({ sourceId: z.string().uuid() }), request);
      /* The existing ingestion path: it records its own run row, success or failure. */
      const result = await deps.ingestion.runSource(
        input.sourceId,
        deps.egressOptions,
        `manual:${actor.id}`,
      );
      response.json({ data: result });
    }),
  );

  /* ----------------------------------------------------------- operations */

  router.get(
    '/operations/jobs',
    requireEditor,
    handle(async (request, response) => {
      actorOf(request);
      const [jobs, paused] = await Promise.all([buildJobs(deps), pausedJobNames(deps)]);
      response.json({
        data: jobs,
        summary: {
          jobs: jobs.length,
          paused: paused.length,
          failed: jobs.filter((job) => job.lastStatus === 'failed').length,
        },
      });
    }),
  );

  const jobControl = (paused: boolean): RequestHandler =>
    handle(async (request, response) => {
      const actor = actorOf(request);
      const name = typeof request.params['name'] === 'string' ? request.params['name'] : '';
      const input = parseBody(adminJobControlInputSchema, request);
      /*
       * Only a job this process actually scheduled can be controlled. Saying
       * "paused" about a job that does not run would report a control that has no
       * effect, which is the failure mode this endpoint exists to avoid.
       */
      if (scheduledJob(name) === undefined) {
        throw AppError.notFound('Trabajo no registrado en este proceso.');
      }
      const change = paused
        ? await deps.jobControl.pause(name, actor, input.reason, requestIdOf(response))
        : await deps.jobControl.resume(name, actor, input.reason, requestIdOf(response));
      deps.logger?.info({ job: name, paused, changed: change.changed, actor: actor.id }, 'job control changed');
      response.json({ data: { name: change.name, paused: change.state.paused, changed: change.changed } });
    });

  router.post('/operations/jobs/:name/pause', requireAdmin, jobControl(true));
  router.post('/operations/jobs/:name/resume', requireAdmin, jobControl(false));

  router.get(
    '/operations/errors',
    requireEditor,
    handle(async (request, response) => {
      actorOf(request);
      const query = parseQuery(
        z.object({
          hours: z.coerce.number().int().min(1).max(24 * 30).default(24 * 7),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(50),
        }),
        request,
      );
      const result = await deps.console.operationalErrors(query);
      response.json({ data: result.data, since: result.since, total: result.total });
    }),
  );

  router.get(
    '/operations/metrics',
    requireEditor,
    handle(async (request, response) => {
      actorOf(request);
      response.setHeader('cache-control', 'no-store');
      response.json(adminMetricsResponseSchema.parse({ data: await deps.metrics() }));
    }),
  );

  /*
   * No catch-all here on purpose. This router is mounted with `router.use('/admin',
   * …)` BEFORE the 02D verification router, so a terminal `next(error)` would answer
   * 404 for every `/admin/verification/*` path that legitimately follows it. An
   * unmatched path simply falls through and the application's own 404 handler
   * reports it, which is also what keeps the two routers composable.
   */

  return router;
}

/* ------------------------------------------------------------------------- *
 * Small compositions that need both the console and the context
 * ------------------------------------------------------------------------- */

/** How many registered guide sources exist (a count, never the feed). */
async function countSources(deps: AdminConsoleDeps): Promise<number> {
  return deps.database.collection<EpgSourceDoc>(COLLECTIONS.epgSources).countDocuments({});
}

async function pausedJobNames(deps: AdminConsoleDeps): Promise<string[]> {
  const paused = await deps.jobControl.pausedJobs();
  return [...paused.keys()];
}

/**
 * The operations view: every job this process scheduled, joined with the last
 * recorded run and the operator's pause flag.
 *
 * `lastStatus` is `never` when no run was ever recorded — an absent row is not a
 * success, and `running` when the scheduler is mid-run.
 */
/** The recorded run row, as the operations view reads it. */
interface JobRunDocSummary {
  readonly _id: string;
  readonly job: string;
  readonly status: 'ok' | 'failed';
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly message: string | null;
}

async function buildJobs(deps: AdminConsoleDeps) {
  const registered = scheduledJobList();
  const paused = await deps.jobControl.pausedJobs();
  const rows: Array<{
    name: string;
    paused: boolean;
    lastStatus: 'never' | 'running' | 'ok' | 'failed';
    lastStartedAt: string | null;
    lastFinishedAt: string | null;
    lastDurationMs: number | null;
    consecutiveFailures: number;
    lastError: string | null;
  }> = [];
  for (const job of registered) {
    const run = await deps.database
      .collection<JobRunDocSummary>(COLLECTIONS.jobRuns)
      .findOne({ job: job.name }, { sort: { startedAt: -1 } });
    const recent = await deps.database
      .collection<Pick<JobRunDocSummary, '_id' | 'job' | 'status'>>(COLLECTIONS.jobRuns)
      .find({ job: job.name })
      .sort({ startedAt: -1 })
      .limit(20)
      .toArray();
    let consecutiveFailures = 0;
    for (const entry of recent) {
      if (entry.status !== 'failed') break;
      consecutiveFailures += 1;
    }
    rows.push({
      name: job.name,
      paused: paused.has(job.name),
      lastStatus: run === null ? 'never' : run.status,
      lastStartedAt: run?.startedAt.toISOString() ?? null,
      lastFinishedAt: run?.finishedAt.toISOString() ?? null,
      lastDurationMs: run === null ? null : Math.max(run.finishedAt.getTime() - run.startedAt.getTime(), 0),
      consecutiveFailures,
      /* A generic class, never the raw message which can name a third-party host. */
      lastError: run?.status === 'failed' ? 'job-failed' : null,
    });
  }
  return rows;
}

/** Maps a region code to the stored region shape, using the canonical taxonomy. */
function regionOf(code: string): { code: string; name: string } {
  const known = regionByCode(code);
  /*
   * A code outside the Spanish taxonomy keeps the code as its label rather than
   * inventing a name: region names are taxonomy data, not a guess.
   */
  return { code, name: known?.name ?? code };
}
