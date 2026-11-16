/**
 * Editor de fixtures de la API para Playwright.
 *
 * Un único módulo decide qué devuelve nuestro API para cada prueba, incluyendo
 * los descriptores de YouTube que produce a partir de cada forma de URL. Así el
 * "servidor falso" y los datos que describe el test no pueden divergir.
 */
import type { Page, Route } from '@playwright/test';
import { YOUTUBE_CHANNELS, type YoutubeFixtureChannel } from './youtube-helpers';

export interface FixtureChannel {
  slug: string;
  name: string;
  category: string;
  playbackStatus: 'available' | 'external' | 'eventual' | 'unavailable' | 'degraded';
  kind: 'linear' | 'eventual';
  sourceUrl?: string;
  externalUrl?: string;
  hasSchedule?: boolean;
}

export interface FixtureOptions {
  failApi?: boolean;
  serverError?: boolean;
  channels?: FixtureChannel[];
  youtubeChannels?: readonly YoutubeFixtureChannel[];
}

const HOUR = 3600;
const FIXTURE_ID = '00000000-0000-4000-8000-00000000';

function idFor(index: number): string {
  return `${FIXTURE_ID}${String(index + 10).padStart(4, '0')}`;
}

function hourFromNow(offset: number): string {
  const base = new Date();
  base.setMinutes(0, 0, 0);
  return new Date(base.getTime() + offset * HOUR * 1000).toISOString();
}

export const DEFAULT_CHANNELS: FixtureChannel[] = [
  { slug: 'la-uno', name: 'La Uno', category: 'generalista', playbackStatus: 'available', kind: 'linear', sourceUrl: '/demo/media/high/index.m3u8', hasSchedule: true },
  { slug: 'la-dos', name: 'La Dos', category: 'generalista', playbackStatus: 'available', kind: 'linear', sourceUrl: '/demo/media/single/index.m3u8', hasSchedule: true },
  { slug: 'canal-alternativo', name: 'Canal Alternativo', category: 'generalista', playbackStatus: 'available', kind: 'linear', sourceUrl: '/demo/media/master.m3u8', hasSchedule: true },
  { slug: 'senal-rota', name: 'Señal Rota', category: 'generalista', playbackStatus: 'available', kind: 'linear', sourceUrl: '/demo/media/broken/index.m3u8' },
  { slug: 'solo-externo', name: 'Solo Externo', category: 'internacional', playbackStatus: 'external', kind: 'linear', externalUrl: 'https://example.org/externo', hasSchedule: true },
  { slug: 'sin-emision', name: 'Sin Emisión', category: 'internacional', playbackStatus: 'eventual', kind: 'eventual' },
  { slug: 'sin-guia', name: 'Sin Guía', category: 'generalista', playbackStatus: 'available', kind: 'linear', sourceUrl: '/demo/media/low/index.m3u8', hasSchedule: false },
  { slug: 'europe-news', name: 'Europe News', category: 'internacional', playbackStatus: 'available', kind: 'linear', sourceUrl: '/demo/media/single/index.m3u8', hasSchedule: true },
];

const CATEGORY_LABELS: Record<string, string> = {
  generalista: 'Generalistas',
  internacional: 'Internacionales',
};

/** YouTube URLs carry the identifier the official player accepts. */
function youtubeTarget(url: string): { videoId: string } | { channelLive: true } | { page: true } {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (parsed.hostname === 'youtu.be') return { videoId: segments[0] ?? '' };
  if (segments[0] === 'watch') return { videoId: parsed.searchParams.get('v') ?? '' };
  if (['live', 'embed', 'v'].includes(segments[0] ?? '')) return { videoId: segments[1] ?? '' };
  if (segments[0] === 'channel' || segments[0]?.startsWith('@')) return { channelLive: true };
  return { page: true };
}

function programmes(index: number) {
  const seed = String(index).padStart(2, '0');
  return [
    { id: `${FIXTURE_ID}${seed}91`, title: 'Programa anterior', description: 'Antes', genre: 'NEWS', coverUrl: null, start: hourFromNow(-3), end: hourFromNow(-1) },
    { id: `${FIXTURE_ID}${seed}92`, title: 'Programa en directo', description: 'Ahora mismo', genre: 'NEWS', coverUrl: null, start: hourFromNow(-1), end: hourFromNow(1) },
    { id: `${FIXTURE_ID}${seed}93`, title: 'Siguiente programa', description: 'Después', genre: 'FILM', coverUrl: null, start: hourFromNow(1), end: hourFromNow(3) },
    { id: `${FIXTURE_ID}${seed}94`, title: 'Programa tardío', description: 'Al final', genre: 'CULTURE', coverUrl: null, start: hourFromNow(3), end: hourFromNow(5) },
  ];
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });
}

