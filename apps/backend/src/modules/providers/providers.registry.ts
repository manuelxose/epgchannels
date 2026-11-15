/**
 * Playback provider adapters.
 *
 * Each adapter owns one *kind* of integration and declares what it needs and
 * what it refuses. Nothing here trusts a stored URL blindly: a record only
 * becomes playable once an adapter has classified it and the publication policy
 * has allowed it. There is deliberately no single adapter that every channel
 * depends on.
 */
import type { PlaybackType } from '@tdt/contracts';
import type { EgressOptions } from '../../infrastructure/egress.js';
import { fetchWithPolicy } from '../../infrastructure/egress.js';
import type { PlaybackSourceDoc } from '../../infrastructure/schema.js';

export type ProviderId =
  | 'emitter-hls'
  | 'emitter-dash'
  | 'youtube-iframe'
  | 'official-embed'
  | 'external-reference';

export interface ProviderDescriptor {
  readonly id: ProviderId;
  readonly name: string;
  readonly types: readonly PlaybackType[];
  readonly requirements: readonly string[];
  readonly credentialFree: boolean;
  readonly enabled: boolean;
  readonly description: string;
}

/** Result of checking one source against its provider. */
export interface ProviderCheck {
  readonly ok: boolean;
  readonly technicalStatus: 'ok' | 'unreachable' | 'http-error' | 'invalid-manifest' | 'unknown' | 'blocked';
  readonly httpStatus: number | null;
  readonly message: string | null;
}

export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  /** Whether this adapter can handle the record. */
  accepts(source: Pick<PlaybackSourceDoc, 'type' | 'provider'>): boolean;
  /**
   * Verifies the source. Network use is optional: an adapter that cannot verify
   * without credentials returns `unknown` and says so, rather than pretending.
   */
  verify(source: PlaybackSourceDoc, egress: EgressOptions): Promise<ProviderCheck>;
}

