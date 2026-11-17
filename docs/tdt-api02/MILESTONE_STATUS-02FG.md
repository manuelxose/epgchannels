# MILESTONE_STATUS-02FG — Integración final: EPG global, API, administración, rendimiento y cierre de release

Estado: **PASS / MERGED** (función completada, puertas obligatorias en verde y PR fusionado; los
elementos no críticos están en §9 como trabajo futuro).

Fecha: 2026-11-17. Milestone único que combina 02F y 02G.

---

## 1. Identidad Git (verificada, no afirmada)

| Dato | Valor |
|---|---|
| Remoto | `https://github.com/manuelxose/epgchannels.git` |
| Baseline (`origin/main` al empezar) | `a2a2ed3010af0127ef11e4f0eb27396d9d38d5e2` |
| Rama del milestone | `feat/tdt-api02-fg-final-integration` |
| Base integrada (incluye 02E) | `0e8571d` (merge de `feat/tdt-api02-e-player` `a738e7f`) |
| Contratos compartidos | `0d3a7bd` |
| PR | **#7** `https://github.com/manuelxose/epgchannels/pull/7` — **MERGED** |
| Merge | `da068975ea70dd8c3365ff670dc1df1266e096a3` |
| `origin/main` final | `da068975ea70dd8c3365ff670dc1df1266e096a3` (idéntico) |
| CI/CD | **No existe** (`.github/` ausente, sin configuración de despliegue) → el merge **no** dispara despliegue |

`main` local se dejó en `da06897` con `git merge --ff-only origin/main`. Los nueve commits clave
(`a738e7f`, `0d3a7bd`, `198ec27`, `e845ec3`, `6955441`, `74e6ae8`, `cba7134`, `406d3da`, `da06897`)
son ancestros de `main` — comprobado con `git merge-base --is-ancestor` y con `git cat-file` sobre los
ficheros entregables (no basta con leer un log).

## 2. Continuidad 02A–02E

Verificado antes de crear la rama: `git rev-parse main == origin/main`, árbol limpio, PR #1–#6
fusionados. 02E **no** estaba en `main` (la rama `feat/tdt-api02-e-player` no se había fusionado), así
que se integró como base de este milestone en lugar de dejarla huérfana.

## 3. Delegación real y aislamiento

Cinco worktrees registrados con `parallel-dev.mjs create` (nunca `git worktree add` a mano), base común
`0d3a7bd`, propietario y tarea declarados, un escritor por worktree:

| Worktree | Rama | Especialista | Commit |
|---|---|---|---|
| `wt/02fg-epg` | `feat/02fg-epg` | EPG internacional | `198ec27` |
| `wt/02fg-api` | `feat/02fg-api` | API pública internacional | `e845ec3` |
| `wt/02fg-admin` | `feat/02fg-admin` | Administración backend | `6955441` (+ `da05492` con la base EPG) |
| `wt/02fg-ui` | `feat/02fg-ui` | UI de administración | `74e6ae8` |
| `wt/02fg-integration` | `feat/02fg-integration` | Integración y rendimiento | `cba7134` |

