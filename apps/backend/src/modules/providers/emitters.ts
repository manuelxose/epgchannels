/**
 * Emitter allowlist: which official emitters this platform has *decided* to
 * integrate, with the basis for that decision.
 *
 * A host that is not listed is **not** rejected as illegal; it is marked
 * `unreviewed`, which means the publication policy will not expose its sources
 * until an editor records a decision. That keeps the default safe (no unreviewed
 * stream is ever presented as ours) without hiding anything: unreviewed sources
 * stay in the database, in the admin UI, and in the migration report.
 *
 * `basis` values:
 * - `public-broadcaster`: the emitter is a statutory public broadcaster or a
 *   public institution publishing its own channel as a public service.
 * - `operator-published`: the operator publishes its own linear channel on its
 *   own site for direct viewing (its own player and terms apply).
 * - `platform-embed`: a platform whose terms include embedding the emitter's
 *   own public player (the emitter keeps control of the stream).
 * - `reference-only`: catalogue metadata only; the signal is never exposed.
 */
export type EmitterBasis =
  | 'public-broadcaster'
  | 'operator-published'
  | 'platform-embed'
  | 'reference-only'
  | 'unreviewed';

export interface EmitterEntry {
  /** Registrable domain, without `www.`. */
  readonly host: string;
  readonly label: string;
  readonly basis: EmitterBasis;
  /**
   * True when this emitter's own streams may be listed as public sources.
   * `reference-only` emitters keep their catalogue entry but expose nothing.
   */
  readonly exposeSources: boolean;
}

