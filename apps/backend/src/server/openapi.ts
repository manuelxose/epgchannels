/**
 * OpenAPI 3.1 document.
 *
 * Kept next to the routes on purpose: the SDK is generated from this document,
 * so a path added to the router without a contract here shows up as a failed
 * contract test rather than as silent drift.
 */
import { z } from 'zod';
import { zodToJsonSchema } from './zod-to-json.js';
import {
  apiErrorSchema,
  auditEntrySchema,
  categorySchema,
  channelListResponseSchema,
  channelListSchema,
  channelResponseSchema,
  epgFeedEntrySchema,
  identityMappingSchema,
  playbackDescriptorSchema,
  programmeSchema,
  providerSchema,
  regionEntrySchema,
  scheduleResponseSchema,
  verifySourceResultSchema,
  guiatvChannelSchema,
  healthResponseSchema,
  auditListQuerySchema,
  channelListQuerySchema,
  createChannelInputSchema,
  createSourceInputSchema,
  updateChannelInputSchema,
  updateSourceInputSchema,
  // TDT-API-02FG shared contracts (published in the milestone base).
  countryEntrySchema,
  countryListResponseSchema,
  languageEntrySchema,
  channelAvailabilitySchema,
  channelAvailabilityResponseSchema,
  epgCoverageEntrySchema,
  epgCoverageSchema,
} from './schemas.js';
import { epgDayQuerySchema } from '../modules/channels/local-day.js';
import {
  countryRegionEntrySchema,
  countryRegionsResponseSchema,
  publicLanguageListResponseSchema,
} from '../modules/channels/catalogue.aggregates.js';
import { publicChannelListQuerySchema } from '../modules/channels/public-filters.js';

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string; license: { name: string } };
  servers: { url: string; description: string }[];
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
    parameters?: Record<string, unknown>;
  };
  security?: Record<string, string[]>[];
}

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
});

