# FUNCTIONAL INVENTORY

Inventario funcional del reproductor TDTChannels tal y como se observó
(TDT-CLONE-01). Cada fila es **observada** salvo que se indique **propuesta**
(mejora no presente de forma verificable en el original).

Leyenda de estado de investigación: `OBS` observado con evidencia ·
`PART` parcialmente observado · `NO` no investigado.

## A. Catálogo

| ID | Funcionalidad | Estado | Evidencia | Notas de comportamiento |
| --- | --- | --- | --- | --- |
| CAT-01 | Catálogo completo cargado | OBS | `evidence/original/01-first-load/desktop-first-load.png` | Contador `Mostrando 1–21 de 768 canales` |
| CAT-02 | Categorías (ámbitos) | OBS | árbol de accesibilidad (`inspect_web_page` ev_1ef23004…) | 34 opciones: Generalistas, Informativos, Deportivos, Infantiles, Eventuales, Streaming + 19 comunidades + 7 internacionales + Deportivos Int., Musicales, Religiosos |
| CAT-03 | Orden del catálogo | OBS | `tv.json` | Orden del fichero: España por ámbitos, luego Internacional |
| CAT-04 | Buscador instantáneo | OBS | `evidence/original/04-search/desktop-search-cuatro.png` | Placeholder `Buscar canal...`, `aria-label="Buscar canal"`; al filtrar el contador pasa a `1 resultado` / `N resultados` |
| CAT-05 | Filtro por categoría | OBS | árbol de accesibilidad | `<select aria-label="Filtrar por categoría">` con opción inicial `Categoría` |
| CAT-06 | Filtro de favoritos | OBS | strings del shell (`Mostrar solo favoritos`) | Botón corazón con `aria-pressed`; deshabilitado si no hay favoritos |
| CAT-07 | Contador con plural | OBS | strings `${t} ${i} favoritos`, `${t} resultados` | Singular/plural correcto; incluye `favoritos` en el texto cuando se filtra |
| CAT-08 | Paginación | OBS | strings `Anterior`/`Siguiente`, `21*r+1` | **21 por página**; recorte al cambiar filtros |
| CAT-09 | Logotipos | OBS | red observada | Imágenes remotas del catálogo; tile con `aria-label="Logo de <nombre> <nombre>"` |
| CAT-10 | Enlace profundo por canal | OBS | DOM | Cada tile es `<a href="/television/<slug>">` (slug derivado del nombre) |
| CAT-11 | Estado vacío de búsqueda | OBS | strings `Ningún favorito coincide con estos filtros.` | Texto + acción `Limpiar filtros` |
| CAT-12 | Estado vacío de favoritos | OBS | strings `Todavía no tienes canales favoritos. Abre un canal…` | Se muestra cuando el filtro de favoritos no tiene resultados |
| CAT-13 | Paleta de categorías en selector | OBS | `tv.json` `countries[].ambits[]` | La UI muestra nombres como `C. de Madrid`, `Int. Europa` = valores del JSON |
| CAT-14 | Últimos canales usados | NO | — | No observado en el original. **Propuesta** propia (no se atribuye al original) |

## B. Reproductor

