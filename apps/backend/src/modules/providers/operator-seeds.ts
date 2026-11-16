/**
 * Operator authorization seed, transcribed from the measured research.
 *
 * Source: `docs/tdt-api02/RESEARCH_EVIDENCE-02C.md` (t1, commit `8b2bc14`).
 * Every entry cites the exact URL the quoted clause was read from, and every
 * verdict reflects only what that page says — absence of a prohibition is NOT
 * read as permission, which is why RTVE/Mediaset/CRTVG are `unresolved` rather
 * than permitted.
 *
 * Outcome, and the correct one: **zero Spanish operators reach a permitted
 * class on published evidence.** Five prohibit public communication, three could
 * not be captured, and the FAST platforms' terms forbid it. Operators with a
 * documented licensing channel carry `requires-written-licence`: blocked, but
 * still reachable by a procurement action rather than permanently excluded.
 *
 * YouTube is the one platform whose *own* terms grant an embed. That grant is
 * scoped to `platform: youtube` and is `permitted-official-embed` only — never a
 * direct-playback authorization for the broadcaster's own manifest.
 */
import type { AuthorizationRecord, DiscoveryEvidence } from './authorization.js';
import type { ProviderKind } from './provider-kinds.js';

export interface OperatorSeed {
  readonly operatorId: string;
  readonly name: string;
  /** Hosts observed in the measured snapshot for this operator. */
  readonly hosts: readonly string[];
  readonly providerKind: ProviderKind;
  readonly verdict: AuthorizationRecord['verdict'];
  readonly basis: AuthorizationRecord['basis'];
  readonly quotedClause: string | null;
  readonly clauseUrl: string | null;
  readonly method: AuthorizationRecord['method'];
  readonly publicationScope: AuthorizationRecord['publicationScope'];
  readonly restrictions: readonly string[];
  readonly attribution: string | null;
  readonly reviewStatus: AuthorizationRecord['reviewStatus'];
  readonly notes: string | null;
  /** Where the licensing channel is, when one exists. */
  readonly licensingChannel: string | null;
}

const GEO_BLOCKED_RESTRICTION = 'Marcada [Geo-blocked] por el catálogo de origen: no se intenta fuera de su territorio.';

/** Shared restriction for every operator whose terms reserve public communication. */
const NO_PUBLIC_COMMUNICATION = 'Los términos del operador reservan la comunicación pública: requiere autorización previa y por escrito.';
const KEEP_MARKS = 'No se alteran ni ocultan las marcas de autoría del operador.';
const NO_PROXY = 'No se permite proxy, grabación ni transcodificación de la señal.';

