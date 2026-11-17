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

## 6-bis. Prerrequisito de arranque de worktrees (encontrado ejecutando, no leyendo)

Un worktree recién creado **no puede compilar `apps/frontend` tal cual**. Reproducido por el capitán
en `wt/02e-player`:

```
npm --prefix apps/frontend run build
  → exit 1, X [ERROR] TS2307: Cannot find module '@tdt/contracts'
```

**Causa medida:** `packages/contracts` y `packages/api-client` resuelven por
`types: ./dist/index.d.ts`; ningún worktree hereda `dist/` porque está en `.gitignore`. Además ambas
están **hoisteadas** en el `node_modules/@tdt` de la **raíz** (junctions a `packages/*`), y
`apps/frontend/node_modules/@tdt` sólo contiene la junction de `api-client`. Por eso el frontend
resuelve a través del hoist de la raíz y no desde su propio directorio.

**Secuencia correcta, con exit codes reales:**

| Comando | Exit |
|---|---|
| `npm install` (en el worktree) | 0 |
| `npm run build -w @tdt/contracts -w @tdt/api-client` | **0** |
| `npm --prefix apps/frontend run build` | **0** («Application bundle generation complete») |

**Precisión importante:** construir **sólo** `@tdt/contracts` **no basta** — medido: tras eso el build
seguía en exit 1 con otro error (desajuste de tipos de parámetro en `channels-api.service.ts`). Hay que
construir **los dos** paquetes.

Es un hecho de **entorno/arranque**, no un defecto del código, y afecta también a t4.

## 7. Estado del plan

Cinco tareas, aprobadas por el usuario. t1/t2/t3 en paralelo; t4 depende de t2+t3; t5 (revisión
independiente) depende de t4 y la ejecuta un miembro que no implementó ningún artefacto.

Un modelo no certifica su propia implementación. El veredicto final de este documento lo fija la
revisión independiente más el gate re-ejecutado por el capitán sobre el SHA congelado.

---

## 8. Contribuciones integradas

| Tarea | Autor | Worktree / rama | Commits |
|---|---|---|---|
| t1 REA | `rea-playback-investigator` | `wt/02e-rea` / `feat/02e-rea` | `1f56265` |
| t3 UI | `player-frontend-engineer` | `wt/02e-player` / `feat/02e-player` | `af1acf0` |
| t2 fuentes | `media-streaming-engineer` | `wt/02e-sources` / `feat/02e-sources` | `f2e5c49` |

Cada rama se selló a mano por el capitán revisando el diff real, excluyendo lo que no correspondía:

- Se **excluyó** `evidence/02e/_scaffold/` (~12,4 MB de fixtures copiados + `hls.min.js`): es un
  arnés de trabajo, no un artefacto entregable.
- Se **excluyó** el ruido de `package-lock.json` que produce `npm install` (borraba la línea
  `license`), restaurado al valor del checkout principal.
- Se **excluyó** `tmp-probe.mjs` (scratch del autor, que además lo borró él mismo).

## 9. Defectos reales encontrados EJECUTANDO (no leyendo)

La lección de 02D se cumplió otra vez: **cuatro defectos** de t2/t3 solo aparecieron al ejecutar, y
solo **uno** de ellos lo detectó la suite unitaria del autor.

| # | Defecto | Cómo apareció | Estado |
|---|---|---|---|
| 1 | Aserción de depuración olvidada (`toBe('DEBUG')`) que enmascaraba el test real | el capitán ejecutó la suite | corregido |
| 2 | `statusWithoutInApp` devolvía `degraded` **antes** de comprobar `external`, rompiendo el fallback legal al reproductor del emisor | integración: 2 tests en rojo (179/181) | corregido |
| 3 | `isEligibleSource` respondía la pregunta de "candidato in-app" en vez de "expuesto", así que un `external` elegible nunca era elegible | integración, tras corregir (2) | corregido |
| 4 | El arnés de mutación D-023 no aplicaba anclas multilínea por **CRLF vs `\n`**, reportando `not-applied` y haciendo parecer obsoleta la mutación | el capitán re-ejecutó el arnés tras la fusión | corregido por el capitán (`7ec8783`) |

El defecto 4 merece énfasis: era una **avería del instrumento de medida**, no del código, y habría
hecho que la prueba D-023 pareciera pasar estando una de sus cinco mutaciones sin aplicar. Es la
misma clase de fallo que `VERIFICACION-FUENTES-02D.md` §«dos errores de instrumento» documenta.

## 10. Gate de 02E medido directamente sobre el árbol integrado

**No certificado por engine-04** (§6, limitación de `npm` bajo el runner ACL). Etapas ejecutadas
directamente por el capitán sobre la rama integrada, con exit codes reales:

| Etapa | Exit | Resultado |
|---|---|---|
| `build` | **0** | OK |
| `typecheck` | **0** | OK |
| `unit` | **0** | **572** tests (549 base + 23 nuevos) |
| `integration` | **0** | **181** tests (base restaurada) |
| `ingestion` | **0** | 9/9 |
| `independence` | **0** | 15 tests |
| `client` | **0** | 14 tests |
| frontend unit | **0** | **353** tests (318 base + 35 nuevos) |
| frontend build | **0** | bundle generado |
| mutación D-023 | **0** | **5/5 capturadas**, restauración byte a byte |

## 11. Selección de fuentes: lo que ahora es cierto y lo que no

Medido por la especificación de ruta real de t2 (sin seam inyectado) sobre
`evidence/verification-02d/catalogue-verification.json`:

- **63 seleccionables / 18 rechazadas**, con las causas medidas: `http-404` ×9,
  `missing-segments` ×1, `unsupported-format` ×8.
- `isSourceHealthy()` ya **no** trata `unknown` como sano — pero el cambio se hizo **separando ejes**,
  no endureciendo un booleano: ninguna fila de la plataforma lleva `ok`, así que el arreglo ingenuo
  habría dejado **cero** fuentes intentables. Esto se midió antes de aceptar el diseño
  (§6-bis de la revisión del capitán): 1364 filas, todas `unknown`.
- La **compatibilidad es `unknown` en todo el catálogo**: el motor de 02D nunca inyectó una sonda de
  reproducción en navegador, así que no hay veredicto de compatibilidad que consumir. La UI debe
  decir "sin verificar", no "compatible".
- **Nada de esto es una licencia de difusión.** Las autorizaciones son del propietario para
  **verificar** (§4-bis).