| ID | Funcionalidad | Estado | Evidencia | Notas |
| --- | --- | --- | --- | --- |
| PLY-01 | Selección de canal | OBS | `evidence/original/06-playback/desktop-la1-playing.png` | Navegación a la ruta del canal; la emisión arranca sola y queda en pausa/pausable |
| PLY-02 | Play / Pausa | OBS | botón `Reproducir` | Botón toggle en la barra de controles |
| PLY-03 | Volumen y silencio | OBS | botones `Silenciar`, slider | Control de volumen con botón de mute |
| PLY-04 | Tiempo y directo | OBS | `1:59:45 / 2:00:15`, botón `Directo` | El DVR de RTVE informa de una ventana temporal; hay acción `Directo` |
| PLY-05 | Calidad | OBS | botón `Calidad`, texto `720p` | Selector de niveles HLS |
| PLY-06 | Audio | OBS | botón `Audio` | Selector de pista de audio |
| PLY-07 | Subtítulos | OBS | botón `Subtítulos` (`CC`) | El botón existe; no se confirmaron pistas CC activas |
| PLY-08 | Picture in Picture | OBS | botón `Picture in Picture` | — |
| PLY-09 | Pantalla completa | OBS | botón `Pantalla completa` | — |
| PLY-10 | Modo cine | PART | botón `Modo cine` | El botón existe; no se inspeccionó su efecto exacto |
| PLY-11 | Más opciones | PART | botón `Más opciones` | Existe; no se inspeccionó el menú |
| PLY-12 | Cambio de fuente/emisión | OBS | selector `Emisión 1`, `Emisión 2` | Una entrada por opción reproducible del canal |
| PLY-13 | Overlay "estás viendo" | OBS | `ESTAS VIENDO`, género, `10:35 - 14:55`, título, barra | Metadatos del programa en directo sobre el vídeo |
| PLY-14 | Autoplay | OBS | `readyState=4`, `paused=true` tras navegación | El original deja el vídeo cargado en pausa |
| PLY-15 | Motor HLS | OBS | `tools/player-probe.mjs` | Chrome no tiene HLS nativo; recibe un `blob:` => usa MSE/hls.js |
| PLY-16 | Recuperación de errores | NO | — | No se provocó una caída controlada en el original |
| PLY-17 | Limpieza de recursos | NO | — | No observable desde fuera |

## C. Programación (EPG)

| ID | Funcionalidad | Estado | Evidencia | Notas |
| --- | --- | --- | --- | --- |
| EPG-01 | Programa actual | OBS | `EN DIRECTO` + `Mañaneros 360` | Título, género, `10:35 - 14:55`, descripción, carátula |
| EPG-02 | Siguiente | OBS | `SIGUIENTE` | `Telediario 1 14:55 - 15:30` |
| EPG-03 | Después | OBS | `DESPUÉS` | `Deportes 1 15:30 - 15:35` |
| EPG-04 | Parrilla completa | OBS | botón `Toda la programación` | Abre la parrilla del canal |
| EPG-05 | Canales sin EPG | OBS | canal sin `epg_id` | No se muestra bloque de programación |
| EPG-06 | Conversión de horario | OBS | `hi`/`hf` epoch UTC | El original muestra hora local (Europe/Madrid) |
| EPG-07 | Fuente EPG | OBS | `https://www.tdtchannels.com/epg/TV.json` | JSON indexado; unión por `name === epg_id` |
| EPG-08 | Actualización periódica | NO | — | No observable |

## D. Experiencia de usuario

| ID | Funcionalidad | Estado | Evidencia | Notas |
| --- | --- | --- | --- | --- |
| UX-01 | Cabecera con marca, nav y tema | OBS | capturas | `Televisión` / `Radio`, aviso legal, `Modo oscuro` |
| UX-02 | Tema persistente | OBS | `localStorage["tdtchannels-theme"]` | — |
| UX-03 | Panel vacío con instrucción | OBS | `Selecciona un canal…` | — |
| UX-04 | Ficha del canal | OBS | `Sitio oficial`, `Ficha del canal` | Enlaces externos al emisor |
| UX-05 | Favoritos por canal | OBS | corazón, `Añadir La 1 a favoritos` | — |
| UX-06 | Estado reproducción externa | OBS | `evidence/original/08-no-stream/desktop-cuatro-route.png` | `REPRODUCCIÓN EXTERNA` + `Disponible en el reproductor oficial de <canal>` |
| UX-07 | Estado sin emisión | OBS | `CANAL SIN EMISION` + `Este canal no emite por internet` | Mantiene parrilla |
| UX-08 | Diseño móvil | OBS | `evidence/original/09-mobile/mobile-la1-route.png` | Cabecera compacta con menú; el catálogo aparece antes que el player en el DOM |
| UX-09 | Navegación por teclado | PART | árbol a11y | Controles con `aria-label`; no se verificó orden de tabulación completo |
| UX-10 | Región viva de estado | OBS | `role=status` en el contador | Mensaje accesible `aria-live` |
| UX-11 | Columna publicitaria | OBS | `Publicidad` | No se replica (sin publicidad en nuestra app) |