export const OPERATOR_SEEDS: readonly OperatorSeed[] = [
  {
    operatorId: 'rtve',
    name: 'RTVE',
    hosts: ['rtvelivestream.rtve.es', 'rtvelivestream-rtveplayplus.rtve.es', 'ztnr.rtve.es'],
    providerKind: 'broadcaster_cdn',
    // Legal notice reserves rights but does not mention embedding either way.
    verdict: 'unresolved',
    basis: 'none',
    quotedClause:
      '«Cualquier ejercicio de los anteriores derechos… requiere autorización previa y por escrito»',
    clauseUrl: 'https://www.rtve.es/comunes/aviso_legal.html',
    method: 'none',
    publicationScope: 'none',
    restrictions: [NO_PUBLIC_COMMUNICATION, KEEP_MARKS, NO_PROXY],
    attribution: 'RTVE',
    reviewStatus: 'pending-review',
    notes:
      'El aviso legal reserva derechos pero no se pronuncia sobre la inserción. Los términos RSS rigen sindicación de texto, no vídeo. Sin API/embed oficial publicada.',
    licensingChannel: null,
  },
  {
    operatorId: 'atresmedia',
    name: 'Atresmedia (Antena 3, laSexta, Neox, Nova, Mega, Atresplayer)',
    hosts: [],
    providerKind: 'broadcaster_cdn',
    verdict: 'restricted',
    basis: 'published-terms',
    quotedClause:
      '«Queda prohibido establecer frames o marcos de cualquier tipo que envuelvan al Portal o permitan la visualización de sus contenidos a través de direcciones de Internet distintas a las del propio Portal»',
    clauseUrl: 'https://statics.atresmedia.com/sites/assets/legal/legal.html',
    method: 'none',
    publicationScope: 'none',
    restrictions: [NO_PUBLIC_COMMUNICATION, '§1.2 prohíbe también el enlace directo ("linkados").', KEEP_MARKS, NO_PROXY],
    attribution: 'Atresmedia',
    reviewStatus: 'requires-written-licence',
    notes: '§1.4 prohíbe explícitamente el framing. La única vía es licencia escrita por portalventas.',
    licensingChannel: 'https://portalventas.atresmedia.com',
  },
  {
    operatorId: 'ccma',
    name: 'CCMA / 3Cat (TV3, SX3, 3/24)',
    hosts: ['directes-tv-cat.3catdirectes.cat', 'directes-tv-int.3catdirectes.cat'],
    providerKind: 'broadcaster_cdn',
    verdict: 'restricted',
    basis: 'published-terms',
    quotedClause:
      '«queda prohibida la còpia, la comunicació pública, la distribució, la comercialització o qualsevol altra activitat amb una finalitat o ús públic… si no es compta amb un consentiment exprés»',
    clauseUrl: 'https://www.3cat.cat/avis-legal/que-oferim/',
    method: 'none',
    publicationScope: 'none',
    restrictions: [
      NO_PUBLIC_COMMUNICATION,
      'La excepción de blogs alcanza a insertar contenido publicado, no al directo de una parrilla de agregador.',
      KEEP_MARKS,
      NO_PROXY,
    ],
    attribution: 'CCMA / 3Cat',
    reviewStatus: 'requires-written-licence',
    notes:
      'Única excepción permisiva hallada entre los ocho operadores: inserción en blogs, estrecha y sin cubrir el directo. No promueve el veredicto.',
    licensingChannel: 'https://www.3cat.cat/avis-legal/condicions-utilitzacio-del-portal/',
  },
  {
    operatorId: 'rtva',
    name: 'Canal Sur / RTVA',
    hosts: ['www.canalsur.es'],
    providerKind: 'broadcaster',
    verdict: 'restricted',
    basis: 'published-terms',
    quotedClause:
      '«Cualquier reproducción, transmisión, adaptación, traducción, modificación, comunicación al público, o cualquier otra explotación comercial o no… está expresa y estrictamente prohibida, salvo autorización expresa previa y por escrito de RTVA»',
    clauseUrl: 'https://www.canalsur.es/enlaces-legales/normas-de-uso/',
    method: 'none',
    publicationScope: 'none',
    restrictions: [NO_PUBLIC_COMMUNICATION, KEEP_MARKS, NO_PROXY],
    attribution: 'Canal Sur / RTVA',
    reviewStatus: 'requires-written-licence',
    notes: 'Prohibición explícita e inequívoca de toda comunicación pública sin autorización escrita.',
    licensingChannel: 'https://www.canalsur.es/enlaces-legales/normas-de-uso/',
  },
  {
    operatorId: 'eitb',
    name: 'EITB / ETB',
    hosts: ['cdn1.etbon.eus'],
    providerKind: 'broadcaster_cdn',
    verdict: 'restricted',
    basis: 'published-terms',
    quotedClause:
      '«Los Usuarios pueden hacer uso privado del Sitio Web y de sus Contenidos, si bien, en ningún caso podrán hacer uso comercial del mismo, ni alterar sus elementos, reproducirlos más allá de su uso privado, distribuirlos o comunicarlos públicamente»',
    clauseUrl: 'https://www.eitb.eus/es/aviso-legal/',
    method: 'none',
    publicationScope: 'none',
    restrictions: [NO_PUBLIC_COMMUNICATION, KEEP_MARKS, NO_PROXY],
    attribution: 'EITB',
    reviewStatus: 'requires-written-licence',
    notes: '§3 del aviso legal: uso privado únicamente, sin comunicación pública.',
    licensingChannel: 'https://www.eitb.eus/es/aviso-legal/',
  },
  {
    operatorId: 'cacvsa',
    name: 'À Punt (CACVSA)',
    hosts: ['www.apuntmedia.es'],
    providerKind: 'broadcaster',
    verdict: 'restricted',
    basis: 'published-terms',
    quotedClause:
      '«queden expressament prohibides la reproducció, distribució i comunicació pública, inclosa la modalitat de posada a disposició… amb finalitats comercials… sense l\'autorització prèvia de l\'CACVSA»',
    clauseUrl: 'https://www.apuntmedia.es/condicions-d-us/',
    method: 'none',
    publicationScope: 'none',
    restrictions: [NO_PUBLIC_COMMUNICATION, '«En cap circumstància s\'entendrà que es concedeix cap llicència».', KEEP_MARKS, NO_PROXY],
    attribution: 'À Punt / CACVSA',
    reviewStatus: 'requires-written-licence',
    notes: 'Las condiciones excluyen expresamente cualquier concesión de licencia.',
    licensingChannel: 'https://www.apuntmedia.es/condicions-d-us/',
  },
  {
    operatorId: 'mediaset',
    name: 'Mediaset España (Telecinco, Cuatro, Mitele)',
    hosts: [],
    providerKind: 'broadcaster_cdn',
    verdict: 'unresolved',
    basis: 'none',
    quotedClause: null,
    clauseUrl: null,
    method: 'none',
    publicationScope: 'none',
    restrictions: ['Sin texto legal capturado: no se afirma nada en ningún sentido.', NO_PROXY],
    attribution: 'Mediaset España',
    reviewStatus: 'pending-review',
    notes:
      'NO VERIFICADO: las páginas legales devolvieron 404 o shells JS. Requiere una pasada de evidencia de seguimiento.',
    licensingChannel: null,
  },
  {
    operatorId: 'crtvg',
    name: 'TVG / CRTVG',
    hosts: ['www.crtvg.es'],
    providerKind: 'broadcaster',
    verdict: 'unresolved',
    basis: 'none',
    quotedClause: null,
    clauseUrl: null,
    method: 'none',
    publicationScope: 'none',
    restrictions: ['Sin texto legal extraído (shell sin cuerpo): no se afirma nada.', NO_PROXY],
    attribution: 'CRTVG',
    reviewStatus: 'pending-review',
    notes: 'NO EXTRAÍDO: el cuerpo del aviso legal no se obtuvo. Requiere seguimiento.',
    licensingChannel: null,
  },
  {
    operatorId: 'pluto-tv',
    name: 'Pluto TV (Pluto TV Europe GmbH)',
    hosts: ['pluto.tv'],
    providerKind: 'fast_platform',
    verdict: 'restricted',
    basis: 'published-terms',
    quotedClause:
      '«Usted no deberá… distribuir, difundir, transmitir o circular a terceros (incluyendo… en o a través de un sitio web de terceros)… sin el consentimiento previo por escrito de Pluto»',
    clauseUrl: 'https://legal.paramount.com/es/es/plutotv/terms-of-use',
    method: 'none',
    publicationScope: 'none',
    restrictions: [
      '§4: uso personal no comercial y no cedible.',
      '§6 prohíbe el uso comercial mediante enlaces y el scraping.',
      NO_PROXY,
    ],
    attribution: 'Pluto TV',
    reviewStatus: 'pending-review',
    notes: 'Distribuidor licenciado, no emisor: sus términos no cubren el derecho del canal subyacente.',
    licensingChannel: null,
  },
  {
    operatorId: 'rakuten-tv',
    name: 'Rakuten TV',
    hosts: [],
    providerKind: 'fast_platform',
    verdict: 'unresolved',
    basis: 'none',
    quotedClause: null,
    clauseUrl: null,
    method: 'none',
    publicationScope: 'none',
    restrictions: ['Sin política de integración localizada: no se afirma nada.', NO_PROXY],
    attribution: 'Rakuten TV',
    reviewStatus: 'pending-review',
    notes: 'NO VERIFICADO: no se localizó política de integración.',
    licensingChannel: null,
  },
  {
    operatorId: 'samsung-tv-plus',
    name: 'Samsung TV Plus',
    hosts: [],
    providerKind: 'fast_platform',
    verdict: 'unresolved',
    basis: 'none',
    quotedClause: null,
    clauseUrl: null,
    method: 'none',
    publicationScope: 'none',
    restrictions: ['Sin política de integración localizada: no se afirma nada.', NO_PROXY],
    attribution: 'Samsung TV Plus',
    reviewStatus: 'pending-review',
    notes: 'NO VERIFICADO: no se localizó política de integración.',
    licensingChannel: null,
  },
  {
    operatorId: 'yowi',
    name: 'Yowi',
    hosts: [],
    providerKind: 'fast_platform',
    verdict: 'unresolved',
    basis: 'none',
    quotedClause: null,
    clauseUrl: null,
    method: 'none',
    publicationScope: 'none',
    restrictions: ['Sin entradas en el snapshot: nada que evaluar.', NO_PROXY],
    attribution: 'Yowi',
    reviewStatus: 'pending-review',
    notes: '0 entradas en `es_yowi.m3u`.',
    licensingChannel: null,
  },
];

