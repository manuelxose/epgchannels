# MILESTONE_STATUS-02E — Reproductor de TV en directo independiente y compatibilidad de navegador

Estado: **EN CURSO** (se cerrará con el SHA congelado, el gate medido y el veredicto independiente).

Fecha: 2026-11-17 · Rama `feat/tdt-api02-e-player` · Base verificada `a2a2ed3` (`origin/main`).

---

## 1. Identidad Git

| Dato | Valor |
|---|---|
| Remoto | `https://github.com/manuelxose/epgchannels.git` |
| SHA base | `a2a2ed3010af0127ef11e4f0eb27396d9d38d5e2` |
| Rama | `feat/tdt-api02-e-player` |
| CI/CD | **No** (sin `.github/`) → el merge no dispara despliegue |

## 2. Continuidad: 02A–02D integrados — verificado

Antes de crear la rama se comprobó que **todos** los hitos previos están en `main`:

| PR | Rama | Estado |
|---|---|---|
| #1 | `feat/tdt-api02-a-audit` | merged |
| #2 | `feat/tdt-api02-b-global-catalogue` | merged |
| #3 | `docs/tdt02b-closeout` | merged |
| #4 | `fix/demo-mode-licences` | merged |
| #5 | `feat/tdt-api02-c-providers` | merged |
| #6 | `feat/tdt-api02-d-stream-health` | merged (`19d9c67`) |

`git rev-parse main == origin/main`, árbol limpio, `git merge --ff-only origin/main` → «Already
up to date».

## 3. Corrupción del traspaso corregida antes de planificar

`NEXT_HANDOFF.md` §3.1 afirmaba: **«el motor no ha verificado ni una sola fuente del catálogo;
0 autorizaciones»**. **Eso ya no es cierto.** El commit `a2a2ed3` —el mismo del que parte esta
rama— registró autorizaciones y midió el catálogo:

| Dato medido (base viva `tdt_platform` + evidencia comprometida) | Valor |
|---|---|
| Fuentes HLS publicadas | **81** |
| Con autorización resuelta | **81** |
| Sanas a profundidad `segments` | **63** |
| Fallando | **18** (`http-404` ×9, `missing-segments` ×1 en `ztnr.rtve.es`; `unsupported-format` ×8 en `laxarxames.cat`) |

**Qué son esas autorizaciones, dicho con precisión:** autorizaciones del **propietario del
producto para verificar** (`basis: written-licence`, `clauseUrl` = nuestro `DECISIONS.md`,
`reviewStatus: pending-review`). Su propia cláusula citada dice que **no** son prueba de que el
emisor haya concedido derechos de redistribución. En 02E no se presentan como derechos de
difusión.

**Consecuencia para el alcance:** la verificación de reproducción de 02E puede hacerse contra el
**catálogo real**, no sólo contra distribuciones públicas de prueba.

## 4. Baseline medido sobre `a2a2ed3` ANTES de tocar nada

Todo en verde, exit codes reales:

| Etapa | Exit | Resultado |
|---|---|---|
| `build` | 0 | OK |
| `typecheck` | 0 | OK |
| `unit` | 0 | 549 tests |
| `integration` | 0 | 181 tests |
| `ingestion` | 0 | 9/9 |
| `independence` | 0 | 15 tests |
| `client` | 0 | 14 tests |
| frontend unit | 0 | 318 tests |

## 5. Aislamiento de escritores — verificado

Tres worktrees registrados con `parallel-dev.mjs create` (nunca `git worktree add` a mano), todos
en `a2a2ed3`, ramas distintas, propietario y tarea declarados:

| Worktree | Rama | Propietario | Tarea |
|---|---|---|---|
| `wt/02e-rea` | `feat/02e-rea` | `rea-playback-investigator` | t1 |
| `wt/02e-sources` | `feat/02e-sources` | `media-streaming-engineer` | t2 |
| `wt/02e-player` | `feat/02e-player` | `player-frontend-engineer` | t3 |

`git worktree list` muestra cuatro checkouts distintos; un escritor por worktree.

**Limitación declarada:** en este despliegue **no hay `toolPolicies` configuradas**, así que la
política `confined` de `ENGINE-03 §7.2` **no está disponible**. La separación es por worktree más
la puerta de globs del capitán en el sellado, **no** por un sandbox de sistema operativo. No se
presenta como encarcelamiento verificable.

## 6. Compatibilidad de navegador — medido, no supuesto

| Motor | Binario | Estado |
|---|---|---|
| Chromium 1254 | presente | **medible** |
| Firefox 1572 | ausente | **no medido** |
| WebKit 2388 | ausente | **no medido** |

Cualquier afirmación de «navegadores soportados» en 02E debe decir: **Chromium medido;
Firefox/WebKit no medidos en este entorno**. Instalarlos no está autorizado por este hito.

## 7. Estado del plan

Cinco tareas, aprobadas por el usuario. t1/t2/t3 en paralelo; t4 depende de t2+t3; t5 (revisión
independiente) depende de t4 y la ejecuta un miembro que no implementó ningún artefacto.

Un modelo no certifica su propia implementación. El veredicto final de este documento lo fija la
revisión independiente más el gate re-ejecutado por el capitán sobre el SHA congelado.
