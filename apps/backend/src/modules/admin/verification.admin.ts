/**
 * Operator-only verification endpoints (`TDT-API-02D` §5).
 *
 * **This router is not mounted anywhere by itself.** It is a factory so the
 * wiring stays in the hands of whoever owns `server/app.ts` / `server/routes.ts`:
 *
 * ```ts
 * // apps/backend/src/server/routes.ts, inside createRouter(), after `requireAdmin`:
 * router.use(
 *   '/admin',
 *   requireAdmin,
 *   createVerificationAdminRouter({
 *     database: context.database,
 *     queue: context.verification.queue,
 *     scheduler: context.verification.scheduler,
 *     controls: context.verification.controls,
 *     metrics: context.verification.metrics,
 *   }),
 * );
 * ```
 *
 * Every route sits behind `requireRole('admin')`: pause-all and manual retries
 * change what the platform asks third parties for, which is an administrator's
 * decision, not an editor's. Nothing here is reachable from the public surface,
 * and nothing here echoes a URL: the status view reports counts by closed
 * vocabularies plus host *buckets*, never a host or a query string.
 */
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import { AppError } from '../../server/errors.js';
import type { Logger } from '../../infrastructure/logging.js';
import type { VerificationMetrics } from '../../verification/metrics.js';
import type { VerificationScheduler } from '../../verification/scheduler.js';
import type { VerificationControls, ControlActor } from '../../verification/controls.js';
import type { QueueBackend } from '../../verification/queue.js';

export interface VerificationAdminDeps {
  readonly database: DatabaseHandle;
  readonly queue: QueueBackend;
  readonly scheduler: Pick<VerificationScheduler, 'statusGrid' | 'reconcile'>;
  readonly controls: VerificationControls;
  readonly metrics: VerificationMetrics;
  readonly logger?: Logger;
  /**
   * Role guard. The wiring passes `context.adminAuth.requireRole('admin')`;
   * omitting it makes every route refuse with 503 rather than run unauthenticated.
   */
  readonly requireAdmin?: RequestHandler;
}

const sourceIdSchema = z.string().min(1).max(200);
const reasonSchema = z.string().trim().min(3).max(400);
const retrySchema = z.object({
  reason: reasonSchema,
  /** Manual browser verification is opt-in per request (scheduled rounds never do it). */
  browser: z.boolean().default(false),
});