function errorBody(code: string, message: string) {
  return { error: { code, message }, requestId: 'e2e-request' };
}

/** Serves our API v1 contract from fixtures. Catches `/api/v1/**` only. */
export async function installApiFixtures(page: Page, options: FixtureOptions = {}): Promise<void> {
  const channels = options.channels ?? DEFAULT_CHANNELS;
  const youtube = options.youtubeChannels ?? [];
  const origin = 'http://127.0.0.1:4400';

  const listRecord = (channel: FixtureChannel, index: number) => ({
    id: idFor(index),
    slug: channel.slug,
    name: channel.name,
    shortName: channel.name,
    country: 'ES',
    region: null,
    language: 'es',
    category: channel.category,
    kind: channel.kind,
    playbackStatus: channel.playbackStatus,
    logoSrc: null,
    hasSchedule: channel.hasSchedule ?? false,
  });

  const youtubeListRecord = (channel: YoutubeFixtureChannel, index: number) => ({
    id: idFor(channels.length + index),
    slug: channel.slug,
    name: channel.name,
    shortName: channel.name,
    country: 'ES',
    region: null,
    language: 'es',
    category: 'internacional',
    kind: 'linear',
    playbackStatus: 'available',
    logoSrc: null,
    hasSchedule: false,
  });

  const allList = () => [
    ...channels.map((channel, index) => ({ type: 'plain' as const, channel, index, record: listRecord(channel, index) })),
    ...youtube.map((channel, index) => ({ type: 'youtube' as const, channel, index, record: youtubeListRecord(channel, index) })),
  ];

  const descriptorFor = (channel: FixtureChannel, index: number) => {
    const id = idFor(index);
    const url = channel.sourceUrl ? new URL(channel.sourceUrl, origin).toString() : null;
    const available = channel.playbackStatus === 'available' && url !== null;
    return {
      channel: { id, slug: channel.slug, name: channel.name },
      playback: {
        status: channel.playbackStatus,
        engine: available ? 'hls' : channel.playbackStatus === 'external' ? 'external' : 'none',
        type: available ? 'hls' : channel.playbackStatus === 'external' ? 'external' : null,
        sourceId: available ? idFor(index).replace(/.{2}$/, 'aa') : null,
        url: available ? url : null,
        externalUrl: channel.playbackStatus === 'external' ? (channel.externalUrl ?? null) : null,
        options: available
          ? [
              {
                sourceId: idFor(index).replace(/.{2}$/, 'aa'),
                label: 'Señal del emisor',
                type: 'hls',
                engine: 'hls',
                url,
                externalUrl: null,
                geoRestricted: false,
                preferred: true,
              },
            ]
          : [],
        reason: available
          ? null
          : channel.playbackStatus === 'external'
            ? 'El emisor solo permite ver esta señal en su propio reproductor.'
            : channel.playbackStatus === 'eventual'
              ? 'El emisor la publica como emisión eventual.'
              : 'No hay ninguna señal registrada para este canal.',
      },
      checkedAt: new Date().toISOString(),
      issues: [],
    };
  };

  const youtubeDescriptorFor = (channel: YoutubeFixtureChannel, index: number) => {
    const id = idFor(channels.length + index);
    const target = youtubeTarget(channel.youtubeUrl);
    const hlsUrl = channel.hlsUrl ? new URL(channel.hlsUrl, origin).toString() : null;
    const youtubeOption = {
      sourceId: idFor(channels.length + index).replace(/.{2}$/, 'yy'),
      label: 'Emisión en YouTube',
      type: 'youtube',
      engine: 'youtube-iframe',
      url: channel.youtubeUrl,
      externalUrl: channel.youtubeUrl,
      geoRestricted: false,
      preferred: 'videoId' in target && Boolean(target.videoId),
    };
    const hlsOption = hlsUrl
      ? {
          sourceId: idFor(channels.length + index).replace(/.{2}$/, 'hh'),
          label: 'Señal del emisor',
          type: 'hls',
          engine: 'hls',
          url: hlsUrl,
          externalUrl: null,
          geoRestricted: false,
          preferred: !channel.preferYoutube,
        }
      : null;
    const options = channel.preferYoutube === false ? [hlsOption, youtubeOption] : [youtubeOption, ...(hlsOption ? [hlsOption] : [])];
    const primary = options[0];
    return {
      channel: { id, slug: channel.slug, name: channel.name },
      playback: {
        status: 'available',
        engine: primary?.engine ?? 'none',
        type: primary?.type ?? null,
        sourceId: primary?.sourceId ?? null,
        url: primary?.url ?? null,
        externalUrl: primary?.externalUrl ?? null,
        options: options.filter(Boolean),
        reason: null,
      },
      checkedAt: new Date().toISOString(),
      issues: [],
    };
  };

  const channelRecord = (channel: FixtureChannel, index: number) => ({
    ...listRecord(channel, index),
    locality: null,
    websiteUrl: channel.externalUrl ?? null,
    description: 'Canal de prueba',
    branding: null,
    editorialStatus: 'published',
    sources: channel.sourceUrl
      ? [
          {
            id: idFor(index).replace(/.{2}$/, 'aa'),
            type: 'hls',
            label: 'Señal del emisor',
            geoRestricted: false,
            preferred: true,
            engine: 'hls',
          },
        ]
      : [],
    provenance: [
      {
        source: 'e2e-fixture',
        label: 'Fixture de pruebas',
        url: null,
        licence: 'editorial',
        attribution: null,
        digestSha256: null,
        capturedAt: new Date().toISOString(),
        editorial: true,
      },
    ],
    aliases: [],
    reviewedAt: null,
    updatedAt: new Date().toISOString(),
  });

  const youtubeChannelRecord = (channel: YoutubeFixtureChannel, index: number) => ({
    ...youtubeListRecord(channel, index),
    locality: null,
    websiteUrl: channel.youtubeUrl,
    description: 'Canal de YouTube de prueba',
    branding: null,
    editorialStatus: 'published',
    sources: [
      {
        id: idFor(channels.length + index).replace(/.{2}$/, 'yy'),
        type: 'youtube',
        label: 'Emisión en YouTube',
        geoRestricted: false,
        preferred: true,
        engine: 'youtube-iframe',
      },
    ],
    provenance: [
      {
        source: 'e2e-fixture',
        label: 'Fixture de pruebas',
        url: null,
        licence: 'editorial',
        attribution: null,
        digestSha256: null,
        capturedAt: new Date().toISOString(),
        editorial: true,
      },
    ],
    aliases: [],
    reviewedAt: null,
    updatedAt: new Date().toISOString(),
  });

  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/v1', '');

    if (options.failApi) {
      await route.abort('connectionrefused');
      return;
    }
    if (options.serverError) {
      await fulfillJson(route, errorBody('internal_error', 'Fallo interno'), 500);
      return;
    }

    if (path === '/channels') {
      const pageNumber = Number(url.searchParams.get('page') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '100');
      const entries = allList();
      const start = (pageNumber - 1) * pageSize;
      await fulfillJson(route, {
        data: entries.slice(start, start + pageSize).map((entry) => entry.record),
        pagination: {
          page: pageNumber,
          pageSize,
          total: entries.length,
          pageCount: Math.ceil(entries.length / pageSize),
          hasNext: pageNumber * pageSize < entries.length,
          hasPrevious: pageNumber > 1,
        },
        attribution: { notices: ['Fixture de pruebas.'], includesThirdPartyData: false },
      });
      return;
    }

    if (path === '/categories') {
      const byCategory = new Map<string, number>();
      for (const channel of channels) {
        byCategory.set(channel.category, (byCategory.get(channel.category) ?? 0) + 1);
      }
      if (youtube.length > 0) {
        byCategory.set('internacional', (byCategory.get('internacional') ?? 0) + youtube.length);
      }
      await fulfillJson(route, {
        data: [...byCategory.entries()].map(([id, count]) => ({
          id,
          name: CATEGORY_LABELS[id] ?? id,
          channelCount: count,
          playableCount: count,
        })),
        attribution: { notices: [], includesThirdPartyData: false },
      });
      return;
    }

    if (path === '/regions') {
      await fulfillJson(route, { data: [], attribution: { notices: [], includesThirdPartyData: false } });
      return;
    }

    const detail = /^\/channels\/([^/]+)$/.exec(path);
    if (detail) {
      const slug = decodeURIComponent(detail[1] ?? '');
      const plainIndex = channels.findIndex((channel) => channel.slug === slug);
      if (plainIndex >= 0) {
        const channel = channels[plainIndex] as FixtureChannel;
        await fulfillJson(route, {
          data: channelRecord(channel, plainIndex),
          attribution: { notices: [], includesThirdPartyData: false },
        });
        return;
      }
      const youtubeIndex = youtube.findIndex((channel) => channel.slug === slug);
      if (youtubeIndex >= 0) {
        await fulfillJson(route, {
          data: youtubeChannelRecord(youtube[youtubeIndex] as YoutubeFixtureChannel, youtubeIndex),
          attribution: { notices: [], includesThirdPartyData: false },
        });
        return;
      }
      await fulfillJson(route, errorBody('not_found', 'Canal no encontrado.'), 404);
      return;
    }

    const playback = /^\/channels\/([^/]+)\/playback$/.exec(path);
    if (playback) {
      const slug = decodeURIComponent(playback[1] ?? '');
      const plainIndex = channels.findIndex((channel) => channel.slug === slug);
      if (plainIndex >= 0) {
        await fulfillJson(route, { data: descriptorFor(channels[plainIndex] as FixtureChannel, plainIndex) });
        return;
      }
      const youtubeIndex = youtube.findIndex((channel) => channel.slug === slug);
      if (youtubeIndex >= 0) {
        await fulfillJson(route, {
          data: youtubeDescriptorFor(youtube[youtubeIndex] as YoutubeFixtureChannel, youtubeIndex),
        });
        return;
      }
      await fulfillJson(route, errorBody('not_found', 'Canal no encontrado.'), 404);
      return;
    }

    const scheduleMatch = /^\/channels\/([^/]+)\/schedule$/.exec(path);
    if (scheduleMatch) {
      const slug = decodeURIComponent(scheduleMatch[1] ?? '');
      const plainIndex = channels.findIndex((channel) => channel.slug === slug);
      const channel = plainIndex >= 0 ? channels[plainIndex] : undefined;
      const youtubeIndex = youtube.findIndex((entry) => entry.slug === slug);
      const name = channel?.name ?? youtube[youtubeIndex]?.name ?? slug;
      const id = plainIndex >= 0 ? idFor(plainIndex) : idFor(channels.length + Math.max(0, youtubeIndex));
      // A channel the catalogue declares without a guide answers with
      // availability "not-mapped" and no programmes, exactly like the real API
      // for such a record.
      if (channel && channel.hasSchedule === false) {
        await fulfillJson(route, {
          data: {
            channel: { id, slug, name },
            timezone: 'Europe/Madrid',
            availability: 'not-mapped',
            now: null,
            next: [],
            programmes: [],
            asOf: new Date().toISOString(),
            provenance: { sourceId: null, sourceName: null, licence: null, attribution: null, editedAt: null },
            updatedAt: null,
          },
          attribution: { notices: [], includesThirdPartyData: false },
        });
        return;
      }
      const all = programmes(plainIndex >= 0 ? plainIndex : channels.length + Math.max(0, youtubeIndex));
      await fulfillJson(route, {
        data: {
          channel: { id, slug, name },
          timezone: 'Europe/Madrid',
          availability: 'available',
          now: all[1],
          next: all.slice(2),
          programmes: all,
          asOf: new Date().toISOString(),
          provenance: { sourceId: null, sourceName: 'Fixture', licence: 'editorial', attribution: null, editedAt: null },
          updatedAt: new Date().toISOString(),
        },
        attribution: { notices: [], includesThirdPartyData: false },
      });
      return;
    }

    if (path === '/epg/now' || path === '/epg/next') {
      await fulfillJson(route, {
        data: channels
          .filter((channel) => channel.hasSchedule)
          .map((channel) => ({
            channel: { id: idFor(channels.indexOf(channel)), slug: channel.slug, name: channel.name },
            timezone: 'Europe/Madrid',
            availability: 'available',
            programme: programmes(channels.indexOf(channel))[path === '/epg/now' ? 1 : 2],
            provenance: { sourceId: null, sourceName: 'Fixture', licence: 'editorial', attribution: null, editedAt: null },
          })),
        asOf: new Date().toISOString(),
        attribution: { notices: [], includesThirdPartyData: false },
      });
      return;
    }

    if (path === '/health') {
      await fulfillJson(route, {
        status: 'ok',
        version: '1.0.0',
        apiVersion: 'v1',
        uptimeSeconds: 1,
        now: new Date().toISOString(),
        dependencies: [],
        data: { channels: channels.length, publishedChannels: channels.length, sources: channels.length, programmes: 4 },
      });
      return;
    }

    await fulfillJson(route, errorBody('not_found', `No existe ${path}`), 404);
  });
}
