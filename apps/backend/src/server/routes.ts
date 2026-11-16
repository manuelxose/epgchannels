/**
 * Route modules for API v1.
 *
 * Every handler validates its input with the shared Zod contract, then answers
 * with the matching shared response schema shape. Errors are thrown as
 * `AppError` and rendered by the one error middleware.
 */
import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  channelListQuerySchema,
  epgFeedQuerySchema,
  scheduleQuerySchema,
  auditListQuerySchema,
  createChannelInputSchema,
  updateChannelInputSchema,
  mergeChannelInputSchema,
  createSourceInputSchema,
  updateSourceInputSchema,
  apiVersion,
} from './schemas.js';
import type { Logger } from '../infrastructure/logging.js';
import type { AppContext } from './context.js';
import { AppError } from './errors.js';
import { ChannelsService, attributionFor, toChannel } from '../modules/channels/channels.service.js';
import { buildDescriptor, sourceIssues } from '../modules/playback/playback.service.js';
import { decidePublication } from '../modules/playback/publication-policy.js';
import { providerRegistry } from '../modules/providers/providers.registry.js';
import type { ChannelDoc, EpgSourceDoc, JobRunDoc, PlaybackSourceDoc } from '../infrastructure/schema.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import { CATEGORY_LABELS, CATEGORY_ORDER, SPAIN_REGIONS } from '../shared/taxonomy.js';

const uuid = z.string().uuid();
const slugParam = z.string().min(1).max(120);

function requestIdOf(response: { locals: Record<string, unknown> }): string {
  return String(response.locals['requestId'] ?? 'unknown');
}

async function adminChannelPayload(context: AppContext, channel: ChannelDoc) {
  const sources = await context.database
    .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
    .find({ channelId: channel._id })
    .sort({ priority: 1 })
    .toArray();
  /*
   * The admin payload reports the same playback status the public API does, so
   * it must consult the same authorization decisions; otherwise an operator
   * would see a source as playable that the public sees refused, or the reverse.
   */
  const descriptor = buildDescriptor(
    channel,
    sources,
    new Date(),
    new Map(),
    new Set(),
    await context.playback.authorizationsFor(sources),
  );
  const publicChannel = toChannel(channel, sources, descriptor.playback.status);
  return {
    ...publicChannel,
    timezone: channel.timezone,
    sourceRecords: sources.map((source) => {
      const decision = decidePublication({
        channelStatus: channel.editorialStatus,
        sourceStatus: source.editorialStatus,
        permission: source.permission as never,
        technicalStatus: source.technicalStatus,
        conditions: source.conditions,
      });
      return {
        id: source._id,
        provider: source.provider,
        type: source.type,
        url: source.url,
        permission: source.permission,
        technicalStatus: source.technicalStatus,
        editorialStatus: source.editorialStatus,
        priority: source.priority,
        lastVerifiedAt: source.lastVerifiedAt?.toISOString() ?? null,
        publiclyExposed: decision.public,
        exclusionReason: decision.public ? null : decision.reason,
      };
    }),
    // The admin view explains every source the public API hides.
    issues: sourceIssues(sources),
  };
}

