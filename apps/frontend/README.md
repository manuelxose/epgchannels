# TDT Player — reproductor de televisión en directo

Aplicación web original para explorar un catálogo de canales en abierto, ver la
programación en emisión y reproducir la señal **dentro de la propia aplicación**
con un reproductor HLS propio.

Reconstrucción funcional independiente: el código es nuestro. Se ha investigado
el comportamiento público de referencia, pero no se ha reutilizado su código,
sus recursos ni su identidad visual.

---

## Qué hace

- **Catálogo** con búsqueda instantánea (sin acentos ni mayúsculas), filtros por
  categoría y por estado de disponibilidad, favoritos persistentes, recientes y
  paginación de 21 en 21.
- **Reproductor propio** (hls.js cargado de forma perezosa) con play/pausa,
  volumen, silencio, calidad, audio, Picture-in-Picture, pantalla completa,
  cambio de fuente, marcador de directo, estados de carga y búfer, y
  recuperación acotada ante errores.
- **Programación (EPG)**: programa en curso con barra de progreso, siguiente,
  después y parrilla completa por canal. Además, una parrilla global.
- **Estados de canal honestos**: reproducible, reproducción externa, sin emisión
  por internet, no disponible. La guía se muestra incluso cuando el canal no se
  puede reproducir aquí.
- **Responsive y accesible**: diseño móvil y escritorio, navegación por teclado,
  regiones vivas, foco visible.

## Requisitos

- Node.js **24** (probado con 24.18.0)
- npm 11+
- *(opcional)* ffmpeg, solo para regenerar los medios de demostración

## Puesta en marcha

```bash
cd tdt-player-rebuild
npm install
npm start
```

Abre `http://localhost:4200`.

La aplicación usa por defecto el catálogo y la EPG públicos. **Si no están
disponibles** (sin red, bloqueo o cambio de esquema), cae automáticamente al
catálogo y la guía de demostración que se incluyen en la propia aplicación, y lo
indica en pantalla. Nunca se queda vacía.

## Comandos

| Comando | Qué hace |
| --- | --- |
| `npm start` | Servidor de desarrollo |
| `npm run build` | Compilación de producción (`dist/`) |
| `npm test` | Pruebas unitarias y de integración (Vitest) |
| `npm run test:e2e` | Pruebas end-to-end (Playwright, escritorio y móvil) |
| `npm run serve:dist` | Sirve la compilación de producción en el puerto 4400 |
| `npm run demo:media` | Regenera los medios HLS de demostración con ffmpeg |
| `npm run demo:fixtures` | Regenera el catálogo y la EPG de demostración |
| `npm run playback:probe -- --channel "La 1"` | Reproduce **un** canal real en Chromium y mide decodificación, audio y avance del tiempo de medio |
| `npm run playback:audit` | Auditoría secuencial del catálogo completo → `artifacts/playback/` |
| `npm run playback:verify` | Verificación independiente de una muestra contra el catálogo **en vivo** |

### Primera ejecución de las pruebas E2E

```bash
npx playwright install chromium
npm run test:e2e
```

Las pruebas E2E se ejecutan contra la **compilación de producción** servida
estáticamente, no contra el servidor de desarrollo.

## Estructura

```
src/app/
├── core/                    # Dominio y lógica sin interfaz
│   ├── config/              # Configuración inyectable (URLs, tiempos)
│   ├── models/              # Tipos del dominio (Channel, MediaSource, EpgProgram…)
│   ├── data/                # Validación de datos de entrada (no se confía en la red)
│   ├── ports/               # Adaptadores remotos de catálogo y EPG, con fallback
│   ├── player/              # Motor de reproducción y máquina de estados
│   ├── epg/                 # Resolución de programa actual/siguiente
│   ├── state/               # Stores con signals (catálogo, preferencias, consulta)
│   └── text/                # Normalización para búsqueda e identificadores
├── features/
│   ├── catalogue/           # Barra lateral del catálogo y portada
│   ├── watch/               # Ficha de canal, cabecera, reproductor y panel EPG
│   └── schedule/            # Parrilla global
├── shared/ui/               # Componentes reutilizables (iconos, estados vacíos)
└── styles/                  # Tokens de diseño
```

## Arquitectura en breve

- **Puertos y adaptadores**: el catálogo y la EPG se obtienen a través de
  interfaces (`ChannelCatalogAdapter`, `EpgProviderAdapter`). Cambiar de fuente
  no toca la interfaz.
- **Motor de reproducción desacoplado**: la interfaz habla con `PlayerEngine`,
  nunca con hls.js. Esto permite sustituir el motor y probarlo aisladamente.
- **Máquina de estados explícita**: `PlayerStatus` con transiciones declaradas y
  testadas; la interfaz solo renderiza estados.
- **Signals**: todo el estado es reactivo; no depende de Zone.js.
- **Datos no confiables**: toda respuesta de red se valida y se contabiliza lo
  descartado en lugar de romper la aplicación.

## Datos de demostración y licencias

- `public/demo/catalog.demo.json` y `public/demo/epg.demo.json` son **sintéticos**
  y siguen el mismo esquema que los datos públicos reales.
- `public/demo/media/` contiene vídeo generado con ffmpeg (`testsrc2` + `sine`):
  sin contenido de terceros.
- Los logotipos y las señales mostrados con el catálogo real pertenecen a sus
  emisores. Consulta `docs/LEGAL-AND-LIMITATIONS.md` antes de cualquier uso más
  allá del desarrollo local.

## Documentación

| Documento | Contenido |
| --- | --- |
| `docs/research/RECON-TDT-CLONE-01.md` | Investigación del original y evidencias |
| `docs/FUNCTIONAL-INVENTORY.md` | Inventario funcional observado |
| `docs/BEHAVIOR-SPEC.md` | Comportamiento que debe cumplir esta aplicación |
| `docs/PLAYER-STATE-MACHINE.md` | Estados y transiciones del reproductor |
| `docs/DATA-CONTRACTS.md` | Contratos de datos y validación |
| `docs/UI-DESIGN-SYSTEM.md` | Sistema de diseño propio |
| `docs/RECONSTRUCTION-MATRIX.md` | Funcionalidad ↔ implementación ↔ prueba |
| `docs/AUDIT-REPORT.md` | Auditoría independiente |
| `docs/LEGAL-AND-LIMITATIONS.md` | Derechos, limitaciones y pendientes |
| `docs/INTEGRATION-PLAN-GUIATV.md` | Plan de integración futura (documental) |

## Estado

**PRODUCTO FUNCIONAL** con limitaciones documentadas. La cobertura de datos y la
cobertura de reproducción son dimensiones distintas y se informan por separado
en `docs/LEGAL-AND-LIMITATIONS.md`. Los resultados reales de las pruebas están
registrados en `docs/AUDIT-REPORT.md`.