**Incidente de coordinación declarado (ronda 1).** La ronda inicial de AgentTeams repartió las tareas
desviadas: el planificador entregó a cada miembro la tarea de otro (desplazamiento de una posición, y
el capitán quedó sin la suya). Antes de escribir nada, cada miembro lo detectó y paró; se comprobó que
**ningún worktree tenía commits ni escrituras** de esa ronda, se archivó el equipo y se recreó el DAG
en una ronda 2 con propiedad explícita y una instrucción por miembro ("si la tarea no menciona *tu*
worktree, no la reclames"). De ahí en adelante no hubo más escrituras cruzadas.

## 4. Gate consolidado (un solo pase, exit codes reales)

`evidence/02fg/gate.json`, commit `406d3da`, generado por `scripts/validate-02fg.mjs`:

| Etapa | Exit | Resultado |
|---|---|---|
| build | 0 | OK |
| typecheck | 0 | OK |
| unit | 0 | **625** tests (base 572) |
| integration | 0 | **254** tests (base 181) |
| ingestion | 0 | **9/9** |
| independence | 0 | **15** |
| client | 0 | **24** (base 14) |
| frontend-build | 0 | bundle generado |
| frontend-unit | 0 | **379** (base 353) |
| openapi | 0 | 46 rutas / 43 esquemas |
| migrations | 0 | 001–009 aplicadas, `pendingAfter: []` |

Navegador (`evidence/02fg/browser.json`, `scripts/validate-02fg-browser.mjs`): **36/36** checks,
incluida **progresión real de media** (+2.53 s, `readyState 4`, `MediaError null`) y un ciclo
**pausa → estado leído → reanudación** del trabajo `epg-refresh`.

Playwright contra la API real: `real-backend`, `player`, `catalogue`, `epg` → **32 passed**;
`a11y-responsive` + `player-keyboard-mobile` → **20 passed**.

## 5. Defectos encontrados EJECUTANDO y corregidos

| # | Defecto | Cómo apareció | Corrección |
|---|---|---|---|
| 1 | `/epg/channels` tardaba **140 460 ms** (tabla completa sin cota) | medida del capitán | respuesta acotada por país/estado + `limit`; **120 ms** |
| 2 | `legacyAliasMappedCount` traía todos los canales a Node | lectura de código tras medir | una agregación; sin transferencia |
| 3 | La UI admin leía `data` de un payload ya desenvuelto (`normalisePayload`) y `/admin/epg/coverage` un nivel por encima | 3 pruebas en rojo en la integración | `json-shape.ts` sólo desenvuelve si `data` es todo el payload; cobertura leída de `data` |
| 4 | El test de contratos OpenAPI trataba las rutas nuevas `/admin/*` como públicas | gate consolidado | exclusión estructural `path.startsWith('/admin/')` |
| 5 | 18 operaciones de administración sin documentar en OpenAPI | revisión de la especificación | documentadas desde los contratos; 25 → 46 rutas |

## 6. Contribuciones integradas y reparadas por el capitán

- **t5 EPG** integró limpio (598 unit + 197 integration tras la fusión).
- **t7A** dejó tres escrituras de mapeo EPG en `503` declarando que el módulo EPG debía exponerlas. Se
  integró `feat/02fg-epg` en su rama y **el capitán cableó el puerto**: `EpgMappingService` en el
  contexto + `confirmMapping`/`rejectMapping`/`proposeMapping` en `routes.ts`. La prueba que afirmaba
  el `503` se **sustituyó** por una que prueba la escritura real y la auditoría (`epg.mapping.create`,
  `.reject`, `.confirm` con actor de usuario).
- **t7B** entregó con 3 pruebas en rojo y las atribuyó a una limitación del runner. **No lo era**: el
  defecto era de lectura del payload. Corregido y verificado (379/379).
- **t8** entregó medidas reales; su hallazgo `country=INT`/`language=multi` (400) lo corrigió t6, y el
  `programmes` caducado de la base viva se documenta en §8 (no se inventa programación).

## 7. Rendimiento medido (resumen; detalle en `02fg/PERF.md`)

| Medida | Antes | Después |
|---|---|---|
| Peticiones del frontend al cargar `/television` | 27 (21 de guía) | **6** (−78 %), guía 0 |
| Ficha de canal | 31 (25 de guía) | **11** (1 de guía) |
| `/epg/channels` | 140 460 ms | **120 ms** |
| Consultas MongoDB | sin `COLLSCAN` | sin `COLLSCAN` (los delta de 3–10 ms son ruido del host y **no** se reclaman) |

## 8. Limitaciones y límites de la evidencia

- **`programmes` caducado** en la base viva (máximo `start` 2026-11-16T22:20Z): now/next y parrilla
  responden vacío de forma honesta; no se fabrica programación.
- **Ninguna autorización es derecho de difusión**: las 81 autorizaciones son del propietario para
  *verificar* (`reviewStatus: pending-review`).
- **La comprobación de administración se ejecutó sobre una copia desechable** (`tdt_02fg_admin_copy`)
  porque la base operativa ya tenía un administrador previo cuya contraseña no se conoce; en ella se
  hizo bootstrap con un token canario. La base operativa **no** se modificó más allá de las pruebas de
  API de solo lectura.
- **Firefox/WebKit no medidos** (binarios ausentes); Chromium sí.
- Navegadores, Gate engine-04 y el runner ACL no se usaron: el gate se ejecutó directamente con exit
  codes registrados (`§4`), como exige la experiencia de 02D (`CreateProcessAsUserW Win32 2`).

## 9. Trabajo futuro (no bloqueante, deliberadamente fuera de este milestone)

1. Contrato: `adminIdentityInputSchema` acepta una edición sin cambios de identidad (se auditoría y
   devuelve 200) — endurecer si el producto quiere 409.
2. `epg_sync_runs` existe en el modelo, pero `/admin/epg/ingestion-runs` sigue leyendo `job_runs`
   (prefijo `epg:`); re-apuntar es un cambio pequeño y sin riesgo.
3. Refresco periódico de la guía en producción (la ingesta existe y es manual/programable).
4. Contraste WCAG y revisión visual fina de la consola de administración.
5. Certificación con engine-04 cuando su runner pueda lanzar `npm` en este host.

## 10. Cierre

- PR #7 fusionado y SHA verificado en `origin/main`.
- Worktrees del milestone eliminados (los directorios de 02E se conservan: son de un milestone
  anterior, no de éste) y las cinco ramas borradas tras comprobar que `main` es superconjunto de cada
  una (ningún fichero de rama ausente en `main`).
- Sin despliegue a producción no autorizado: no existe automatismo que lo dispare.
