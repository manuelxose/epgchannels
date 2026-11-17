# DATA CONTRACTS

Contratos de datos de la aplicación. Todos son **normativos** para la
implementación y están validados en tiempo de ejecución (nunca con confianza
ciega en la red).

## 1. Tipos de dominio (`src/app/core/models/`)

```ts
export type MediaFormat = 'hls' | 'dash' | 'youtube' | 'iframe' | 'progressive';

export type AvailabilityTag =
  | 'GEO'     // restringido geográficamente
  | 'EXTA'    // disponible sólo en el reproductor oficial (externo A)
  | 'EXTB'    // variante externa B
  | 'EMB'     // disponible como embed
  | 'NOEM'    // el canal no emite por internet
  | 'EVT'     // canal eventual (emisión intermitente)
  | 'REG'     // reemisión
  | 'REF'     // requiere Referer
  | 'UAG'     // requiere User-Agent
  | string;   // toleramos etiquetas desconocidas sin romper

export interface MediaSource {
  readonly id: string;          // `${channelId}#${index}`
  readonly label: string;       // "Emisión 1"
  readonly format: MediaFormat;
  readonly url: string;
  readonly referer?: string;
  readonly resolution?: string;
  readonly language?: string;
  readonly geoRestricted: boolean;
}

export type PlaybackAvailability = 'playable' | 'external' | 'no-emission' | 'unavailable';

export interface Channel {
  readonly id: string;             // slug estable derivado del nombre
  readonly name: string;
  readonly originName: string;     // nombre tal como viene del catálogo
  readonly categoryId: string;
  readonly categoryName: string;
  readonly country: string;        // "España" | "Internacional"
  readonly webUrl?: string;
  readonly logoSrc?: string;
  readonly epgId?: string;
  readonly sources: readonly MediaSource[];
  readonly tags: readonly AvailabilityTag[];
  readonly availability: PlaybackAvailability;
}

export interface ChannelCategory {
  readonly id: string;
  readonly name: string;
  readonly country: string;
  readonly channelCount: number;
}

export interface CatalogSnapshot {
  readonly channels: readonly Channel[];
  readonly categories: readonly ChannelCategory[];
  readonly epgUrls: { readonly json?: string };
  readonly updatedAt: string;   // ISO
  readonly origin: 'remote' | 'demo';
}

export interface EpgProgram {
  readonly id: string;          // `${epgId}:${start}`
  readonly title: string;
  readonly description: string;
  readonly genre?: string;
  readonly coverUrl?: string;
  readonly start: Date;
  readonly end: Date;
}

export interface ChannelSchedule {
  readonly epgId: string;
  readonly programs: readonly EpgProgram[];  // ordenados por start
}
```

`PlaybackAvailability` se deriva, no se inventa:

```ts
function classify(tags, sources): PlaybackAvailability {
  if (sources.some((s) => isSupported(s.format))) return 'playable';
  if (tags.includes('EXTA') || tags.includes('EXTB') || tags.includes('EMB')) return 'external';
  if (tags.includes('NOEM')) return 'no-emission';
  return 'unavailable';
}
```

## 2. Contrato remoto: `tv.json`

```
{ "license": {...}, "epg": { "json": url }, "countries": [ { "name", "ambits": [ { "name", "channels": [ … ] } ] } ], "updated": <unix> }
channel = { name, web?, logo?, epg_id?, options: [ { format, url, geo2?, res?, lang? } ], extra_info?: string[], referer? }
```

**Validación**: se aceptan `countries[].ambits[].channels[]`; cualquier canal sin
`name` o sin `options` de tipo array se **descarta** y se cuenta como incidencia.
Un `format` desconocido se tolera y se mapea a `unsupported-format` (no
reproducible). Un URL que no sea `http(s)` se descarta.

## 3. Contrato remoto: EPG `TV.json`

```
{ "<índice>": { "name": <epg_id>, "events": [ { "hi": <epoch s>, "hf": <epoch s>, "t": <título>, "d": <descripción>, "g": <género>, "c"?: <carátula> } ] } }
```

- **Unión por `name === channel.epgId`**, nunca por la clave numérica.
- Se descartan eventos con `hi`/`hf` no finitos o `hf <= hi`.
- Se descartan eventos sin `t`.
- Se ordenan por `hi` y se eliminan duplicados `(hi,hf,t)`.
- Se conservan eventos con `hi` muy antiguo (el consumidor filtra por "ahora").

## 4. Contratos de adaptadores (puertos)

```ts
export interface ChannelCatalogAdapter {
  load(signal?: AbortSignal): Promise<CatalogSnapshot>;
}

export interface EpgProviderAdapter {
  load(signal?: AbortSignal): Promise<ReadonlyMap<string, ChannelSchedule>>;
}

export type PlaybackSourceKind = 'hls' | 'dash' | 'progressive' | 'none';

export interface PlaybackSourceAdapter {
  resolve(channel: Channel, source: MediaSource | undefined): PlaybackPlan;
}

export interface PlaybackPlan {
  readonly kind: PlaybackSourceKind;
  readonly url?: string;
  readonly externalUrl?: string;
  readonly blockedReason?: 'external' | 'no-emission' | 'unsupported-format' | 'none';
}
```

## 5. Persistencia (localStorage)

Claves y validación se especifican en `BEHAVIOR-SPEC.md §8`. Toda lectura pasa
por un `safeStorage` que:

1. captura excepciones de acceso (`SecurityError`, cuota),
2. valida forma y tipos,
3. escribe de forma atómica por clave (una clave = un valor JSON).

## 6. Contrato de demostración

`public/demo/catalog.demo.json` y `public/demo/epg.demo.json` cumplen
**exactamente** los contratos `tv.json` y `TV.json` para que el adaptador remoto
pueda consumirlos sin ramas especiales. Los medios de demostración se generan con
ffmpeg y se sirven localmente (`public/demo/media/`).

## 7. Fixtures de prueba de red

Las pruebas E2E interceptan los URLs remotos con `page.route()` y sirven fixtures
versionados en `e2e/fixtures/`. Así ninguna prueba depende de la red externa ni de
que la emisión real esté disponible.