const YOUTUBE_HOSTS = /^(?:www\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;

function isYoutubeUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    return YOUTUBE_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Emitter-published HLS: verify the master playlist answers as a playlist. */
class EmitterHlsAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = {
    id: 'emitter-hls',
    name: 'Emisor · HLS',
    types: ['hls'],
    requirements: ['URL pública del manifiesto HLS'],
    credentialFree: true,
    enabled: true,
    description: 'Manifiesto HLS publicado por el propio emisor o su distribuidor autorizado.',
  };

  accepts(source: Pick<PlaybackSourceDoc, 'type'>): boolean {
    return source.type === 'hls';
  }

  async verify(source: PlaybackSourceDoc, egress: EgressOptions): Promise<ProviderCheck> {
    if (!source.url) {
      return { ok: false, technicalStatus: 'unknown', httpStatus: null, message: 'Sin URL pública.' };
    }
    try {
      const result = await fetchWithPolicy(source.url, { ...egress, maxBytes: 2 * 1024 * 1024 });
      if (!result.ok) {
        return {
          ok: false,
          technicalStatus: 'http-error',
          httpStatus: result.status,
          message: `HTTP ${result.status}`,
        };
      }
      const body = result.body ?? '';
      const looksLikePlaylist = body.trimStart().startsWith('#EXTM3U');
      return looksLikePlaylist
        ? { ok: true, technicalStatus: 'ok', httpStatus: result.status, message: null }
        : {
            ok: false,
            technicalStatus: 'invalid-manifest',
            httpStatus: result.status,
            message: 'La respuesta no es un manifiesto HLS (#EXTM3U ausente).',
          };
    } catch (error) {
      return {
        ok: false,
        technicalStatus: 'unreachable',
        httpStatus: null,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/** Emitter-published DASH: verify the MPD answers as XML. */
class EmitterDashAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = {
    id: 'emitter-dash',
    name: 'Emisor · DASH',
    types: ['dash'],
    requirements: ['URL pública del manifiesto .mpd'],
    credentialFree: true,
    enabled: true,
    description: 'Manifiesto MPEG-DASH autorizado publicado por el emisor.',
  };

  accepts(source: Pick<PlaybackSourceDoc, 'type'>): boolean {
    return source.type === 'dash';
  }

  async verify(source: PlaybackSourceDoc, egress: EgressOptions): Promise<ProviderCheck> {
    if (!source.url) {
      return { ok: false, technicalStatus: 'unknown', httpStatus: null, message: 'Sin URL pública.' };
    }
    try {
      const result = await fetchWithPolicy(source.url, { ...egress, maxBytes: 2 * 1024 * 1024 });
      if (!result.ok) {
        return { ok: false, technicalStatus: 'http-error', httpStatus: result.status, message: `HTTP ${result.status}` };
      }
      const body = (result.body ?? '').trimStart();
      const looksLikeMpd = body.startsWith('<?xml') ? body.includes('<MPD') : body.startsWith('<MPD');
      return looksLikeMpd
        ? { ok: true, technicalStatus: 'ok', httpStatus: result.status, message: null }
        : {
            ok: false,
            technicalStatus: 'invalid-manifest',
            httpStatus: result.status,
            message: 'La respuesta no es un manifiesto DASH (<MPD> ausente).',
          };
    } catch (error) {
      return {
        ok: false,
        technicalStatus: 'unreachable',
        httpStatus: null,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/**
 * YouTube: the official IFrame integration. The source is played by YouTube's
 * own player inside our page; we keep the official channel/video id. Liveness is
 * verified only through the documented Data API when a key is configured, and
 * never by scraping.
 */
class YoutubeAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = {
    id: 'youtube-iframe',
    name: 'YouTube IFrame (oficial)',
    types: ['youtube'],
    requirements: ['ID público de vídeo o canal de YouTube'],
    credentialFree: true,
    enabled: true,
    description:
      'Emisión pública del emisor en YouTube, reproducida por el reproductor oficial IFrame dentro de nuestra interfaz.',
  };

  accepts(source: Pick<PlaybackSourceDoc, 'type'>): boolean {
    return source.type === 'youtube';
  }

  async verify(source: PlaybackSourceDoc): Promise<ProviderCheck> {
    if (!isYoutubeUrl(source.url) && !source.url) {
      return { ok: false, technicalStatus: 'unknown', httpStatus: null, message: 'Sin identificador público.' };
    }
    // No scraping and no undocumented endpoint: the page is not fetched here.
    return {
      ok: true,
      technicalStatus: 'unknown',
      httpStatus: null,
      message: 'Verificación delegada al reproductor oficial; la disponibilidad se confirma al reproducir.',
    };
  }
}

/**
 * Official third-party player embedded by the emitter. We never forge their
 * client data: the descriptor only carries their public page.
 */
class OfficialEmbedAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = {
    id: 'official-embed',
    name: 'Reproductor oficial del emisor',
    types: ['official-embed'],
    requirements: ['Página pública del reproductor oficial'],
    credentialFree: true,
    enabled: true,
    description: 'Reproductor oficial incrustable del emisor, en su dominio y con sus condiciones.',
  };

  accepts(source: Pick<PlaybackSourceDoc, 'type'>): boolean {
    return source.type === 'official-embed';
  }

  async verify(source: PlaybackSourceDoc): Promise<ProviderCheck> {
    if (!source.url) {
      return { ok: false, technicalStatus: 'unknown', httpStatus: null, message: 'Sin URL pública.' };
    }
    return { ok: true, technicalStatus: 'unknown', httpStatus: null, message: 'Reproductor del emisor: no se sondea.' };
  }
}

/** Channels only available in the emitter's own page: a link, never an embed. */
class ExternalAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = {
    id: 'external-reference',
    name: 'Acceso externo',
    types: ['external'],
    requirements: ['Página oficial del emisor'],
    credentialFree: true,
    enabled: true,
    description: 'Canal que solo se puede ver en la página oficial del emisor; el estado es externo, no interno.',
  };

  accepts(source: Pick<PlaybackSourceDoc, 'type'>): boolean {
    return source.type === 'external';
  }

  async verify(source: PlaybackSourceDoc): Promise<ProviderCheck> {
    if (!source.officialPageUrl) {
      return { ok: false, technicalStatus: 'unknown', httpStatus: null, message: 'Sin página oficial registrada.' };
    }
    // We do not probe the emitter's own site: that is not a signal we host.
    return { ok: true, technicalStatus: 'unknown', httpStatus: null, message: 'Acceso externo verificado editorialmente.' };
  }
}

export class ProviderRegistry {
  private readonly adapters: readonly ProviderAdapter[] = [
    new EmitterHlsAdapter(),
    new EmitterDashAdapter(),
    new YoutubeAdapter(),
    new OfficialEmbedAdapter(),
    new ExternalAdapter(),
  ];

  list(): ProviderDescriptor[] {
    return this.adapters.map((adapter) => adapter.descriptor);
  }

  forSource(source: Pick<PlaybackSourceDoc, 'type' | 'provider'>): ProviderAdapter | undefined {
    return this.adapters.find((adapter) => adapter.accepts(source));
  }

  get(id: ProviderId): ProviderAdapter | undefined {
    return this.adapters.find((adapter) => adapter.descriptor.id === id);
  }

  verify(source: PlaybackSourceDoc, egress: EgressOptions): Promise<ProviderCheck> {
    const adapter = this.forSource(source);
    if (!adapter) {
      return Promise.resolve({
        ok: false,
        technicalStatus: 'blocked',
        httpStatus: null,
        message: `Sin adaptador para el tipo "${source.type}".`,
      });
    }
    return adapter.verify(source, egress);
  }
}

export const providerRegistry = new ProviderRegistry();
