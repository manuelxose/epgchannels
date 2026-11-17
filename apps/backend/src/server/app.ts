/**
 * Express application factory.
 *
 * The middleware order is deliberate and is the security boundary:
 *
 * 1. request id           → every log line and error body is correlatable;
 * 2. helmet               → conservative headers, no CSP for a pure JSON API;
 * 3. CORS                 → only the configured browser origins;
 * 4. compression + parser → bounded JSON body;
 * 5. metrics              → every request counted;
 * 6. cache headers + ETag → honest caching, 304 on unchanged representations;
 * 7. routes               → Zod-validated input, shared contract output;
 * 8. 404 + error handler  → one error envelope, internal details never leaked.
 */
import express, { type Express } from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import type { Config } from '../config/config.js';
import type { AppContext } from './context.js';
import { AppError } from './errors.js';
import { etagJson } from './etag.js';
import {
  MAX_JSON_BODY_BYTES,
  Metrics,
  createCacheHeaders,
  createMetricsMiddleware,
  createRateLimit,
  requestId,
} from './middleware.js';
import { createRouter } from './routes.js';
import { ResponseCache, invalidateOnWrite, isCacheableCatalogueRead } from './response-cache.js';

export interface AppBundle {
  readonly app: Express;
  readonly metrics: Metrics;
  readonly cache: ResponseCache;
}

/** `/metrics` is operator-only: it is served before the API router. */
export function createApp(config: Config, context: AppContext): AppBundle {
  const app = express();
  const metrics = new Metrics();
  // Catalogue responses derived from the whole collection are cached in-process;
  // response-cache.ts documents exactly what is cached and why.
  const cache = new ResponseCache({
    maxEntries: 256,
    maxAgeMs: Math.max(5_000, config.CACHE_TTL_SECONDS * 1000),
    shouldCache: isCacheableCatalogueRead,
  });

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use(requestId);
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use(
    cors({
      origin(origin, callback) {
        // A server-to-server call has no Origin header and is allowed.
        if (!origin || config.CORS_ORIGINS.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new AppError(403, 'forbidden', 'Origen no autorizado.'));
      },
      methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['content-type', 'authorization', 'x-request-id', 'if-none-match'],
      exposedHeaders: ['etag', 'x-request-id', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset'],
      maxAge: 600,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: MAX_JSON_BODY_BYTES }));
  app.use(createMetricsMiddleware(metrics));

  const rateLimit = createRateLimit({
    windowSeconds: config.RATE_LIMIT_WINDOW_SECONDS,
    maxRequests: config.RATE_LIMIT_MAX_REQUESTS,
    cache: context.cache,
    logger: context.logger,
  });

  // Metrics: never rate limited locally, never cached.
  app.get('/metrics', (_request, response) => {
    response.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.end(metrics.render());
  });

  app.use(
    config.API_BASE_PATH,
    rateLimit,
    createCacheHeaders({ maxAgeSeconds: config.CACHE_TTL_SECONDS, publicResponses: true }),
    // The cache wraps the router; invalidation must wrap the cache, so it is
    // registered *after* it and still observes every response of a write.
    cache.middleware(),
    invalidateOnWrite(cache),
    etagJson,
    createRouter(context, context.logger, metrics),
  );

  // A version-less path is a mistake, not a redirect: consumers must pin v1.
  app.use((request, _response, next) => {
    next(AppError.notFound(`Ruta no encontrada: ${request.method} ${request.path}`));
  });

  app.use(
    (error: unknown, request: express.Request, response: express.Response, _next: express.NextFunction) => {
      const id = String(response.locals['requestId'] ?? 'unknown');
      if (error instanceof AppError) {
        if (error.status >= 500) {
          context.logger.error({ requestId: id, code: error.code, err: error }, 'request failed');
        } else if (error.status === 429) {
          context.logger.warn({ requestId: id, ip: request.ip }, 'rate limited');
        }
        response.status(error.status).json({
          error: {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          },
          requestId: id,
        });
        return;
      }
      // Body parser and other middleware errors carry a status but no taxonomy.
      const candidate = error as { status?: number; type?: string };
      if (candidate?.type === 'entity.too.large') {
        response.status(413).json({
          error: { code: 'payload_too_large', message: 'El cuerpo de la solicitud es demasiado grande.' },
          requestId: id,
        });
        return;
      }
      if (typeof candidate?.status === 'number' && candidate.status >= 400 && candidate.status < 500) {
        response.status(candidate.status).json({
          error: { code: 'bad_request', message: 'Solicitud no válida.' },
          requestId: id,
        });
        return;
      }
      context.logger.error({ requestId: id, err: error }, 'unhandled error');
      response.status(500).json({
        error: { code: 'internal_error', message: 'Error interno del servicio.' },
        requestId: id,
      });
    },
  );

  return { app, metrics, cache };
}