/** Wraps an async handler so a rejection reaches the application error middleware. */
function handle(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function requestIdOf(response: Response): string {
  const id = response.locals?.['requestId'];
  return typeof id === 'string' ? id : 'unknown';
}

/** Actor from the authenticated principal; never from the request body. */
function actorOf(request: Request): ControlActor {
  const email = request.admin?.email;
  if (typeof email !== 'string' || email.length === 0) {
    throw AppError.unauthorized('Sesión administrativa requerida.');
  }
  return { type: 'user', id: email };
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

function parseSourceId(request: Request): string {
  const parsed = sourceIdSchema.safeParse(request.params['id']);
  if (!parsed.success) throw AppError.badRequest('Identificador de fuente no válido.');
  return parsed.data;
}

/** The guard that refuses when the deployment forgot to wire authentication. */
function guardOf(deps: VerificationAdminDeps): RequestHandler {
  const guard = deps.requireAdmin;
  if (guard === undefined) {
    return (_request, _response, next) => {
      next(AppError.unavailable('Los endpoints de verificación no están protegidos: falta el guardia de administración.'));
    };
  }
  return guard;
}

export function createVerificationAdminRouter(deps: VerificationAdminDeps): Router {
  const router = Router();
  const requireAdmin = guardOf(deps);

  // Everything below is operator-only. Registered first so no route can bypass it.
  router.use((request: Request, _response: Response, next: NextFunction) => {
    if (request.method === 'OPTIONS') {
      next();
      return;
    }
    requireAdmin(request, _response, next);
  });

  router.get(
    '/verification/status',
    handle(async (_request, response) => {
      const grid = await deps.scheduler.statusGrid();
      const switches = await deps.controls.switches();
      const byCategory = await failureCategories(deps.database);
      const depth = await deps.queue.depth();
      response.setHeader('cache-control', 'no-store');
      response.json({
        data: {
          checks: grid.checks,
          sources: grid.sources,
          failures: byCategory,
          circuitsOpen: grid.circuitsOpen,
          queue: { ...grid.queue, depth },
          paused: { all: switches.all, providers: switches.providers },
          at: new Date().toISOString(),
        },
      });
    }),
  );

  router.post(
    '/verification/sources/:id/pause',
    handle(async (request, response) => {
      const actor = actorOf(request);
      const sourceId = parseSourceId(request);
      const body = parseBody(z.object({ reason: reasonSchema.optional() }).default({}), request);
      const result = await deps.controls.pauseSource(sourceId, actor, body.reason ?? null, requestIdOf(response));
      deps.logger?.info({ sourceId, actor: actor.id }, 'verification source paused');
      response.json({ data: result });
    }),
  );

  router.post(
    '/verification/sources/:id/resume',
    handle(async (request, response) => {
      const actor = actorOf(request);
      const sourceId = parseSourceId(request);
      const body = parseBody(z.object({ reason: reasonSchema.optional() }).default({}), request);
      const result = await deps.controls.resumeSource(sourceId, actor, body.reason ?? null, requestIdOf(response));
      deps.logger?.info({ sourceId, actor: actor.id }, 'verification source resumed');
      response.json({ data: result });
    }),
  );

  router.post(
    '/verification/sources/:id/retry',
    handle(async (request, response) => {
      const actor = actorOf(request);
      const sourceId = parseSourceId(request);
      const body = parseBody(retrySchema, request);
      const result = await deps.controls.manualRetry(sourceId, actor, body.reason, requestIdOf(response), {
        browser: body.browser,
      });
      deps.logger?.info({ sourceId, actor: actor.id, browser: body.browser }, 'verification manual retry queued');
      response.status(202).json({ data: result });
    }),
  );

  router.post(
    '/verification/pause-all',
    handle(async (request, response) => {
      const actor = actorOf(request);
      const body = parseBody(z.object({ reason: reasonSchema.optional() }).default({}), request);
      const result = await deps.controls.pauseAll(actor, body.reason ?? null, requestIdOf(response));
      response.json({ data: result });
    }),
  );

  router.post(
    '/verification/resume-all',
    handle(async (request, response) => {
      const actor = actorOf(request);
      const body = parseBody(z.object({ reason: reasonSchema.optional() }).default({}), request);
      const result = await deps.controls.resumeAll(actor, body.reason ?? null, requestIdOf(response));
      response.json({ data: result });
    }),
  );

  router.post(
    '/verification/reconcile',
    handle(async (_request, response) => {
      const report = await deps.scheduler.reconcile(new Date());
      response.json({ data: report });
    }),
  );

  router.get('/verification/metrics', (_request, response) => {
    response.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.end(deps.metrics.render());
  });

  return router;
}

/** Failure counts by category, from the immutable check rows. */
async function failureCategories(database: DatabaseHandle): Promise<Array<{ category: string; count: number }>> {
  const collection = database.db.collection('source_health_checks_02d');
  const rows = await collection
    .aggregate<{ _id: string; count: number }>([
      { $match: { state: 'failed', 'failure.cause': { $exists: true } } },
      { $group: { _id: '$failure.cause', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  return rows.map((row) => ({ category: row._id, count: row.count }));
}

/** Documented wiring, exported so a test can assert it stays out of the public router. */
export const VERIFICATION_ADMIN_WIRING = [
  "import { createVerificationAdminRouter } from '../modules/admin/verification.admin.js';",
  "router.use('/admin', requireAdmin, createVerificationAdminRouter({",
  '  database: context.database,',
  '  queue: context.verification.queue,',
  '  scheduler: context.verification.scheduler,',
  '  controls: context.verification.controls,',
  '  metrics: context.verification.metrics,',
  '  requireAdmin,',
  '}));',
] as const;
