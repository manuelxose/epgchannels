/**
 * Publications policy: the single place that decides whether a source may be
 * exposed by the **public** API, and why not.
 *
 * Three questions are answered separately and never collapsed:
 *
 * | question                   | answered by                     |
 * | -------------------------- | ------------------------------- |
 * | may we expose it at all?   | `permission` + `conditions`     |
 * | is it healthy right now?   | `technicalStatus` (verification)|
 * | which engine plays it?     | `type` (and our engines)        |
 *
 * A source is public when it is published, carries a permission that allows
 * public exposure, is not marked as requiring forged headers or the emitter's
 * own application, and is not currently marked unhealthy. Authorisation always
 * outranks technical availability: an unhealthy source is not "available", but a
 * disallowed source is never exposed even when it works.
 */
import type { ExclusionReason, PlaybackType, Permission } from '@tdt/contracts';
import type { PlaybackSourceDoc } from '../../infrastructure/schema.js';

/** Permissions that allow the source to appear in the public API. */
const PUBLIC_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'emitter-public-stream',
  'emitter-embeddable',
  'official-player-only',
  'open-data-licence',
  'explicit-permission',
]);

export const EXCLUSION_MESSAGES: Readonly<Record<ExclusionReason, string>> = {
  unlicensed: 'Sin permiso de integración suficiente: no se expone públicamente.',
  'disallowed-integration': 'Las condiciones del emisor no permiten esta integración.',
  'credentials-required': 'Requiere credenciales privadas que no se transmiten ni se almacenan en registros públicos.',
  'requires-forged-header': 'Exige una cabecera que no falsificamos.',
  'emitter-app-only': 'El emisor solo permite su propia aplicación.',
  'geo-restricted': 'Restringido geográficamente por el emisor.',
  unhealthy: 'La última verificación técnica falló.',
  withdrawn: 'Fuente retirada por la redacción.',
  'channel-withdrawn': 'Canal retirado del catálogo público.',
};

export type PublicSourceDecision =
  | { readonly public: true }
  | { readonly public: false; readonly reason: ExclusionReason };

export interface PublicationContext {
  /** Editorial status of the owning channel. */
  readonly channelStatus: string;
  /** Editorial status of the source itself. */
  readonly sourceStatus: string;
  readonly permission: Permission;
  readonly technicalStatus: string;
  readonly conditions: Pick<PlaybackSourceDoc['conditions'], 'requiresForgedHeader' | 'emitterAppOnly'>;
}

/**
 * Resolution order matters: a withdrawn record is not "unhealthy", it is gone.
 * The order below is the documented precedence.
 */
export function decidePublication(context: PublicationContext): PublicSourceDecision {
  if (context.channelStatus !== 'published') {
    return { public: false, reason: 'channel-withdrawn' };
  }
  if (context.sourceStatus === 'withdrawn') {
    return { public: false, reason: 'withdrawn' };
  }
  if (context.sourceStatus !== 'published') {
    // Draft/review sources are editorial work in progress.
    return { public: false, reason: 'withdrawn' };
  }
  if (!PUBLIC_PERMISSIONS.has(context.permission)) {
    return { public: false, reason: context.permission === 'unlicensed' ? 'unlicensed' : 'disallowed-integration' };
  }
  if (context.conditions.requiresForgedHeader) {
    return { public: false, reason: 'requires-forged-header' };
  }
  if (context.conditions.emitterAppOnly) {
    return { public: false, reason: 'emitter-app-only' };
  }
  if (context.technicalStatus === 'blocked') {
    return { public: false, reason: 'disallowed-integration' };
  }
  return { public: true };
}

export function isSourcePublic(source: PlaybackSourceDoc): boolean {
  return decidePublication({
    channelStatus: 'published',
    sourceStatus: source.editorialStatus,
    permission: source.permission as Permission,
    technicalStatus: source.technicalStatus,
    conditions: source.conditions,
  }).public;
}

/** A public source that may also be attempted in our own player right now. */
export function isSourceHealthy(source: PlaybackSourceDoc): boolean {
  return source.technicalStatus === 'ok' || source.technicalStatus === 'unknown';
}

/** Playback types our engines can attempt in-app. */
export const IN_APP_TYPES: ReadonlySet<PlaybackType> = new Set<PlaybackType>([
  'hls',
  'dash',
  'youtube',
  'official-embed',
]);

/**
 * Whether the *browser* can attempt a public source in-app. `external` never
 * counts: it is a link to the emitter's own player, not an in-app emission.
 */
export function canAttemptInApp(source: PlaybackSourceDoc): boolean {
  return (
    isSourcePublic(source) &&
    isSourceHealthy(source) &&
    IN_APP_TYPES.has(source.type as PlaybackType) &&
    source.url !== null
  );
}

/** Engine a source descriptor selects on the client. */
export function engineFor(source: Pick<PlaybackSourceDoc, 'type'>): 'hls' | 'dash' | 'youtube-iframe' | 'official-embed' | 'external' {
  switch (source.type as PlaybackType) {
    case 'hls':
      return 'hls';
    case 'dash':
      return 'dash';
    case 'youtube':
      return 'youtube-iframe';
    case 'official-embed':
      return 'official-embed';
    case 'external':
      return 'external';
  }
}

/** Ordering: lower priority first, then the healthiest and most permissive. */
export function compareSources(a: PlaybackSourceDoc, b: PlaybackSourceDoc): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const geoA = a.conditions.worldwide ? 0 : 1;
  const geoB = b.conditions.worldwide ? 0 : 1;
  if (geoA !== geoB) return geoA - geoB;
  return a.createdAt.getTime() - b.createdAt.getTime();
}