const ENTRIES: EmitterEntry[] = [
  // --- Statutory public broadcasters and public institutions (Spain).
  { host: 'rtve.es', label: 'RTVE (Corporación de Radio y Televisión Española)', basis: 'public-broadcaster', exposeSources: true },
  { host: 'rtvelivestream.rtve.es', label: 'RTVE (CDN de emisión pública)', basis: 'public-broadcaster', exposeSources: true },
  { host: '3cat.cat', label: '3Cat (CCMA)', basis: 'public-broadcaster', exposeSources: true },
  { host: 'agalega.gal', label: 'CRTVG', basis: 'public-broadcaster', exposeSources: true },
  { host: 'aragonplay.es', label: 'Aragón TV', basis: 'public-broadcaster', exposeSources: true },
  { host: 'etbon.eus', label: 'EITB', basis: 'public-broadcaster', exposeSources: true },
  { host: 'ib3.org', label: 'IB3', basis: 'public-broadcaster', exposeSources: true },
  { host: 'canalextremadura.app', label: 'Canal Extremadura', basis: 'public-broadcaster', exposeSources: true },
  { host: 'canalsurmas.es', label: 'Canal Sur', basis: 'public-broadcaster', exposeSources: true },
  { host: 'cyltvplay.es', label: 'CyLTV (Radio Televisión de Castilla y León)', basis: 'public-broadcaster', exposeSources: true },
  { host: 'congreso.es', label: 'Congreso de los Diputados (canal institucional)', basis: 'public-broadcaster', exposeSources: true },
  { host: 'canariasplay.es', label: 'Televisión Canaria', basis: 'public-broadcaster', exposeSources: true },
  { host: '7tvandalucia.es', label: '7TV Andalucía (emisoras locales)', basis: 'operator-published', exposeSources: true },
  { host: 'rtp.pt', label: 'RTP (Rádio e Televisão de Portugal)', basis: 'public-broadcaster', exposeSources: true },
  { host: 'play.rtl.it', label: 'RTL 102.5 (Italia)', basis: 'operator-published', exposeSources: true },
  { host: 'snrtlive.ma', label: 'SNRT (Marruecos)', basis: 'public-broadcaster', exposeSources: true },
  { host: 'tvperu.gob.pe', label: 'TV Perú (IRTP)', basis: 'public-broadcaster', exposeSources: true },
  { host: 'boliviatv.bo', label: 'Bolivia TV (estatal)', basis: 'public-broadcaster', exposeSources: true },
  { host: 'cgtn.com', label: 'CGTN', basis: 'public-broadcaster', exposeSources: true },

  // --- Operators publishing their own linear channel.
  { host: 'mitele.es', label: 'Mediaset España (Mitele)', basis: 'operator-published', exposeSources: true },
  { host: 'mediasetinfinity.es', label: 'Mediaset España', basis: 'operator-published', exposeSources: true },
  { host: 'laseptima.com', label: 'La Séptima', basis: 'operator-published', exposeSources: true },
  { host: 'dkiss.es', label: 'DKISS', basis: 'operator-published', exposeSources: true },
  { host: 'tentv.es', label: 'Ten TV', basis: 'operator-published', exposeSources: true },
  { host: 'veo7.com', label: 'Veo7 (El Toro TV)', basis: 'operator-published', exposeSources: true },
  { host: 'eltorotv.com', label: 'El Toro TV', basis: 'operator-published', exposeSources: true },
  { host: '101play.tv', label: '101 Play (operador de canales)', basis: 'operator-published', exposeSources: true },
  { host: 'laxarxames.cat', label: 'La Xarxa (red de televisiones locales)', basis: 'operator-published', exposeSources: true },
  { host: 'grup4.com', label: 'Grupo 4', basis: 'operator-published', exposeSources: true },
  { host: 'la7tv.es', label: 'La 7 Televisión', basis: 'operator-published', exposeSources: true },
  { host: 'cmmedia.es', label: 'CM Media', basis: 'operator-published', exposeSources: true },
  { host: 'tlmad.es', label: 'TL Mad', basis: 'operator-published', exposeSources: true },
  { host: '8cadiz.es', label: '8 Cádiz', basis: 'operator-published', exposeSources: true },
  { host: 'dieztv.es', label: 'Diez TV', basis: 'operator-published', exposeSources: true },
  { host: 'squirreltv.es', label: 'Squirrel TV', basis: 'operator-published', exposeSources: true },
  { host: 'squirrel2.tv', label: 'Squirrel TV', basis: 'operator-published', exposeSources: true },
  { host: 'ptvtelecom.com', label: 'PTV Telecom', basis: 'operator-published', exposeSources: true },
  { host: 'bloomberg.com', label: 'Bloomberg', basis: 'operator-published', exposeSources: true },
  { host: 'es.euronews.com', label: 'Euronews (edición española)', basis: 'operator-published', exposeSources: true },
  { host: 'ocko.tv', label: 'OCKO', basis: 'operator-published', exposeSources: true },

  // --- Platforms whose public player may be embedded (the emitter keeps control).
  { host: 'youtube.com', label: 'YouTube (reproductor oficial IFrame)', basis: 'platform-embed', exposeSources: true },
  { host: 'www.youtube.com', label: 'YouTube (reproductor oficial IFrame)', basis: 'platform-embed', exposeSources: true },
  { host: 'youtu.be', label: 'YouTube (enlace corto)', basis: 'platform-embed', exposeSources: true },
  { host: 'twitch.tv', label: 'Twitch (reproductor oficial)', basis: 'platform-embed', exposeSources: true },
  { host: 'www.twitch.tv', label: 'Twitch (reproductor oficial)', basis: 'platform-embed', exposeSources: true },

  // --- Reference only: the catalogue entry is kept, the signal is never exposed.
  { host: 'cope.es', label: 'COPE', basis: 'reference-only', exposeSources: false },
  { host: 'cadenaser.com', label: 'Cadena SER', basis: 'reference-only', exposeSources: false },
  { host: 'ondacero.es', label: 'Onda Cero', basis: 'reference-only', exposeSources: false },
  { host: 'elpais.com', label: 'El País (medios)', basis: 'reference-only', exposeSources: false },
  { host: 'lavanguardia.com', label: 'La Vanguardia (medios)', basis: 'reference-only', exposeSources: false },
  { host: 'abc.es', label: 'ABC (medios)', basis: 'reference-only', exposeSources: false },
  { host: 'elconfidencial.com', label: 'El Confidencial (medios)', basis: 'reference-only', exposeSources: false },
  { host: 'elmundo.es', label: 'El Mundo (medios)', basis: 'reference-only', exposeSources: false },
  { host: 'larazon.es', label: 'La Razón (medios)', basis: 'reference-only', exposeSources: false },
  { host: 'okdiario.com', label: 'OkDiario (medios)', basis: 'reference-only', exposeSources: false },
  { host: 'efe.com', label: 'Agencia EFE', basis: 'reference-only', exposeSources: false },
  { host: 'eldebate.com', label: 'El Debate (medios)', basis: 'reference-only', exposeSources: false },
  { host: 'negocios.com', label: 'Negocios.com (medios)', basis: 'reference-only', exposeSources: false },
];

const BY_HOST = new Map(ENTRIES.map((entry) => [entry.host.replace(/^www\./, ''), entry]));

/** Resolves an emitter decision for a URL host, falling back to its domain. */
export function emitterFor(url: string | null | undefined): EmitterEntry {
  if (!url) {
    return { host: '', label: 'Sin dominio de emisor', basis: 'unreviewed', exposeSources: false };
  }
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { host: '', label: 'Dominio no válido', basis: 'unreviewed', exposeSources: false };
  }
  const direct = BY_HOST.get(host) ?? BY_HOST.get(host.replace(/^www\./, ''));
  if (direct) return direct;
  // Fall back to the registrable domain (last two or three labels).
  const labels = host.split('.');
  for (let index = 1; index < labels.length - 1; index += 1) {
    const candidate = labels.slice(index).join('.');
    const entry = BY_HOST.get(candidate);
    if (entry) return entry;
  }
  return { host, label: `Emisor sin revisión (${host})`, basis: 'unreviewed', exposeSources: false };
}

export const EMITTER_ENTRIES: readonly EmitterEntry[] = ENTRIES;
