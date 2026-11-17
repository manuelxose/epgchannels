# Base funcional del reproductor — material importado

Este directorio **no es un segundo producto**. Es el material documental y de evidencia del
**proyecto base** del reproductor (`tdt-player-rebuild`, 2026-11-13/14), importado aquí porque el
producto vivo es este repositorio y no debe existir otro árbol.

## Por qué está aquí

El proyecto nació como una reconstrucción del reproductor (13-11-2026) y se amplió a este monorepo
(desde 15-11-2026, commit *"frontend migration scaffold"*). La migración del código se completó:

| Medida | Resultado |
|---|---|
| Ficheros fuente idénticos entre ambos árboles | **66 de 74** |
| Difieren | 5 — y es **este repositorio el que va por delante** |
| Sólo existen en el árbol antiguo | 3 — **residuos** de la capa de catálogo de terceros, sustituida por `apps/frontend/src/app/core/api/` |

Los 5 que difieren confirman la dirección: `rebuild-config.ts` pasó de `catalogUrl`/`epgUrl`
(terceros + snapshots) a **`apiBaseUrl`** (solo nuestra API). Es decir, el árbol antiguo está **antes**
de la decisión que define el producto. Los 23 cambios sin confirmar que quedaban allí eran también
idénticos a este repositorio.

Lo único que faltaba aquí era la **documentación** y la **evidencia de reproducción**, y eso es lo que
se importa en este commit.

## Contenido

### `docs/player-rebuild/*.md` — 11 documentos del proyecto base

| Documento | Qué aporta |
|---|---|
| `PLAYBACK-PARITY.md` | Método y criterios de paridad de reproducción |
| `AUDIT-REPORT.md` | Auditoría funcional del catálogo completo |
| `LEGAL-AND-LIMITATIONS.md` | Límites legales y técnicos asumidos |
| `BEHAVIOR-SPEC.md` | Especificación de comportamiento esperado |
| `PLAYER-STATE-MACHINE.md` | Máquina de estados del reproductor |
| `DATA-CONTRACTS.md` | Contratos de datos con los upstream |
| `FUNCTIONAL-INVENTORY.md` | Inventario funcional de referencia |
| `INTEGRATIONS.md`, `INTEGRATION-PLAN-GUIATV.md` | Integraciones, incluido el plan de GuíaTV |
| `RECONSTRUCTION-MATRIX.md` | Matriz de reconstrucción frente a la referencia |
| `UI-DESIGN-SYSTEM.md` | Sistema de diseño de la interfaz |

### `docs/player-rebuild/playback/` — evidencia de reproducción medida

Auditoría sobre **768 canales**, con cobertura, fallos y verificación independiente
(`FULL-PLAYBACK-AUDIT.json`, `CHANNEL-COVERAGE.csv`, `PLAYBACK-FAILURES.md`,
`INDEPENDENT-VERIFICATION.json`, `PLAYBACK-PARITY-REPORT.md`, matrices y resumen).

Esta es la razón principal de importar en vez de borrar: **es evidencia de reproducción real sobre el
catálogo completo**, medida el 14-11-2026, y no se puede regenerar sin volver a medir 768 canales. Se
relaciona directamente con `docs/tdt-api02/VERIFICACION-FUENTES-02D.md` (02D), que demuestra el mismo
principio sobre el motor nuevo: *HTTP 200 no prueba vídeo reproducible*.

## Reglas

- **Los tokens en URLs fueron redactados** al importar (`<redacted-token>`, `<redacted-key>`), conforme a
  `DECISIONS.md` D-015. Los valores originales no se conservan aquí.
- Los datos son **observaciones con fecha** (14-11-2026), no una garantía de disponibilidad actual. Un
  canal que reproducía entonces puede haber caído después; eso no invalida la medición.
- El árbol antiguo **no** se importa como código: su código o es idéntico a éste, o está superado.

Fecha de importación: 2026-11-17.
