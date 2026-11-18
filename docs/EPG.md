# Guía de programación (EPG) — actualización y cobertura

Estado medido el **2026-11-18** tras integrar `iptv-epg.org`.

## Qué se entrega

La plataforma sirve la programación de emisión (EPG) de los canales del catálogo,
actualizada, con **género por programa** para filtrar («qué es series», «qué es deporte»,
«qué se emite ahora», «qué viene después»).

Datos verificados en esta entrega:

| Métrica | Valor |
| --- | --- |
| Canales enlazados a una guía | **2.195** |
| Canales emitiendo (visibles en la parrilla) | **1.693** |
| Emisiones almacenadas | **470.717** |
| Emisiones con género | **88.235** |
| Canales en emisión con género | **318** (de 1.693) |
| Países con guía | **65** |

## Fuentes

Todas son catálogos públicos de guías; ninguna requiere clave.

| Fuente | Aporta | Notas |
| --- | --- | --- |
| **`iptv-epg.org`** | XMLTV por país, **con `<category>`** | 65 países, cobertura hasta un mes. **EEUU 12.844 canales, 1,15 M emisiones; España 300 canales, 40 k**. Es la fuente principal |
| `gatotv.com` | Programación con género | 342 cadenas en 23 países; se usa cuando `iptv-epg` no cubre la cadena |
| `open-epg.com` | XMLTV por país | Cobertura amplia; **no** incluye `<category>` |
| `epgshare01.online` | EPG mundial agregado | Muchas entradas de EEUU son emisoras de radio; **no** incluye categorías |

`iptv-epg.org` es la única que combina **cobertura amplia + categorías + EEUU y Reino
Unido**, que ninguna otra fuente pública ofrecía. El género de sus categorías
(`Información`, `Deportes`, `Series`, `Infantil`, `Cine`, `Reality`…) se normaliza al
vocabulario cerrado de la plataforma.

Cuando una emisión no declara género, la API devuelve `genre: null` — **nunca se inventa**.

## Cómo consumirla

| Endpoint | Para qué |
| --- | --- |
| `GET /api/v1/epg/now?limit=100&page=N` | Qué se emite **ahora** |
| `GET /api/v1/epg/next?limit=100&page=N` | Qué se emite **a continuación** |
| `GET /api/v1/channels/{slug}/schedule` | Parrilla de un canal: `now` + `next[]` |
| `GET /api/v1/channels/{slug}/epg?date=YYYY-MM-DD` | Programación de un día |
| `GET /api/v1/epg/channels` | Cobertura de guía por canal |

Parámetros de la parrilla: `country` (dos letras), `category`, `channel` (varios slugs),
`page`, `limit`, `from`, y `includeUnmapped=true` para incluir canales sin guía.

### Corrección importante: la parrilla solo mostraba 3 canales

Hubo **dos** causas, ambas corregidas:

1. `/epg/now` recorría **todos** los canales publicados ordenados por nombre, sin
   filtrar los que no tienen guía. Tras `.black`, `.red` y `.sci-fi` venían decenas
   de canales `not-mapped`, así que la vista solo pintaba esos tres y parecía roto.
   Ahora el feed devuelve **por defecto solo canales con emisiones**; el listado
   completo sigue disponible con `includeUnmapped=true`.
2. La propia parrilla (`schedule-page.component.ts`) pedía un `/schedule` por canal
   usando `catalog.channels().slice(0, 21)` — el snapshot del catálogo solo trae la
   primera página, así que nunca podía mostrar más de una veintena de filas.

### La parrilla ahora se agrupa por país

Se lee el feed paginado (`/epg/now` + `/epg/next`), no una petición por canal:

- **Agrupación por país**, igual que las fuentes (un XMLTV por país). España primero,
  luego Internacional, y el resto por volumen de canales.
- **Selector de país** y buscador por nombre de canal.
- Se cargan 5 páginas (500 canales) al abrir y el resto con «Cargar más».
- Cada fila muestra el género del programa cuando la fuente lo declara.

`channelRef` incluye ahora `country`, necesario para agrupar.

### Filtrar por género

Vocabulario cerrado: `Series`, `Movie`, `Documentary`, `Children`, `Sports`, `News`,
`Soap`, `Music`, `Entertainment`, `Culture`.

```bash
curl -s 'http://127.0.0.1:4010/api/v1/epg/now?limit=100&page=1' \
  | jq '.data[] | select(.programme.genre=="Sports") | {canal: .channel.slug, titulo: .programme.title}'
```

## Actualizar la guía

```bash
node scripts/refresh-epg.mjs --dry-run   # descarga y cuenta, sin escribir
node scripts/refresh-epg.mjs             # descarga y escribe en MongoDB
```

El refresco es **idempotente** (clave externa `sourceId|guideId|start`) y retira lo que
terminó hace más de 7 días. Para ejecutarlo a diario en Windows:

```powershell
schtasks /Create /TN "TDT EPG" /SC DAILY /ST 05:30 /TR "node C:\Users\Admin\Documents\workspace\streaming\tdt-api01\scripts\refresh-epg.mjs"
```

## Límites, dichos sin adornos

- **6.652 canales no tienen guía en ninguna fuente pública** (de 8.758 publicados).
  Son en su mayoría locales y autonómicas pequeñas (101TV, 7TV, 3Cat Exclusiu,
  24h Canarias) que no publican su parrilla. Quedan `not-mapped` a propósito.
- **El género no llega a todos**: 306 de 1.694 canales en emisión lo declaran (18 %).
  El resto viene de fuentes que no publican `<category>`.
- **Cobertura por país desigual**: EEUU 22 %, España 21 %, Alemania 42 %, Polonia 39 %;
  Irán, Argentina y Chile por debajo del 20 % con los nombres de este catálogo.
- La guía se calcula con la fecha del sistema; si el reloj del host va mal, las ventanas
  `now`/`next` se desplazan.