/**
 * The one permitted integration, and it is deliberately narrow.
 *
 * YouTube's own terms grant the IFrame embed. That grant belongs to the platform,
 * not to the broadcaster, so it is `permitted-official-embed` bound to
 * `platform: youtube` and can never be read as permission to play the
 * broadcaster's own HLS manifest.
 */
export const YOUTUBE_PLATFORM_SEED: {
  readonly operatorId: 'youtube';
  readonly providerKind: ProviderKind;
  readonly verdict: AuthorizationRecord['verdict'];
  readonly basis: AuthorizationRecord['basis'];
  readonly quotedClause: string;
  readonly clauseUrl: string;
  readonly method: AuthorizationRecord['method'];
  readonly publicationScope: AuthorizationRecord['publicationScope'];
  readonly restrictions: readonly string[];
  readonly attribution: string;
} = {
  operatorId: 'youtube',
  providerKind: 'platform',
  verdict: 'permitted-official-embed',
  basis: 'published-terms',
  quotedClause: 'La integración IFrame pública de YouTube permite insertar el reproductor oficial en una página de terceros.',
  clauseUrl: 'https://developers.google.com/youtube/terms/api-services-terms-of-service',
  method: 'official-embed',
  publicationScope: 'in-app',
  restrictions: [
    'Ámbito limitado a `platform: youtube`: el reproductor oficial de YouTube, nunca reproducción directa.',
    'No cubre el manifiesto HLS del emisor ni implica respaldo del emisor.',
    KEEP_MARKS,
    NO_PROXY,
  ],
  attribution: 'YouTube',
};

/** Default discovery evidence for a seed: documentary, not catalogue-derived. */
export function seedDiscovery(seed: OperatorSeed): DiscoveryEvidence {
  return {
    upstream: null,
    snapshotId: null,
    path: null,
    line: null,
    sourceUrl: null,
    documentUrl: seed.clauseUrl,
    retrievedAt: null,
  };
}

export { GEO_BLOCKED_RESTRICTION };
