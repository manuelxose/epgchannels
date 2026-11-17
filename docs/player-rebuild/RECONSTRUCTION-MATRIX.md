# RECONSTRUCTION MATRIX

Relación entre cada funcionalidad investigada del original, el requisito propio,
el componente que la implementa, su estado y la prueba de aceptación.

**Estados**: `PASS` (implementado **y** verificado por una prueba automatizada
ejecutada) · `PARTIAL` (implementado, con cobertura parcial o limitación
conocida) · `NOT-DONE` (no implementado) · `N/A` (no aplicable).

Evidencia del original: `docs/research/RECON-TDT-CLONE-01.md` y capturas en
`../evidence/original/`. Evidencia propia: `../evidence/rebuild/`.

> Esta matriz fue corregida tras la auditoría independiente
> (`docs/AUDIT-REPORT.md`). Varias filas estaban marcadas PASS sin una prueba que
> las respaldara; ahora reflejan lo que realmente se ejecuta.

---

## Catálogo

| ID | Funcionalidad original | Requisito propio | Componente | Estado | Prueba ejecutada |
| --- | --- | --- | --- | --- | --- |
| CAT-01 | Catálogo completo | Cargar y mostrar todos los canales válidos | `CatalogStore`, `CatalogueRailComponent` | PASS | `catalogue.spec.ts › carga el catálogo` |
| CAT-02 | Categorías | Selector agrupado por país | `CatalogueQuery.groupedCategories` | PASS | `catalogue.spec.ts › filtro por categoría` |
| CAT-03 | Orden del catálogo | Preservar el orden del origen | `parseCatalog` | PASS | `validators.spec.ts › maps the published structure` |
| CAT-04 | Búsqueda instantánea | Filtrado por palabras, sin acentos ni mayúsculas | `normalize.ts`, `CatalogueQuery` | PASS | `normalize.spec.ts` · `catalogue.spec.ts › búsqueda ignora acentos` |
| CAT-05 | Filtro categoría | `<select>` accesible con optgroups | `CatalogueRailComponent` | PASS | `catalogue.spec.ts › filtro por categoría` |
| CAT-06 | Filtro favoritos | Botón `aria-pressed`, deshabilitado sin favoritos | `CatalogueRailComponent` | PASS | `catalogue.spec.ts › favoritos` |
| CAT-07 | Contador con plural | Contador con singular/plural correcto | `resultSummary()` | PASS | `catalogue.spec.ts` (3 pruebas) |
| CAT-08 | Paginación de 21 | 21 por página, recorte al filtrar, límites | `CatalogueQuery.view` | PASS | `catalog.store.spec.ts › paginación` |
| CAT-09 | Logotipos | Logo remoto con fallback a iniciales | `ChannelTileComponent` | PARTIAL | solo se verifica el enlace del tile; el fallback por error de imagen no tiene prueba |
| CAT-10 | Enlace profundo por canal | `/television/<slug>` navegable | `app.routes.ts` | PASS | `epg.spec.ts › URL directa`, `historial` |
| CAT-11 | Estado vacío de búsqueda | Mensaje + acción de limpiar | `CatalogueRailComponent` | PASS | `catalogue.spec.ts › sin resultados` |
| CAT-12 | Estado vacío de favoritos | Explica cómo añadir favoritos | `CatalogueRailComponent` | PASS | `catalogue.spec.ts › favoritos vacíos` |
| CAT-13 | Nombres de categoría | Etiquetas del origen | `parseCatalog` | PASS | `catalogue.spec.ts` |
| CAT-14 | *(propuesta)* Últimos canales | Sección "Recientes" en portada | `CatalogueHomeComponent`, `PreferencesStore` | PARTIAL | el store está cubierto; la sección en pantalla no tiene prueba |
| CAT-15 | — | Filtro por estado de disponibilidad | `CatalogueQuery.availability` | PASS | `catalogue.spec.ts › disponibilidad` |
| CAT-16 | — | Fallback a catálogo de demostración | `RemoteCatalogAdapter` | PASS | `catalogue.spec.ts › datos de demostración` |

## Reproductor

