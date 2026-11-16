/**
 * Provider kinds: what a host *is*, and whether it can ever authorize playback.
 *
 * This is structure, not documentation. The researched taxonomy
 * (`docs/tdt-api02/RESEARCH_EVIDENCE-02C.md` §1) found that most Spanish
 * candidates resolve through a URL shortener, a static CDN or a catalogue
 * reference — none of which is a party that can grant a playback right. Those
 * kinds are marked `mayAuthorizePlayback: false` and the eligibility gate reads
 * that flag, so a shortener can never yield a permitted verdict even if someone
 * later attaches an "approved" authorisation record to it.
 *
 * A provider kind describes origin. It says nothing about whether a stream
 * answers: reachability is availability, a different axis from authorization.
 */

export const providerKindSchema = [
  /** URL shortener / redirector. Resolves to a destination, authorizes nothing. */
  'shortener',
  /** Static asset CDN (jsdelivr and friends). Never a broadcaster. */
  'cdn',
  /** Third-party catalogue (iptv-org, Free-TV, TDTChannels). Lists streams; its
   * licence covers the playlist file, never the streams it points at. */
  'catalogue_reference',
  /** CDN operated by the broadcaster itself (rtve.es, 3catdirectes.cat, …). */
  'broadcaster_cdn',
  /** The broadcaster's own origin / official player. */
  'broadcaster',
  /** FAST platform (Pluto, Rakuten, Samsung TV Plus). Licensed distributor, not
   * the emitter, so its terms alone never cover the underlying channel right. */
  'fast_platform',
  /** A platform whose own public embed terms are the permission (YouTube). */
  'platform',
] as const;

export type ProviderKind = (typeof providerKindSchema)[number];

export interface ProviderKindFacts {
  /** Human label, in the project's language. */
  readonly label: string;
  /** True only for kinds that are a party able to grant playback rights. */
  readonly mayAuthorizePlayback: boolean;
  /** Why that is the case. Printed in eligibility reasons, never guessed. */
  readonly rationale: string;
}

export const PROVIDER_KIND_FACTS: Readonly<Record<ProviderKind, ProviderKindFacts>> = {
  shortener: {
    label: 'Acortador de URL',
    mayAuthorizePlayback: false,
    rationale: 'Un acortador solo redirige; no es titular de derechos y no puede autorizar la reproducción.',
  },
  cdn: {
    label: 'CDN de activos estáticos',
    mayAuthorizePlayback: false,
    rationale: 'Una CDN de activos estáticos sirve ficheros; no es el emisor ni puede conceder derechos.',
  },
  catalogue_reference: {
    label: 'Catálogo de referencia',
    mayAuthorizePlayback: false,
    rationale:
      'La licencia de un catálogo de terceros cubre el fichero de lista, nunca los flujos a los que apunta.',
  },
  broadcaster_cdn: {
    label: 'CDN del emisor',
    mayAuthorizePlayback: true,
    rationale: 'Solo puede autorizar el propio emisor que la opera, y mediante licencia.',
  },
  broadcaster: {
    label: 'Emisor',
    mayAuthorizePlayback: true,
    rationale: 'El emisor es titular o licenciatario de la emisión.',
  },
  fast_platform: {
    label: 'Plataforma FAST',
    mayAuthorizePlayback: true,
    rationale:
      'Es un distribuidor licenciado, no el emisor: sus términos no cubren por sí solos el derecho del canal subyacente.',
  },
  platform: {
    label: 'Plataforma con integración oficial',
    mayAuthorizePlayback: true,
    rationale: 'La plataforma concede una integración de inserción documentada, acotada a su propio reproductor.',
  },
};

/** Kinds that can never produce a permitted verdict. The gate enforces this. */
export function kindMayAuthorizePlayback(kind: ProviderKind): boolean {
  return PROVIDER_KIND_FACTS[kind].mayAuthorizePlayback;
}

export function isProviderKind(value: string): value is ProviderKind {
  return (providerKindSchema as readonly string[]).includes(value);
}

/**
 * Host-to-kind classification, derived from the measured snapshot
 * (`data/snapshots/iptv-org-20261116T145323Z`, 483 Spanish entries / 191 hosts).
 *
 * This only *classifies origin*. It is deliberately not an authorization table:
 * a `broadcaster_cdn` host still yields `unresolved` until an operator licence is
 * recorded. Unknown hosts fall back to `catalogue_reference` — that is the
 * fail-closed default, because the candidate reached us through a catalogue.
 */
const KNOWN_HOST_KINDS: Readonly<Record<string, ProviderKind>> = {
  'jmp2.uk': 'shortener',
  'cdn.jsdelivr.net': 'cdn',
  'rtvelivestream.rtve.es': 'broadcaster_cdn',
  'rtvelivestream-rtveplayplus.rtve.es': 'broadcaster_cdn',
  'ztnr.rtve.es': 'broadcaster_cdn',
  'directes-tv-cat.3catdirectes.cat': 'broadcaster_cdn',
  'directes-tv-int.3catdirectes.cat': 'broadcaster_cdn',
  'cdn1.etbon.eus': 'broadcaster_cdn',
  /* Operator origins whose legal pages are cited in the research (§2/§3). */
  'www.rtve.es': 'broadcaster',
  'rtve.es': 'broadcaster',
  'static.atresmedia.com': 'broadcaster',
  'www.atresplayer.com': 'broadcaster',
  'www.3cat.cat': 'broadcaster',
  'www.canalsur.es': 'broadcaster',
  'www.eitb.eus': 'broadcaster',
  'www.crtvg.es': 'broadcaster',
  'www.apuntmedia.es': 'broadcaster',
  'pluto.tv': 'fast_platform',
  'www.rakuten.tv': 'fast_platform',
  'www.youtube.com': 'platform',
  'youtube.com': 'platform',
  'youtu.be': 'platform',
  'www.youtube-nocookie.com': 'platform',
};

/** Upstreams that are catalogue references by definition. */
const CATALOGUE_UPSTREAMS: ReadonlySet<string> = new Set([
  'iptv-org',
  'free-tv',
  'tdtchannels',
]);

/** FAST playlists shipped inside the iptv-org snapshot (`streams/es_pluto.m3u`, …). */
const FAST_PLAYLIST = /^[a-z]{2}_(pluto|rakuten|samsung|yowi)$/i;

export interface HostClassification {
  readonly kind: ProviderKind;
  /** Host the kind was decided on (lowercase), when one was given. */
  readonly host: string | null;
  readonly basis: 'host-list' | 'fast-playlist' | 'catalogue-upstream' | 'unknown-host';
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Classifies where a candidate really comes from. `upstreamPath` lets a FAST
 * playlist override an otherwise unknown destination host, without ever letting
 * a shortener itself be promoted.
 */
export function classifyHost(
  url: string | null | undefined,
  options: { upstream?: string | null; upstreamPath?: string | null } = {},
): HostClassification {
  const host = hostOf(url);
  if (host !== null) {
    const known = KNOWN_HOST_KINDS[host];
    if (known !== undefined) return { kind: known, host, basis: 'host-list' };
  }
  const path = options.upstreamPath ?? '';
  const stem = path.replace(/^.*[\\/]/, '').replace(/\.m3u$/i, '');
  if (FAST_PLAYLIST.test(stem)) return { kind: 'fast_platform', host, basis: 'fast-playlist' };
  if (options.upstream !== undefined && options.upstream !== null && CATALOGUE_UPSTREAMS.has(options.upstream)) {
    return { kind: 'catalogue_reference', host, basis: 'catalogue-upstream' };
  }
  return { kind: 'catalogue_reference', host, basis: 'unknown-host' };
}