const json = (schema: unknown, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

/** Common headers every response carries. */
const commonHeaders = {
  'x-request-id': { schema: { type: 'string' }, description: 'Identificador de la solicitud.' },
  'ratelimit-remaining': { schema: { type: 'integer' }, description: 'Solicitudes restantes en la ventana.' },
  'cache-control': { schema: { type: 'string' }, description: 'Política de caché de esta respuesta.' },
  etag: { schema: { type: 'string' }, description: 'Validador de representación (usar con If-None-Match).' },
};

export function buildOpenApi(baseUrl: string): OpenApiDocument {
  const schemas = {
    ApiError: zodToJsonSchema(apiErrorSchema),
    HealthResponse: zodToJsonSchema(healthResponseSchema),
    ChannelList: zodToJsonSchema(channelListSchema),
    ChannelListResponse: zodToJsonSchema(channelListResponseSchema),
    ChannelResponse: zodToJsonSchema(channelResponseSchema),
    PlaybackDescriptor: zodToJsonSchema(playbackDescriptorSchema),
    PlaybackResponse: zodToJsonSchema(z.object({ data: playbackDescriptorSchema })),
    Programme: zodToJsonSchema(programmeSchema),
    ScheduleResponse: zodToJsonSchema(scheduleResponseSchema),
    EpgFeedEntry: zodToJsonSchema(epgFeedEntrySchema),
    EpgFeedResponse: zodToJsonSchema(
      z.object({
        data: z.array(epgFeedEntrySchema),
        asOf: z.string(),
        attribution: z.object({ notices: z.array(z.string()), includesThirdPartyData: z.boolean() }),
      }),
    ),
    Category: zodToJsonSchema(categorySchema),
    CategoryListResponse: zodToJsonSchema(
      z.object({
        data: z.array(categorySchema),
        attribution: z.object({ notices: z.array(z.string()), includesThirdPartyData: z.boolean() }),
      }),
    ),
    RegionEntry: zodToJsonSchema(regionEntrySchema),
    RegionListResponse: zodToJsonSchema(
      z.object({
        data: z.array(regionEntrySchema),
        attribution: z.object({ notices: z.array(z.string()), includesThirdPartyData: z.boolean() }),
      }),
    ),
    GuiatvChannel: zodToJsonSchema(guiatvChannelSchema),
    GuiatvChannelListResponse: zodToJsonSchema(
      z.object({ data: z.array(guiatvChannelSchema), total: z.number().int() }),
    ),
    IdentityMapping: zodToJsonSchema(identityMappingSchema),
    IdentityMapResponse: zodToJsonSchema(
      z.object({
        data: z.array(identityMappingSchema),
        pagination: z.object({ page: z.number().int(), pageSize: z.number().int(), total: z.number().int() }),
      }),
    ),
    Provider: zodToJsonSchema(providerSchema),
    AuditEntry: zodToJsonSchema(auditEntrySchema),
    VerifySourceResult: zodToJsonSchema(verifySourceResultSchema),
    // Inputs (components/schemas doubles as documentation for the admin surface).
    CreateChannelInput: zodToJsonSchema(createChannelInputSchema),
    UpdateChannelInput: zodToJsonSchema(updateChannelInputSchema),
    CreateSourceInput: zodToJsonSchema(createSourceInputSchema),
    UpdateSourceInput: zodToJsonSchema(updateSourceInputSchema),
    ChannelListQuery: zodToJsonSchema(channelListQuerySchema),
    AuditListQuery: zodToJsonSchema(auditListQuerySchema),
    // ---------------------------------------------------------------- 02FG
    CountryEntry: zodToJsonSchema(countryEntrySchema),
    CountryListResponse: zodToJsonSchema(countryListResponseSchema),
    CountryRegionEntry: zodToJsonSchema(countryRegionEntrySchema),
    CountryRegionsResponse: zodToJsonSchema(countryRegionsResponseSchema),
    LanguageEntry: zodToJsonSchema(languageEntrySchema),
    LanguageListResponse: zodToJsonSchema(publicLanguageListResponseSchema),
    ChannelAvailability: zodToJsonSchema(channelAvailabilitySchema),
    ChannelAvailabilityResponse: zodToJsonSchema(channelAvailabilityResponseSchema),
    EpgCoverageEntry: zodToJsonSchema(epgCoverageEntrySchema),
    EpgCoverageResponse: zodToJsonSchema(epgCoverageSchema),
    EpgDayQuery: zodToJsonSchema(epgDayQuerySchema),
    PublicChannelListQuery: zodToJsonSchema(publicChannelListQuerySchema),
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'TDT Platform API',
      version: '1.0.0',
      description:
        'API propia del catálogo de canales, registro de fuentes de reproducción y guía de programación de TDT Platform. ' +
        'Identifica cada canal por su slug público. Distingue explícitamente entre autorización de integración y ' +
        'disponibilidad técnica; nunca expone fuentes sin permiso registrado.',
      license: { name: 'Propietaria — uso autorizado por el titular del servicio' },
    },
    servers: [
      { url: `${baseUrl}/api/v1`, description: 'Servidor local de desarrollo' },
      { url: 'https://api.example.invalid/api/v1', description: 'Producción (pendiente de despliegue)' },
    ],
    tags: [
      { name: 'Salud', description: 'Estado del servicio y de sus dependencias.' },
      { name: 'Catálogo', description: 'Canales, categorías y regiones canónicos.' },
      { name: 'Reproducción', description: 'Descriptores tipados de reproducción.' },
      { name: 'Programación', description: 'Guía propia de programación.' },
      { name: 'Integración', description: 'Contratos para consumidores externos (GuíaTV).' },
      { name: 'Administración', description: 'Gestión editorial autenticada (bearer token).' },
    ],
    paths: {
      '/health': {
        get: {
          tags: ['Salud'],
          operationId: 'getHealth',
          summary: 'Estado del servicio',
          responses: {
            '200': { ...json({ $ref: '#/components/schemas/HealthResponse' }, 'Servicio operativo.'), headers: commonHeaders },
            '503': errorResponse('Base de datos no disponible.'),
          },
        },
      },
      '/countries': {
        get: {
          tags: ['Catálogo'],
          operationId: 'listCountries',
          summary: 'Países del catálogo con recuentos',
          description:
            'Un registro por país con canales publicados. `code` es el código ISO 3166-1 alpha-2, o `INT` para ' +
            'el agregado internacional documentado (`international: true`). Los recuentos se calculan con una ' +
            'agregación de MongoDB sobre el catálogo publicado: nunca se carga la colección en memoria.',
          responses: {
            '200': {
              ...json({ $ref: '#/components/schemas/CountryListResponse' }, 'Países con recuentos.'),
              headers: commonHeaders,
            },
          },
        },
      },
      '/countries/{code}/regions': {
        get: {
          tags: ['Catálogo'],
          operationId: 'listCountryRegions',
          summary: 'Regiones de un país con recuentos',
          description:
            'Regiones con al menos un canal publicado. Las filas suman `country.channelCount`: los canales sin ' +
            'región asignada se agrupan en la fila `INTL`, marcada `aggregate: true`, que un cliente nunca debe ' +
            'ofrecer como valor de filtro.',
          parameters: [
            {
              name: 'code',
              in: 'path',
              required: true,
              schema: { type: 'string', pattern: '^(?:[A-Z]{2}|INT)$' },
              description: 'Código ISO 3166-1 alpha-2, o `INT`. No distingue mayúsculas.',
              example: 'ES',
            },
          ],
          responses: {
            '200': {
              ...json({ $ref: '#/components/schemas/CountryRegionsResponse' }, 'Regiones del país.'),
              headers: commonHeaders,
            },
            '404': errorResponse('El país no tiene canales publicados.'),
          },
        },
      },
      '/languages': {
        get: {
          tags: ['Catálogo'],
          operationId: 'listLanguages',
          summary: 'Idiomas del catálogo con recuentos',
          description:
            'Una fila por etiqueta de idioma tal como la declara el catálogo. Además de etiquetas BCP-47 (`es`, `ca`) ' +
            'aparece `multi`, el marcador del catálogo para canales que emiten en varios idiomas; no es una etiqueta ' +
            'BCP-47 y se publica con ese mismo nombre para no inventar un idioma.',
          responses: {
            '200': {
              ...json({ $ref: '#/components/schemas/LanguageListResponse' }, 'Idiomas con recuentos.'),
              headers: commonHeaders,
            },
          },
        },
      },
      '/channels': {
        get: {
          tags: ['Catálogo'],
          operationId: 'listChannels',
          summary: 'Lista paginada de canales',
          description:
            'Filtros combinables sobre el catálogo publicado. `country` acepta un código ISO 3166-1 alpha-2 o el ' +
            'agregado `INT`, y `language` acepta una etiqueta BCP-47 o `multi`: son los valores que el catálogo ' +
            'almacena realmente. Con `playable=true` la página se obtiene recorriendo candidatos en orden y ' +
            'deteniéndose al completar la ventana; `pagination.total` es entonces el total exacto si el recorrido ' +
            'terminó, y una cota inferior (ventana + 1) si se detuvo antes, siempre coherente con `hasNext`.',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 24 } },
            { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Búsqueda sin acentos sobre nombre y alias.', example: 'aragon' },
            { name: 'country', in: 'query', schema: { type: 'string', pattern: '^(?:[A-Z]{2}|INT)$' }, description: 'Código ISO 3166-1 alpha-2, o `INT`.', example: 'ES' },
            { name: 'region', in: 'query', schema: { type: 'string' }, description: 'Código ISO 3166-2:ES sin prefijo.', example: 'MD' },
            {
              name: 'category',
              in: 'query',
              schema: {
                type: 'string',
                enum: [
                  'generalista', 'informativos', 'deportes', 'infantil', 'musica', 'cultura',
                  'cine-series', 'documentales', 'entretenimiento', 'religion', 'local',
                  'autonomica', 'internacional', 'otros',
                ],
              },
            },
            { name: 'language', in: 'query', schema: { type: 'string', pattern: '^(?:[a-z]{2,3}(?:-[A-Z]{2})?|multi)$' }, description: 'Etiqueta BCP-47 en minúsculas, o `multi`.', example: 'es' },
            { name: 'playable', in: 'query', schema: { type: 'boolean' }, description: 'Solo canales con fuente autorizada reproducible.' },
            { name: 'sort', in: 'query', schema: { type: 'string', enum: ['name', 'name-desc', 'updated', 'relevance'], default: 'name' } },
          ],
          responses: {
            '200': { ...json({ $ref: '#/components/schemas/ChannelListResponse' }, 'Página de canales.'), headers: commonHeaders },
            '400': errorResponse('Parámetros no válidos.'),
            '429': errorResponse('Límite de peticiones superado.'),
          },
        },
      },
      '/channels/{slug}': {
        get: {
          tags: ['Catálogo'],
          operationId: 'getChannel',
          summary: 'Ficha canónica de un canal',
          parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { ...json({ $ref: '#/components/schemas/ChannelResponse' }, 'Ficha del canal.'), headers: commonHeaders },
            '404': errorResponse('Canal no encontrado.'),
          },
        },
      },
      '/channels/{slug}/playback': {
        get: {
          tags: ['Reproducción'],
          operationId: 'getPlayback',
          summary: 'Descriptor tipado de reproducción',
          description:
            'Devuelve `available` con un descriptor reproducible, `external` con la página oficial del emisor, ' +
            '`degraded`, `eventual` o `unavailable`. Nunca incluye credenciales ni fuentes sin permiso registrado.',
          parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { ...json({ $ref: '#/components/schemas/PlaybackResponse' }, 'Descriptor de reproducción.'), headers: commonHeaders },
            '404': errorResponse('Canal no encontrado.'),
          },
        },
      },
      '/channels/{slug}/schedule': {
        get: {
          tags: ['Programación'],
          operationId: 'getSchedule',
          summary: 'Programación de un canal',
          parameters: [
            { name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Instante de referencia (por defecto, ahora).' },
            { name: 'hours', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 72, default: 24 } },
          ],
          responses: {
            '200': { ...json({ $ref: '#/components/schemas/ScheduleResponse' }, 'Programación del canal.'), headers: commonHeaders },
            '404': errorResponse('Canal no encontrado.'),
          },
        },
      },
      '/channels/{slug}/epg': {
        get: {
          tags: ['Programación'],
          operationId: 'getChannelEpgDay',
          summary: 'Parrilla diaria completa de un canal',
          description:
            'Una jornada completa en la zona horaria del canal. `date` nombra un día local (23, 24 o 25 horas ' +
            'según el cambio de hora); `from` + `hours` nombra una ventana explícita en UTC. Un canal sin guía ' +
            'responde `not-mapped` y un día sin programas `empty`: nunca se inventa programación.',
          parameters: [
            { name: 'slug', in: 'path', required: true, schema: { type: 'string' }, example: 'la-1' },
            {
              name: 'date',
              in: 'query',
              schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              description: 'Fecha local `AAAA-MM-DD`. Incompatible con `from`.',
              example: '2026-11-16',
            },
            {
              name: 'timezone',
              in: 'query',
              schema: { type: 'string' },
              description: 'Zona IANA para interpretar `date`. Por defecto, la del canal.',
              example: 'Europe/Madrid',
            },
            {
              name: 'from',
              in: 'query',
              schema: { type: 'string', format: 'date-time' },
              description: 'Instante inicial ISO-8601. Incompatible con `date`.',
              example: '2026-11-16T00:00:00Z',
            },
            { name: 'hours', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 72, default: 24 }, description: 'Horas desde `from`; se ignora con `date`.' },
          ],
          responses: {
            '200': { ...json({ $ref: '#/components/schemas/ScheduleResponse' }, 'Jornada del canal.'), headers: commonHeaders },
            '400': errorResponse('Fecha, zona o ventana no válidas, o `date` y `from` a la vez.'),
            '404': errorResponse('Canal no encontrado.'),
          },
        },
      },
      '/channels/{slug}/availability': {
        get: {
          tags: ['Reproducción'],
          operationId: 'getChannelAvailability',
          summary: 'Disponibilidad pública agregada',
          description:
            'Autorización primero: el resultado se deriva del mismo descriptor que reproduce el reproductor y se ' +
            'reduce a hechos booleanos y recuentos. Nunca incluye una URL de emisión, un identificador de fuente, ' +
            'el nombre de un proveedor, credenciales ni cláusulas de licencia. `epg` procede de la única medida de ' +
            'cobertura compartida (`EpgService.coverage()`).',
          parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' }, example: 'la-1' }],
          responses: {
            '200': {
              ...json({ $ref: '#/components/schemas/ChannelAvailabilityResponse' }, 'Disponibilidad agregada.'),
              headers: commonHeaders,
            },
            '404': errorResponse('Canal no encontrado.'),
          },
        },
      },
      '/epg/channels': {
        get: {
          tags: ['Programación'],
          operationId: 'listEpgCoverage',
          summary: 'Cobertura de la guía por canal',
          description:
            'Una entrada por canal publicado con su estado (`fresh`, `stale`, `empty`, `not-mapped`) y los totales. ' +
            'Es la misma medida que usan `/channels/{slug}/availability` y la consola de administración.',
          responses: {
            '200': { ...json({ $ref: '#/components/schemas/EpgCoverageResponse' }, 'Cobertura de la guía.'), headers: commonHeaders },
          },
        },
      },
      '/epg/now': {
        get: {
          tags: ['Programación'],
          operationId: 'getEpgNow',
          summary: 'Qué se emite ahora',
          parameters: [
            { name: 'channel', in: 'query', style: 'form', explode: true, schema: { type: 'array', items: { type: 'string' } } },
            { name: 'country', in: 'query', schema: { type: 'string' } },
            { name: 'category', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          ],
          responses: {
            '200': { ...json({ $ref: '#/components/schemas/EpgFeedResponse' }, 'Programas en emisión.'), headers: commonHeaders },
          },
        },
      },
      '/epg/next': {
        get: {
          tags: ['Programación'],
          operationId: 'getEpgNext',
          summary: 'Qué se emite a continuación',
          parameters: [
            { name: 'channel', in: 'query', style: 'form', explode: true, schema: { type: 'array', items: { type: 'string' } } },
            { name: 'country', in: 'query', schema: { type: 'string' } },
            { name: 'category', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          ],
          responses: {
            '200': { ...json({ $ref: '#/components/schemas/EpgFeedResponse' }, 'Próximos programas.'), headers: commonHeaders },
          },
        },
      },
      '/categories': {
        get: {
          tags: ['Catálogo'],
          operationId: 'listCategories',
          summary: 'Taxonomía canónica con recuentos',
          responses: {
            '200': { ...json({ $ref: '#/components/schemas/CategoryListResponse' }, 'Categorías.'), headers: commonHeaders },
          },
        },
      },
      '/regions': {
        get: {
          tags: ['Catálogo'],
          operationId: 'listRegions',
          summary: 'Comunidades autónomas con recuentos',
          responses: {
            '200': { ...json({ $ref: '#/components/schemas/RegionListResponse' }, 'Regiones.'), headers: commonHeaders },
          },
        },
      },
      '/integration/manifest': {
        get: {
          tags: ['Integración'],
          operationId: 'getIntegrationManifest',
          summary: 'Capacidades del servicio para consumidores externos',
          responses: {
            '200': { ...json({ type: 'object', additionalProperties: true }, 'Manifiesto de integración.'), headers: commonHeaders },
          },
        },
      },
      '/integration/guiatv/channels': {
        get: {
          tags: ['Integración'],
          operationId: 'listGuiaTvChannels',
          summary: 'Catálogo adaptado a GuíaTV',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
          ],
          responses: {
            '200': { ...json({ $ref: '#/components/schemas/GuiatvChannelListResponse' }, 'Canales para GuíaTV.'), headers: commonHeaders },
          },
        },
      },
      '/integration/guiatv/identity-map': {
        get: {
          tags: ['Integración'],
          operationId: 'getGuiaTvIdentityMap',
          summary: 'Tabla de correspondencia de identificadores',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 200 } },
          ],
          responses: {
            '200': { ...json({ $ref: '#/components/schemas/IdentityMapResponse' }, 'Correspondencias.'), headers: commonHeaders },
          },
        },
      },
      '/admin/channels': {
        get: {
          tags: ['Administración'],
          operationId: 'adminListChannels',
          summary: 'Lista administrativa (incluye borradores)',
          security: [{ adminSession: [] }],
          responses: {
            '200': { ...json({ type: 'object', additionalProperties: true }, 'Canales administrables.'), headers: commonHeaders },
            '401': errorResponse('Sesión requerida.'),
          },
        },
        post: {
          tags: ['Administración'],
          operationId: 'adminCreateChannel',
          summary: 'Alta de canal',
          security: [{ adminSession: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateChannelInput' } } } },
          responses: {
            '201': { ...json({ type: 'object', additionalProperties: true }, 'Canal creado.') },
            '400': errorResponse('Datos no válidos.'),
            '401': errorResponse('Sesión requerida.'),
            '409': errorResponse('Slug en uso.'),
          },
        },
      },
      '/admin/channels/{id}': {
        patch: {
          tags: ['Administración'],
          operationId: 'adminUpdateChannel',
          summary: 'Edición de metadatos',
          security: [{ adminSession: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateChannelInput' } } } },
          responses: {
            '200': { ...json({ type: 'object', additionalProperties: true }, 'Canal actualizado.') },
            '401': errorResponse('Sesión requerida.'),
            '409': errorResponse('Conflicto de versión.'),
          },
        },
      },
      '/admin/sources': {
        post: {
          tags: ['Administración'],
          operationId: 'adminCreateSource',
          summary: 'Alta de fuente de reproducción',
          security: [{ adminSession: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateSourceInput' } } } },
          responses: {
            '201': { ...json({ type: 'object', additionalProperties: true }, 'Fuente creada.') },
            '400': errorResponse('Datos no válidos o sin permiso de integración.'),
          },
        },
      },
      '/admin/sources/{id}': {
        patch: {
          tags: ['Administración'],
          operationId: 'adminUpdateSource',
          summary: 'Edición de una fuente',
          security: [{ adminSession: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateSourceInput' } } } },
          responses: {
            '200': { ...json({ type: 'object', additionalProperties: true }, 'Fuente actualizada.') },
            '409': errorResponse('Conflicto de versión.'),
          },
        },
      },
      '/admin/sources/{id}/verify': {
        post: {
          tags: ['Administración'],
          operationId: 'adminVerifySource',
          summary: 'Verificación técnica de una fuente',
          security: [{ adminSession: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { ...json({ data: { $ref: '#/components/schemas/VerifySourceResult' } }, 'Resultado de verificación.') },
          },
        },
      },
      '/admin/audits': {
        get: {
          tags: ['Administración'],
          operationId: 'adminListAudits',
          summary: 'Registro de auditoría',
          security: [{ adminSession: [] }],
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { name: 'entityType', in: 'query', schema: { type: 'string' } },
            { name: 'entityId', in: 'query', schema: { type: 'string' } },
            { name: 'action', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            '200': { ...json({ type: 'object', additionalProperties: true }, 'Entradas de auditoría.') },
          },
        },
      },
      '/admin/providers': {
        get: {
          tags: ['Administración'],
          operationId: 'adminListProviders',
          summary: 'Proveedores de integración disponibles',
          security: [{ adminSession: [] }],
          responses: {
            '200': { ...json({ type: 'object', additionalProperties: true }, 'Proveedores.') },
          },
        },
      },
    },
    components: {
      schemas,
      securitySchemes: {
        adminSession: {
          type: 'http',
          scheme: 'bearer',
          description: 'Token de sesión administrativa emitido por `/auth/login`. Nunca se distribuye en el bundle del cliente público.',
        },
      },
      parameters: {
        IfNoneMatch: {
          name: 'If-None-Match',
          in: 'header',
          schema: { type: 'string' },
          description: 'Devolver 304 si la representación no ha cambiado.',
        },
      },
    },
  };
}