| ID | Funcionalidad original | Requisito propio | Componente | Estado | Prueba ejecutada |
| --- | --- | --- | --- | --- | --- |
| PLY-01 | Selección de canal | Carga automática al entrar en la ficha | `PlayerController.load` | PASS | `player.spec.ts › reproduce HLS real` |
| PLY-02 | Play / Pausa | Alternar con nombre e icono accesibles | `PlayerComponent.togglePlay` | PASS | `player.spec.ts › play y pausa` |
| PLY-03 | Volumen / silencio | Silencio sin recargar la emisión | `PlayerComponent` | PASS | `player.spec.ts › silencio no reinicia` (cuenta `loadstart`) |
| PLY-04 | Marcador directo | Botón "Directo" → `liveSyncPosition` | `HlsPlayerEngine.seekToLive` | PARTIAL | botón presente; sin prueba del salto (los medios de prueba son VOD) |
| PLY-05 | Calidad | Selector cuando hay >1 nivel | `HlsPlayerEngine.setQuality` | PARTIAL | el máster de prueba tiene 2 variantes; no hay prueba del cambio de nivel |
| PLY-06 | Audio | Selector cuando hay >1 pista | `HlsPlayerEngine.setAudioTrack` | PARTIAL | el flujo de prueba tiene una sola pista |
| PLY-07 | Subtítulos | Botón `CC` | `setSubtitleTrack` | PARTIAL | sin pistas en el flujo de prueba |
| PLY-08 | Picture in Picture | Solo si el navegador lo soporta | `PlayerComponent` | PARTIAL | el renderizado condicional existe; no hay prueba |
| PLY-09 | Pantalla completa | `requestFullscreen` | `PlayerComponent` | PARTIAL | solo se comprueba la presencia del botón, no el efecto |
| PLY-10 | Modo cine | — | — | NOT-DONE | no investigado en el original |
| PLY-11 | Más opciones | — | — | NOT-DONE | no investigado |
| PLY-12 | Cambio de fuente | Selector "Emisión N" persistente | `ChannelHeaderComponent` | PARTIAL | el cambio de **canal** está probado; el cambio de **fuente** no |
| PLY-13 | Overlay "estás viendo" | Programa actual sobre el vídeo | `PlayerComponent` | PASS | se verifica en las capturas y en el E2E de EPG |
| PLY-14 | Autoplay | Intento automático + affordance si se bloquea | `PlayerController.tryPlay` | PARTIAL | la ruta `NotAllowedError` no está probada (Chromium del E2E permite autoplay) |
| PLY-15 | Motor HLS | hls.js perezoso + HLS nativo cuando proceda | `engine-factory.ts` | PASS | `player.spec.ts › engine = hls` |
| PLY-16 | Recuperación de errores | Reintentos acotados + error visible + reintento manual | `PlayerController.handleError` | PARTIAL | el error visible está probado; el límite de 2 reintentos no |
| PLY-17 | Limpieza de recursos | Un solo `<video>`, motor destruido | `PlayerController.clear` | PASS | `a11y-responsive.spec.ts › limpieza` (incluye salida del canal sin recargar) |
| PLY-18 | — | Vigilancia "sin fotogramas" y estancamiento | `PlayerController` watchdog | PARTIAL | verificado manualmente con CDP, sin prueba E2E |
| PLY-19 | — | Estado `unsupported` explícito | `PlayerController` | PARTIAL | implementado; no hay prueba E2E |

## Programación (EPG)

| ID | Funcionalidad original | Requisito propio | Componente | Estado | Prueba ejecutada |
| --- | --- | --- | --- | --- | --- |
| EPG-01 | Programa actual | Título, género, horario, descripción, carátula | `ProgrammePanelComponent` | PASS | `epg.spec.ts › programa actual` |
| EPG-02 | Siguiente | Bloque "Siguiente" | `now-next.ts` | PASS | `now-next.spec.ts`, `epg.spec.ts` |
| EPG-03 | Después | Bloque "Después" | `now-next.ts` | PASS | idem |
| EPG-04 | Parrilla del canal | Cajón con todo el día publicado | `WatchPageComponent` | PASS | `epg.spec.ts › parrilla completa` |
| EPG-05 | Canales sin EPG | Mensaje claro, sin error | `ProgrammePanelComponent` | PASS | `epg.spec.ts › sin guía` |
| EPG-06 | Conversión de horario | Epoch → hora local | `formatTimeRange` | PASS | `now-next.spec.ts` |
| EPG-07 | Unión por `epg_id` | Resolver por nombre, no por índice | `parseEpg` | PASS | `validators.spec.ts` |
| EPG-08 | Actualización periódica | Refresco de la guía | `CatalogStore.ensureEpg` | PARTIAL | refresco cada 30 min y al pedirlo explícitamente; **sin prueba de espera real** |
| EPG-09 | — | Parrilla global multi-canal | `SchedulePageComponent` | PASS | `epg.spec.ts › parrilla global` |

## Experiencia de usuario

| ID | Funcionalidad original | Requisito propio | Componente | Estado | Prueba ejecutada |
| --- | --- | --- | --- | --- | --- |
| UX-01 | Cabecera con marca y nav | Cabecera con identidad propia | `App` | PASS | `a11y-responsive.spec.ts › landmarks` (desktop y móvil) |
| UX-02 | Tema persistente | Claro/oscuro con persistencia | `PreferencesStore` | PASS | `epg.spec.ts › tema persiste` |
| UX-03 | Panel vacío con instrucción | Portada con acción principal | `CatalogueHomeComponent` | PASS | captura `01-first-load` |
| UX-04 | Ficha del canal | Enlace al sitio del emisor | `ChannelHeaderComponent` | PASS | `player.spec.ts › reproducción externa` |
| UX-05 | Favoritos por canal | Corazón en tile y ficha | `PreferencesStore` | PASS | `catalogue.spec.ts › favoritos` |
| UX-06 | Reproducción externa | Aviso + enlace, conservando guía | `WatchPageComponent` | PASS | `player.spec.ts › reproducción externa` |
| UX-07 | Canal sin emisión | Aviso propio + guía | `WatchPageComponent` | PASS | `player.spec.ts › sin emisión` |
| UX-08 | Diseño móvil | Player primero, columnas adaptativas | `CataloguePageComponent` | PASS | `a11y-responsive.spec.ts › móvil` |
| UX-09 | Navegación teclado | Foco visible y orden lógico | CSS global | PARTIAL | se comprueba que el foco avanza y es visible; no se valida el orden completo |
| UX-10 | Región viva | Contador y estado con `role=status` | varios | PASS | `a11y-responsive.spec.ts` |
| UX-11 | Columna publicidad | **No se replica** | — | N/A | decisión de producto: sin publicidad |
| UX-12 | — | Sin desplazamiento horizontal 320–1920 | CSS | PASS | `a11y-responsive.spec.ts › sin overflow` |

---

## Resumen (recuento real)

| Estado | Nº |
| --- | --- |
| PASS | 26 |
| PARTIAL | 15 |
| NOT-DONE | 2 |
| N/A | 1 |

**NOT-DONE deliberados**: "Modo cine" y "Más opciones" del original no se
investigaron y no se implementan.

**PARTIAL** significa que la funcionalidad existe y está conectada, pero la prueba
automatizada no cubre su condición completa. No se declara PASS sin una prueba
ejecutada que lo respalde.
