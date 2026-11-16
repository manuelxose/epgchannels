/**
 * Authorization-side provider adapters: the extensible registry.
 *
 * Separate from `providers.registry.ts`, which owns *technical* verification. A
 * provider here models one class of integration and declares what authorization
 * it needs, where it may be published, and what attribution it demands. The
 * registry is extended by **registration** — `new ProviderAdapterRegistry().register(adapter)`
 * — with no switch statement and no edit to existing adapters.
 *
 * An adapter's `verify` never forges headers, never replays credentials and
 * never consults technical availability: it answers "is the recorded right
 * sufficient for this integration?", nothing else.
 */
import type { PlaybackType } from '@tdt/contracts';
import {
  permitsPublicPlayback,
  type AuthorisedMethod,
  type AuthorizationRecord,
  type EligibilityClass,
} from './authorization.js';
import type { ProviderKind } from './provider-kinds.js';

/** Authorization modality an adapter requires before it will serve anything. */
export const authorisationRequirementSchema = ['published-terms', 'written-licence'] as const;
export type AuthorisationRequirement = (typeof authorisationRequirementSchema)[number];

export interface AdapterAttributionRequirement {
  /** True when the UI must display the notice with the source. */
  readonly required: boolean;
  /** The notice text, when the adapter can state it. */
  readonly notice: string | null;
}

export interface AdapterDescriptor {
  /** Stable adapter id, e.g. `broadcaster-hls`. */
  readonly id: string;
  readonly name: string;
  /** Playback types this adapter serves. */
  readonly types: readonly PlaybackType[];
  /** Origin kinds this adapter may serve. Never widened by configuration. */
  readonly providerKinds: readonly ProviderKind[];
  /** The authorization modality required before serving. */
  readonly requiresAuthorization: AuthorisationRequirement;
  /** The single class an eligible source of this adapter resolves to. */
  readonly grants: Extract<EligibilityClass, 'permitted-direct-playback' | 'permitted-official-embed'>;
  /** The authorised method this adapter implements. */
  readonly method: AuthorisedMethod;
  /** Territory scope the adapter is willing to serve; `null` means any recorded. */
  readonly territoryScope: readonly string[] | null;
  readonly attribution: AdapterAttributionRequirement;
  /** Set for platform-scoped adapters (YouTube): blocks use by other platforms. */
  readonly platform: string | null;
  readonly description: string;
  readonly enabled: boolean;
}

export interface AdapterVerdict {
  /** True when the record satisfies this adapter. */
  readonly satisfied: boolean;
  /** Machine-readable cause when it does not. */
  readonly reason: string | null;
}

export interface ProviderAdapter {
  readonly descriptor: AdapterDescriptor;
  /** Whether this adapter models the given playback type at all. */
  readonly accepts: (type: PlaybackType) => boolean;
  /** Checks the record against what the adapter requires. Pure, no network. */
  readonly verify: (record: AuthorizationRecord) => AdapterVerdict;
}

function satisfies(adapter: ProviderAdapter, record: AuthorizationRecord): AdapterVerdict {
  const d = adapter.descriptor;
  if (!d.enabled) return { satisfied: false, reason: 'adapter-disabled' };
  if (record.verdict !== d.grants) return { satisfied: false, reason: 'class-not-granted-by-adapter' };
  if (!permitsPublicPlayback(record.verdict)) return { satisfied: false, reason: 'class-does-not-permit-playback' };
  if (record.basis !== d.requiresAuthorization) {
    return { satisfied: false, reason: `requires-${d.requiresAuthorization}` };
  }
  if (record.method !== d.method) return { satisfied: false, reason: 'method-mismatch' };
  if (!d.providerKinds.includes(record.providerKind)) return { satisfied: false, reason: 'provider-kind-not-served' };
  if (d.platform !== null && record.operatorId !== d.platform) {
    return { satisfied: false, reason: 'platform-scope-violation' };
  }
  if (d.territoryScope !== null) {
    const allowed = record.territory.allowed.some((code) => d.territoryScope?.includes(code)) || record.territory.worldwide;
    if (!allowed) return { satisfied: false, reason: 'territory-out-of-scope' };
  }
  if (d.attribution.required && record.attribution === null) return { satisfied: false, reason: 'attribution-missing' };
  return { satisfied: true, reason: null };
}