export function createRouter(context: AppContext, logger: Logger): Router {
  const router = Router();
  const channels = new ChannelsService(context.database);

  /** Runs an async handler and forwards rejections to the error middleware. */
  const handle =
    (handler: RequestHandler): RequestHandler =>
    (request, response, next) => {
      Promise.resolve(handler(request, response, next)).catch(next);
    };

  /** Validates a request part against a contract schema, or fails with 400. */
  function parse<T extends z.ZodTypeAny>(
    schema: T,
    source: 'query' | 'body' | 'params',
    request: Request,
  ): z.output<T> {
    const raw =
      source === 'body' ? request.body : source === 'params' ? request.params : request.query;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.validation(
        'Parámetros no válidos.',
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      );
    }
    return parsed.data as z.output<T>;
  }

  function requireSlug(request: Request): string {
    const parsed = slugParam.safeParse(request.params['slug']);
    if (!parsed.success) throw AppError.badRequest('Slug no válido.');
    return parsed.data;
  }

  function requireId(request: Request): string {
    const parsed = uuid.safeParse(request.params['id']);
    if (!parsed.success) throw AppError.badRequest('Identificador no válido.');
    return parsed.data;
  }

  const actorOf = (request: Request) => ({
    type: 'user' as const,
    id: request.admin?.email ?? 'unknown',
  });

  // ---------------------------------------------------------------- health
  router.get(
    '/health',
    handle(async (_request, response) => {
      const dependencies: Array<{
        name: string;
        state: string;
        latencyMs: number | null;
        message: string | null;
      }> = [];
      let databaseUp = true;
      try {
        const latency = await context.database.ping();
        dependencies.push({ name: 'mongodb', state: 'up', latencyMs: latency, message: null });
      } catch (error) {
        databaseUp = false;
        dependencies.push({
          name: 'mongodb',
          state: 'down',
          latencyMs: null,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (context.cache.enabled) {
        const latency = await context.cache.ping();
        dependencies.push({
          name: 'redis',
          state: latency === null ? 'down' : 'up',
          latencyMs: latency,
          message: latency === null ? 'La caché no responde; se sirve desde la base de datos.' : null,
        });
      } else {
        dependencies.push({ name: 'redis', state: 'disabled', latencyMs: null, message: 'Caché no configurada.' });
      }
      const counts = databaseUp
        ? await channels.counts()
        : { channels: 0, publishedChannels: 0, sources: 0, programmes: 0 };
      const status = !databaseUp ? 'down' : counts.publishedChannels === 0 ? 'degraded' : 'ok';
      response.status(databaseUp ? 200 : 503).json({
        status,
        version: context.version,
        apiVersion,
        uptimeSeconds: Math.round(process.uptime()),
        now: new Date().toISOString(),
        dependencies,
        data: counts,
      });
    }),
  );

  // -------------------------------------------------------------- channels
  router.get(
    '/channels',
    handle(async (request, response) => {
      const query = parse(channelListQuerySchema, 'query', request);
      const result = await context.channels.list(
        {
          q: query.q,
          country: query.country,
          region: query.region,
          category: query.category,
          language: query.language,
          playable: query.playable,
          sort: query.sort,
        },
        query.page,
        query.pageSize,
        context.playback,
      );
      response.json(result);
    }),
  );

  router.get(
    '/channels/:slug',
    handle(async (request, response) => {
      const result = await context.channels.bySlug(requireSlug(request), context.playback);
      if (!result) throw AppError.notFound('Canal no encontrado.');
      response.json(result);
    }),
  );

  router.get(
    '/channels/:slug/playback',
    handle(async (request, response) => {
      const descriptor = await context.playback.descriptorForSlug(requireSlug(request));
      if (!descriptor) throw AppError.notFound('Canal no encontrado.');
      response.json({ data: descriptor });
    }),
  );

  router.get(
    '/channels/:slug/schedule',
    handle(async (request, response) => {
      const slug = requireSlug(request);
      const query = parse(scheduleQuerySchema, 'query', request);
      const channel = await context.playback.findChannel(slug);
      if (!channel) throw AppError.notFound('Canal no encontrado.');
      const from = query.from ? new Date(query.from) : new Date();
      response.json(await context.epg.scheduleFor(channel, from, query.hours));
    }),
  );

  // ------------------------------------------------------------------- epg
  const feedHandler =
    (mode: 'now' | 'next'): RequestHandler =>
    async (request, response) => {
      const query = parse(epgFeedQuerySchema, 'query', request);
      const at = query.from ? new Date(query.from) : new Date();
      const filter: Record<string, unknown> = { editorialStatus: 'published', mergedInto: null };
      if (query.channel && query.channel.length > 0) filter['slug'] = { $in: query.channel };
      if (query.country) filter['country'] = query.country;
      if (query.category) filter['category'] = query.category;
      const docs = await context.database
        .collection<ChannelDoc>(COLLECTIONS.channels)
        .find(filter)
        .sort({ name: 1 })
        .limit(query.limit)
        .toArray();
      const entries = await context.epg.feed(docs, at, mode);
      response.json({ data: entries, asOf: at.toISOString(), attribution: attributionFor(docs) });
    };

  router.get('/epg/now', handle(feedHandler('now')));
  router.get('/epg/next', handle(feedHandler('next')));

  // ------------------------------------------------------------ categories
  router.get(
    '/categories',
    handle(async (_request, response) => {
      const published = await context.database
        .collection<ChannelDoc>(COLLECTIONS.channels)
        .find({ editorialStatus: 'published', mergedInto: null })
        .toArray();
      const statuses = await context.playback.statusesFor(published);
      const data = CATEGORY_ORDER.map((id) => {
        const list = published.filter((channel) => channel.category === id);
        return {
          id,
          name: CATEGORY_LABELS[id],
          channelCount: list.length,
          playableCount: list.filter((channel) => statuses.get(channel._id) === 'available').length,
        };
      }).filter((entry) => entry.channelCount > 0);
      response.json({ data, attribution: attributionFor(published) });
    }),
  );

  // --------------------------------------------------------------- regions
  router.get(
    '/regions',
    handle(async (_request, response) => {
      const published = await context.database
        .collection<ChannelDoc>(COLLECTIONS.channels)
        .find({ editorialStatus: 'published', mergedInto: null })
        .toArray();
      const statuses = await context.playback.statusesFor(published);
      const playableIn = (list: ChannelDoc[]): number =>
        list.filter((channel) => statuses.get(channel._id) === 'available').length;
      const data = SPAIN_REGIONS.map((region) => {
        const list = published.filter(
          (channel) => channel.country === 'ES' && channel.region?.code === region.code,
        );
        return {
          country: region.country,
          code: region.code,
          name: region.name,
          channelCount: list.length,
          playableCount: playableIn(list),
        };
      }).filter((entry) => entry.channelCount > 0);
      const international = published.filter((channel) => channel.country !== 'ES');
      if (international.length > 0) {
        data.push({
          country: 'INT',
          code: 'INTL',
          name: 'Internacionales',
          channelCount: international.length,
          playableCount: playableIn(international),
        });
      }
      response.json({ data, attribution: attributionFor(published) });
    }),
  );

  // ---------------------------------------------------------- integration
  router.get(
    '/integration/manifest',
    handle((_request, response) => {
      response.json({
        data: {
          apiVersion: 'v1',
          basePath: '/api/v1',
          serverToServer: { requiresApiKey: context.serviceKeyEnabled, supportsSsr: true },
          engines: ['hls', 'dash', 'youtube-iframe', 'official-embed', 'external'],
          endpoints: [
            { method: 'GET', path: '/channels', description: 'Catálogo paginado con filtros y búsqueda.' },
            { method: 'GET', path: '/channels/:slug', description: 'Ficha canónica de un canal.' },
            { method: 'GET', path: '/channels/:slug/playback', description: 'Descriptor de reproducción.' },
            { method: 'GET', path: '/channels/:slug/schedule', description: 'Programación del canal.' },
            { method: 'GET', path: '/epg/now', description: 'Qué se emite ahora.' },
            { method: 'GET', path: '/epg/next', description: 'Qué se emite a continuación.' },
            { method: 'GET', path: '/categories', description: 'Taxonomía canónica con recuentos.' },
            { method: 'GET', path: '/regions', description: 'Comunidades autónomas con recuentos.' },
            { method: 'GET', path: '/integration/guiatv/channels', description: 'Catálogo para GuíaTV.' },
            {
              method: 'GET',
              path: '/integration/guiatv/identity-map',
              description: 'Tabla de correspondencia de identificadores.',
            },
            { method: 'GET', path: '/health', description: 'Estado del servicio y de sus dependencias.' },
          ],
          slugPolicy: { authoritative: 'tdt-platform', guiatvSlugWinsWhenPresent: true },
        },
      });
    }),
  );

  router.get(
    '/integration/guiatv/channels',
    handle(async (request, response) => {
      const query = parse(
        z.object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(200).default(100),
        }),
        'query',
        request,
      );
      const filter = { editorialStatus: 'published', mergedInto: null };
      const collection = context.database.collection<ChannelDoc>(COLLECTIONS.channels);
      const [total, docs] = await Promise.all([
        collection.countDocuments(filter),
        collection
          .find(filter)
          .sort({ name: 1 })
          .skip((query.page - 1) * query.pageSize)
          .limit(query.pageSize)
          .toArray(),
      ]);
      const statuses = await context.playback.statusesFor(docs);
      response.json({
        data: docs.map((channel) => ({
          tdtId: channel._id,
          slug: channel.slug,
          name: channel.name,
          shortName: channel.shortName,
          country: channel.country,
          regionCode: channel.region?.code ?? null,
          category: channel.category,
          kind: channel.kind,
          playbackStatus: statuses.get(channel._id) ?? 'unavailable',
          aliases: channel.aliases,
          guiatvSlug: channel.aliases.find((alias) => alias.namespace === 'guiatv')?.value ?? null,
        })),
        total,
      });
    }),
  );

  router.get(
    '/integration/guiatv/identity-map',
    handle(async (request, response) => {
      const query = parse(
        z.object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(500).default(200),
        }),
        'query',
        request,
      );
      const filter = { editorialStatus: 'published', mergedInto: null };
      const collection = context.database.collection<ChannelDoc>(COLLECTIONS.channels);
      const [total, docs] = await Promise.all([
        collection.countDocuments(filter),
        collection
          .find(filter)
          .sort({ name: 1 })
          .skip((query.page - 1) * query.pageSize)
          .limit(query.pageSize)
          .toArray(),
      ]);
      response.json({
        data: docs.map((channel) => {
          const alias = channel.aliases.find((entry) => entry.namespace === 'guiatv');
          return {
            tdtId: channel._id,
            slug: channel.slug,
            guiatvSlug: alias?.value ?? null,
            match: alias ? 'alias' : 'unmapped',
            updatedAt: channel.updatedAt.toISOString(),
          };
        }),
        pagination: { page: query.page, pageSize: query.pageSize, total },
      });
    }),
  );

  // ----------------------------------------------------------------- admin
  const requireEditor = context.adminAuth.requireRole('editor');
  const requireAdmin = context.adminAuth.requireRole('admin');

  router.post(
    '/auth/bootstrap',
    handle(async (request, response) => {
      response.status(201).json({ data: await context.adminAuth.bootstrap(request.body) });
    }),
  );

  router.post(
    '/auth/login',
    handle(async (request, response) => {
      response.json({ data: await context.adminAuth.login(request.body, requestIdOf(response)) });
    }),
  );

  router.post(
    '/auth/logout',
    handle(async (request, response) => {
      const header = request.headers.authorization;
      await context.adminAuth.logout(
        header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined,
      );
      response.status(204).end();
    }),
  );

  router.get(
    '/admin/me',
    requireEditor,
    handle((request, response) => {
      response.json({ data: request.admin });
    }),
  );

  router.get(
    '/admin/channels',
    requireEditor,
    handle(async (request, response) => {
      const query = parse(
        z.object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(50),
          q: z.string().trim().min(1).max(120).optional(),
          status: z.enum(['draft', 'review', 'published', 'withdrawn']).optional(),
        }),
        'query',
        request,
      );
      const filter: Record<string, unknown> = {};
      if (query.status) filter['editorialStatus'] = query.status;
      if (query.q) filter['searchText'] = { $regex: query.q.toLowerCase(), $options: 'i' };
      const collection = context.database.collection<ChannelDoc>(COLLECTIONS.channels);
      const [total, docs] = await Promise.all([
        collection.countDocuments(filter),
        collection
          .find(filter)
          .sort({ name: 1 })
          .skip((query.page - 1) * query.pageSize)
          .limit(query.pageSize)
          .toArray(),
      ]);
      response.json({
        data: docs.map((doc) => ({
          id: doc._id,
          slug: doc.slug,
          name: doc.name,
          country: doc.country,
          category: doc.category,
          editorialStatus: doc.editorialStatus,
          updatedAt: doc.updatedAt.toISOString(),
        })),
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          pageCount: Math.ceil(total / query.pageSize),
          hasNext: query.page * query.pageSize < total,
          hasPrevious: query.page > 1,
        },
      });
    }),
  );

  router.get(
    '/admin/channels/:id',
    requireEditor,
    handle(async (request, response) => {
      const id = requireId(request);
      const channel = await context.database.collection<ChannelDoc>(COLLECTIONS.channels).findOne({ _id: id });
      if (!channel) throw AppError.notFound('Canal no encontrado.');
      response.json({ data: await adminChannelPayload(context, channel) });
    }),
  );

  router.post(
    '/admin/channels',
    requireEditor,
    handle(async (request, response) => {
      const input = parse(createChannelInputSchema, 'body', request);
      const created = await context.editorial.createChannel(input, actorOf(request), requestIdOf(response));
      response.status(201).json({ data: await adminChannelPayload(context, created) });
    }),
  );

  router.patch(
    '/admin/channels/:id',
    requireEditor,
    handle(async (request, response) => {
      const id = requireId(request);
      const input = parse(updateChannelInputSchema, 'body', request);
      const updated = await context.editorial.updateChannel(id, input, actorOf(request), requestIdOf(response));
      response.json({ data: await adminChannelPayload(context, updated) });
    }),
  );

  router.post(
    '/admin/channels/:id/merge',
    requireEditor,
    handle(async (request, response) => {
      const id = requireId(request);
      const input = parse(mergeChannelInputSchema, 'body', request);
      const merged = await context.editorial.mergeChannels(id, input, actorOf(request), requestIdOf(response));
      response.json({ data: await adminChannelPayload(context, merged) });
    }),
  );

  router.post(
    '/admin/channels/:id/revert',
    requireEditor,
    handle(async (request, response) => {
      const id = requireId(request);
      const input = parse(z.object({ auditId: uuid }), 'body', request);
      const reverted = await context.editorial.revertChannel(
        id,
        input.auditId,
        actorOf(request),
        requestIdOf(response),
      );
      response.json({ data: await adminChannelPayload(context, reverted) });
    }),
  );

  router.get(
    '/admin/sources',
    requireEditor,
    handle(async (request, response) => {
      const query = parse(z.object({ channelId: uuid.optional() }), 'query', request);
      const docs = await context.database
        .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
        .find(query.channelId ? { channelId: query.channelId } : {})
        .sort({ channelId: 1, priority: 1 })
        .toArray();
      response.json({
        data: docs.map((source) => ({
          id: source._id,
          channelId: source.channelId,
          provider: source.provider,
          type: source.type,
          permission: source.permission,
          technicalStatus: source.technicalStatus,
          editorialStatus: source.editorialStatus,
          priority: source.priority,
          lastVerifiedAt: source.lastVerifiedAt?.toISOString() ?? null,
        })),
      });
    }),
  );

  router.post(
    '/admin/sources',
    requireEditor,
    handle(async (request, response) => {
      const input = parse(createSourceInputSchema, 'body', request);
      const created = await context.sources.create(input, actorOf(request), requestIdOf(response));
      response.status(201).json({ data: { id: created._id, channelId: created.channelId } });
    }),
  );

  router.patch(
    '/admin/sources/:id',
    requireEditor,
    handle(async (request, response) => {
      const id = requireId(request);
      const input = parse(updateSourceInputSchema, 'body', request);
      const updated = await context.sources.update(id, input, actorOf(request), requestIdOf(response));
      response.json({ data: { id: updated._id, editorialStatus: updated.editorialStatus } });
    }),
  );

  router.post(
    '/admin/sources/:id/withdraw',
    requireEditor,
    handle(async (request, response) => {
      const id = requireId(request);
      const input = parse(z.object({ reason: z.string().min(3).max(400) }), 'body', request);
      const updated = await context.sources.withdraw(id, actorOf(request), requestIdOf(response), input.reason);
      response.json({ data: { id: updated._id, editorialStatus: updated.editorialStatus } });
    }),
  );

  router.post(
    '/admin/sources/:id/verify',
    requireEditor,
    handle(async (request, response) => {
      const id = requireId(request);
      const result = await context.sources.verify(id, context.egressOptions, actorOf(request), requestIdOf(response));
      response.json({ data: result });
    }),
  );

  router.get(
    '/admin/audits',
    requireEditor,
    handle(async (request, response) => {
      const query = parse(auditListQuerySchema, 'query', request);
      const { entries, total } = await context.editorial.listAudits(query, query.page, query.pageSize);
      response.json({
        data: entries,
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          pageCount: Math.ceil(total / query.pageSize),
          hasNext: query.page * query.pageSize < total,
          hasPrevious: query.page > 1,
        },
      });
    }),
  );

  router.get(
    '/admin/providers',
    requireEditor,
    handle((_request, response) => {
      response.json({ data: providerRegistry.list() });
    }),
  );

  router.get(
    '/admin/jobs',
    requireEditor,
    handle(async (_request, response) => {
      const runs = await context.database
        .collection<JobRunDoc>(COLLECTIONS.jobRuns)
        .find({})
        .sort({ startedAt: -1 })
        .limit(50)
        .toArray();
      response.json({
        data: runs.map((run) => ({
          id: run._id,
          job: run.job,
          status: run.status,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt.toISOString(),
          message: run.message,
          details: run.details,
        })),      });
    }),
  );

  router.get(
    '/admin/epg-sources',
    requireEditor,
    handle(async (_request, response) => {
      const docs = await context.database
        .collection<EpgSourceDoc>(COLLECTIONS.epgSources)
        .find({})
        .sort({ name: 1 })
        .toArray();
      response.json({
        data: docs.map((doc) => ({
          id: doc._id,
          name: doc.name,
          kind: doc.kind,
          url: doc.url,
          licence: doc.licence,
          attribution: doc.attribution,
          ingestionEnabled: doc.ingestionEnabled,
          status: doc.status,
          lastRunAt: doc.lastRunAt?.toISOString() ?? null,
          lastRunStatus: doc.lastRunStatus,
          lastRunProgrammes: doc.lastRunProgrammes,
          createdAt: doc.createdAt.toISOString(),
          updatedAt: doc.updatedAt.toISOString(),
        })),      });
    }),
  );

  router.post(
    '/admin/epg/ingest',
    requireAdmin,
    handle(async (request, response) => {
      const input = parse(z.object({ sourceId: uuid }), 'body', request);
      const result = await context.epgIngestion.runSource(
        input.sourceId,
        context.egressOptions,
        `manual:${actorOf(request).id}`,
      );
      response.json({ data: result });
    }),
  );

  router.post(
    '/admin/epg/programmes',
    requireEditor,
    handle(async (request, response) => {
      const input = parse(
        z.object({
          channelId: uuid,
          title: z.string().min(1).max(300),
          description: z.string().max(2000).default(''),
          genre: z.string().max(80).nullable().default(null),
          coverUrl: z.string().url().nullable().default(null),
          start: z.string().datetime({ offset: true }),
          end: z.string().datetime({ offset: true }),
        }),
        'body',
        request,
      );
      const created = await context.epg.createEditorialProgramme(input, `manual:${actorOf(request).id}`);
      response.status(201).json({ data: created });
    }),
  );

  logger.debug('api v1 routes registered');
  return router;
}