/** Direct playback of a broadcaster's own manifest (HLS/DASH). */
export function broadcasterDirectAdapter(): ProviderAdapter {
  return {
    descriptor: {
      id: 'broadcaster-direct',
      name: 'Reproducción directa del emisor',
      types: ['hls', 'dash'],
      providerKinds: ['broadcaster', 'broadcaster_cdn'],
      requiresAuthorization: 'written-licence',
      grants: 'permitted-direct-playback',
      method: 'direct-playback',
      territoryScope: null,
      attribution: { required: true, notice: null },
      platform: null,
      description:
        'Manifiesto HLS/DASH del emisor. Exige licencia por escrito: una política publicada no es una cesión para reproducir el directo.',
      enabled: true,
    },
    accepts: (type) => type === 'hls' || type === 'dash',
    verify: (record) => satisfies(broadcasterDirectAdapter(), record),
  };
}

/**
 * The official YouTube IFrame integration. The permission comes from the
 * platform's own embed terms and is scoped to `platform: youtube`, so it can never
 * be used to justify playing a broadcaster's own manifest.
 */
export function youtubeEmbedAdapter(): ProviderAdapter {
  const adapter: ProviderAdapter = {
    descriptor: {
      id: 'youtube-embed',
      name: 'YouTube IFrame (oficial)',
      types: ['youtube'],
      providerKinds: ['platform'],
      requiresAuthorization: 'published-terms',
      grants: 'permitted-official-embed',
      method: 'official-embed',
      territoryScope: null,
      attribution: { required: true, notice: 'Reproducido por el reproductor oficial de YouTube.' },
      platform: 'youtube',
      description:
        'Inserción del reproductor oficial de YouTube. Permiso de la plataforma, acotado a `platform: youtube`; nunca autorización de reproducción directa.',
      enabled: true,
    },
    accepts: (type) => type === 'youtube',
    verify: (record) => satisfies(adapter, record),
  };
  return adapter;
}

/** Third-party official player embedded by the emitter, under written licence. */
export function officialEmbedAdapter(): ProviderAdapter {
  const adapter: ProviderAdapter = {
    descriptor: {
      id: 'official-embed',
      name: 'Reproductor oficial del emisor',
      types: ['official-embed'],
      providerKinds: ['broadcaster', 'broadcaster_cdn', 'fast_platform'],
      requiresAuthorization: 'written-licence',
      grants: 'permitted-official-embed',
      method: 'official-embed',
      territoryScope: null,
      attribution: { required: true, notice: null },
      platform: null,
      description: 'Inserción del reproductor oficial del emisor bajo licencia escrita.',
      enabled: true,
    },
    accepts: (type) => type === 'official-embed',
    verify: (record) => satisfies(adapter, record),
  };
  return adapter;
}

export class DuplicateAdapterError extends Error {
  constructor(id: string) {
    super(`Provider adapter "${id}" is already registered.`);
    this.name = 'DuplicateAdapterError';
  }
}

/**
 * Registry keyed by adapter id, extended through `register`. Registration is
 * additive: nothing is removed and no built-in is special-cased.
 */
export class ProviderAdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(initial: readonly ProviderAdapter[] = []) {
    for (const adapter of initial) this.register(adapter);
  }

  register(adapter: ProviderAdapter): this {
    if (this.adapters.has(adapter.descriptor.id)) throw new DuplicateAdapterError(adapter.descriptor.id);
    this.adapters.set(adapter.descriptor.id, adapter);
    return this;
  }

  list(): AdapterDescriptor[] {
    return [...this.adapters.values()].map((adapter) => adapter.descriptor);
  }

  get(id: string): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  /** Adapters that model this playback type, in registration order. */
  forType(type: PlaybackType): ProviderAdapter[] {
    return [...this.adapters.values()].filter((adapter) => adapter.accepts(type));
  }

  /**
   * Whether any registered adapter is satisfied by the record. Fails closed:
   * an empty registry or an unknown type yields `false`.
   */
  verify(record: AuthorizationRecord, type: PlaybackType): AdapterVerdict {
    const candidates = this.forType(type);
    if (candidates.length === 0) return { satisfied: false, reason: 'no-adapter-for-type' };
    const failures: string[] = [];
    for (const adapter of candidates) {
      const verdict = adapter.verify(record);
      if (verdict.satisfied) return verdict;
      failures.push(`${adapter.descriptor.id}:${verdict.reason ?? 'rejected'}`);
    }
    return { satisfied: false, reason: failures.join(',') };
  }
}

/** The default registry: every built-in adapter, registered explicitly. */
export function createDefaultAdapterRegistry(): ProviderAdapterRegistry {
  return new ProviderAdapterRegistry([broadcasterDirectAdapter(), youtubeEmbedAdapter(), officialEmbedAdapter()]);
}

export const providerAdapterRegistry = createDefaultAdapterRegistry();
