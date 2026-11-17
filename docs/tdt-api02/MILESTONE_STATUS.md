# MILESTONE_STATUS — TDT-API-02

> Este documento describe el milestone **activo: 02C**. El estado de cierre de 02B y 02A se conserva
> íntegro en la sección histórica al final del fichero.

---

# TDT-API-02C — Proveedores oficiales, investigación REA y elegibilidad de reproducción

**Estado global: PASS con limitación declarada** (ver `AUDITORIA-ACEPTACION-02C.md` §6).

Última actualización: 2026-11-17 (cierre de 02C).

## Identidad y Git

| Dato | Valor |
|---|---|
| Repositorio | `tdt-api01` (`origin` = `github.com/manuelxose/epgchannels.git`) |
| SHA base verificado | `bb54ac910d9e105adcd1ad9f30dbc534ecf1b4e0` (`main` == `origin/main`, 02B fusionado) |
| Rama del milestone | `feat/tdt-api02-c-providers` |
| HEAD entregado | `80fb91575168f0bf6968d74d9aebe2e5825b0d59` |
| CI/CD existente | **No** (sin `.github/`) → el merge no dispara ningún despliegue |

## Alcance

Convertir el catálogo internacional descubierto en un **registro gobernado de fuentes de reproducción**:
registro de adaptadores de proveedor extensible, autorización persistida **aparte** de la disponibilidad,
gate de elegibilidad que falla cerrado, clasificación en cinco clases exactas, evidencia documentada por
integración aceptada y pruebas positivas **y** negativas que demuestren que un stream técnicamente sano
no puede saltarse el gate.

## Verificación final (ejecutada de verdad)

| Etapa | Exit | Resultado |
|---|---|---|
| `build` | 0 | OK |
| `typecheck` | 0 | OK |
| `unit` | 0 | **290 tests** |
| `integration` | 0 | **128 tests** |
| `ingestion` | 0 | **9/9** escenarios |
| `independence` | 0 | **15 tests** |
| `client` | 0 | **14 tests** |

## Resultado de la investigación (lo más importante)

**Ningún operador español ni plataforma FAST publica una política que autorice a un agregador tercero a
reproducir sus canales en directo.** Cero candidatos alcanzan `permitted-direct-playback` o
`permitted-official-embed` con evidencia publicada.

- **5 operadores `restricted`** con cláusula literal citada: Atresmedia (prohíbe además *framing*),
  Canal Sur/RTVA, EITB, 3Cat/CCMA (carve-out de blogs estrecho, no extensible a una parrilla), À Punt y
  Pluto TV.
- **6 `unresolved`**: RTVE (aviso legal silencioso sobre embedding), Mediaset y CRTVG (**no
  verificados**, no se clasifican), Rakuten, Samsung TV Plus, Yowi.
- **`jmp2.uk` (28 % de las entradas españolas) es un acortador**, no un emisor; `cdn.jsdelivr.net` es una
  CDN estática. Ninguno puede producir veredicto permisivo.

Esto **no es un fallo**: es la evidencia. La consecuencia correcta es que el registro sirva
`unresolved`/`restricted` y bloquee. Inventar autorización para «tener algo verde» sería exactamente el
defecto que el milestone existe para prevenir.

## Los 5 defectos reales de la ronda (todos reparados)

Ninguno se encontró leyendo código. El detalle está en `AUDITORIA-ACEPTACION-02C.md` §3.

| # | Cal. | Defecto | Encontrado por |
|---|---|---|---|
| 1 | blocker | Clave de Firebase de un tercero en un commit de evidencia | revisión independiente (t5) |
| 2 | high | El fallback por operador nunca casaba (consultaba `sourceUrl`, las filas guardan la cita) | sonda adversaria contra MongoDB real |
| 3 | medium | YouTube inalcanzable: el seed no tenía `hosts` | sonda adversaria |
| 4 | blocker | La ruta de escritura acuñaba un derecho permisivo **sin evidencia** | revisión independiente |
| 5 | **blocker** | **Un stream sano sin derecho, `restricted` o `unresolved` se servía como `available`** | **auditoría del capitán a nivel HTTP** |

**Lección 5 (para 02D):** `createSource` pasa por el servicio real, que auto-registra una decisión
permitida; la fixture no la eliminaba. **Toda prueba que pedía una postura negativa afirmaba lo contrario
de lo que decía, y pasaba.** Sólo el resultado HTTP real lo reveló.

## Limitaciones declaradas

1. **No hay veredicto independiente de aceptación para el árbol final.** La revisión independiente
   existe para el código (t5 `needs_revision` con 5 findings, todos reparados; t8 `PASS`) pero sobre
   árboles anteriores. La auditoría de aceptación del árbol entregado es del **capitán** y se declara
   como tal.
2. **REA observó reproducción sólo en 3Cat TV3.** Los demás cargaron sin petición de media en la
   ventana y constan `not_observed`, **no** «no se reproduce».
3. **LatAm, Europa e internacional no se investigaron.** Todo lo no español queda `unresolved`.
4. **Mediaset y CRTVG sin clasificar.**

## No-objetivos

- No investigar LatAm/Europa/internacional (queda a 02D).
- No cerrar SEC-01/SEC-02/R2 (siguen abiertos).
- No añadir CI/CD (R3).
- No exponer `identity` en la API pública.
- Ninguna fuente se proxifica, graba, transcodifica ni salta DRM, geobloqueo, autenticación o firma.

---

# Estado histórico — TDT-API-02B y 02A

# TDT-API-02B — Global Channel Catalogue & Independent Ingestion

**Estado global: PASS**

Última actualización: 2026-11-16 (cierre de 02B).

## Identidad y Git

| Dato | Valor |
|---|---|
| Repositorio | `tdt-api01` (`origin` = `github.com/manuelxose/epgchannels.git`) |
| SHA base verificado | `671a42fa226e0ea8995badfee3544b9de0655008` (`main` == `origin/main`, 02A fusionado) |
| Rama del milestone | `feat/tdt-api02-b-global-catalogue` (fusionada; registro local eliminado) |
| PR | **#2** — fusionado |
| Merge commit en `origin/main` | **`259ad716f5cc6dcddebf4b18c4c26bd848142de5`** (`259ad71`) |
| CI/CD existente | **No** (sin `.github/`) → el merge no disparó ningún despliegue |
| Snapshots upstream | `data/snapshots/` **no versionado** (D-014) |

## Verificación final (ejecutada sobre `main` ya fusionado)

| Etapa | Exit | Resultado |
|---|---|---|
| `build` | 0 | OK |
| `typecheck` | 0 | OK |
| `unit` | 0 | **217 tests** |
| `integration` | 0 | **123 tests** |
| `independence` | 0 | **15 tests** |
| `client` | 0 | **14 tests** |
| `ingestion` (escenarios) | 0 | **9/9** |
| preflight | 0 | READY (MongoDB `rs0` + Redis) |

**Estado por criterio:** ingesta original sin dependencia de runtime · snapshots versionados con
procedencia y licencia · 8 conceptos separados · reconciliación determinista sin fusiones silenciosas
(tras REV-004) · catálogo privado con autorización obligatoria · UUIDs estables y migraciones que
preservan identidades · tests, base de datos, migraciones y rendimiento ejecutados · revisión
independiente `pass` · PR fusionado con SHA verificado · worktrees limpiados · **ningún despliegue no
autorizado**. Todo **PASS**.

**Limitación declarada:** los *lifecycle records* del toolkit quedan como `record-without-worktree`
porque su `remove` no pudo borrar directorios que contenían `node_modules`; no queda ningún worktree
ni dato de git. Se documenta en lugar de ocultarse.

## Alcance

Ingesta original de listados M3U/M3U8 desde snapshots acotados y versionados, con identidad de canal
canónica, reconciliación determinista con revisión manual, catálogo privado de staging, modelos
MongoDB con migraciones reversibles y cobertura de pruebas con cifras reales.

## No-objetivos

- No se corrigen SEC-01/SEC-02/R2 (pertenecen a su propio trabajo; siguen abiertos).
- **MODO DEMO (D-016):** todas las fuentes se incluyen y se pueden publicar; las licencias se
  registran como procedencia y **no bloquean**. Free-TV ya no está excluida.
- No se exponen `identity` ni las nuevas colecciones en la API pública (decisión de 02C).
- No se añade CI/CD (R3).

## Defectos encontrados por la revisión independiente (t7 ronda 2 → corregidos en t8)

| ID | Sev. | Defecto | Corrección |
|---|---|---|---|
| TDT02B-REV-004 | **high** | `pipeline.ts` anulaba el enlace de un candidato en `review` y **volvía a enlazarlo** por clave de identidad: una emisora regional se fusionaba con su base nacional sin decisión humana | el candidato en `review` sale antes del fallback y queda sin enlazar (`channelId: null`, `state: 'unmatched'`); la fila de revisión conserva `proposedChannelId`. Test de regresión nuevo |
| TDT02B-REV-003 | low | El informe atribuía el corte de 400 ficheros a `ingestion/snapshot.ts` | Atribuido a `data/fetch-snapshots.mjs` (MAX_FILES 400) |
| TDT02B-REV-005 | low | Throughput publicado como cifra única | Publicado como rango medido (480,3–944,4 entradas/s) |

**Consecuencia honesta y medida de REV-004:** el catálogo real baja de 15 242 a **10 403** canales y la
revisión manual sube de 2 060 a **8 332** candidatos; la ingesta pasa de 24,5 s a 48,2 s. El catálogo
anterior era más grande **porque fusionaba sin decidir**. Ese es el comportamiento correcto y es la
razón de ser del milestone.

## Defectos encontrados por ejecución real (no por inspección)

Ninguno se habría detectado leyendo el código; todos salieron de ejecutar el sistema:

| # | Defecto | Corrección |
|---|---|---|
| 1 | Índice único de candidato sin `provenance.upstreamPath`: dos ficheros del mismo snapshot con la misma URL en la misma línea abortaban la ingesta (E11000) | migración `007-candidate-natural-key` con rollback |
| 2 | El asignador de slugs se sembraba con claves de identidad, no con slugs: dos canales podían reclamar `cctv-3` | siembra desde `channels.slug` |
| 3 | El pipeline nunca escribía la fila de procedencia del snapshot | lo escribe el pipeline con `$setOnInsert` |
| 4 | `rollbackRun` borraba 18 756 candidatos de **otra** ejecución | el ledger registra solo lo insertado |
| 5 | Dos ejecuciones colapsaban en una fila del ledger | runId único por invocación |
| 6 | Reconciliación cuadrática (108 ms/llamada) | índice por buckets: 0,14 ms |
| 7 | Expansión por país y por token genérico `tv` (3 792 canales) | país como filtro; `GENERIC_TOKEN_CUTOFF` |
| 8 | El modelo `SourceAuthorization` existía pero **nadie lo consumía** | `catalogue/authorisation.ts` lo impone |
| 9 | `parsePlaylistText` dejaba `\r` en las URLs con texto CRLF | normalización dentro de la función |

## Defecto de planificación registrado (corregido)

`t6` (revisión independiente) se creó **sin dependencias**, por lo que el scheduler la despachó antes
de que existiera código. El revisor devolvió correctamente `reject` con dos bloqueantes
(`TDT02B-REV-001/002`: el entregable no existía). **La revisión no era inválida; el grafo sí.** Se
sustituye por `t7`, con dependencia explícita de `t5`. Lección para 02C: *toda tarea de revisión nace
con `dependencies: [<tarea integradora>]`; aprobar un plan no valida su grafo.*

---

## Estado histórico — TDT-API-02A

**Estado final: PASS** (revisión independiente fuera de AgentTeams; limitación ENGINE-04 documentada).

# MILESTONE_STATUS — TDT-API-02A (histórico)

---

## Identidad y Git

| Dato | Valor |
|---|---|
| Repositorio | `tdt-api01` (`origin` = `github.com/manuelxose/epgchannels.git`) |
| Rama por defecto | `main` |
| SHA base verificado | `febbec464763ffd5812f5b80bf3f6901774dde65` (`febbec4`) |
| Sincronía `main`…`origin/main` al inicio | `0 0` (idénticas), árbol limpio |
| Rama del milestone | `feat/tdt-api02-a-audit` |
| CI/CD existente | **No** (sin `.github/`) → ningún merge dispara despliegue |

## Alcance

Auditoría con evidencia del producto TDT-API-01, línea base reproducible, contratos de
compatibilidad/migración, memoria persistente y reglas de ejecución. **Sin implementación de 02B.**

## No-objetivos

- No corregir SEC-01/SEC-02/R2 en este milestone (pertenecen a 02B).
- No importar catálogos nuevos.
- No declarar la licencia del proyecto (decisión de producto pendiente).
- No añadir CI/CD.

---

## Worktrees

| ID | Rama | Propietario | Estado |
|---|---|---|---|
| `tdt02a-arch` | `feat/tdt02a-arch` | architect | entregado (`AUDITORIA-ARQUITECTURA.md`) |
| `tdt02a-rea` | `feat/tdt02a-rea` | rea-research | entregado (informe + evidencia) |
| `tdt02a-cat` | `feat/tdt02a-cat` | catalogue | entregado (informe + plan) |
| `tdt02a-sec` | `feat/tdt02a-sec` | legal | entregado (`INFORME-SEGURIDAD-DERECHOS.md`) |
| `tdt02a-base` | `feat/tdt02a-base` | captain | línea base + memoria persistente (integrado) |
| `tdt02a-docs` | `feat/tdt02a-docs` | captain | no usado (sin escrituras) |
| `tdt02a-review` | (sin rama; árbol de solo lectura) | captain | usado para revisión; sin commits |

Todos los worktrees partieron de `febbec4` y **ninguno modificó código de producto**.

---

## Tareas

| ID | Tarea | Propietario | Ruta (clase) | Estado |
|---|---|---|---|---|
| t1 | Auditoría arquitectura/backend | architect | v4-pro (L3) | **completed** |
| t2 | Investigación REA de reproducción | rea-research | flash (L2) | **completed** |
| t3 | Catálogo/M3U/plan de migración | catalogue | v4-pro (L3) | **completed** |
| t4 | Seguridad/derechos/licencias | legal | v4-pro (L4) | **completed** |
| t5 | Auditoría/verificación (8 intentos de miembro fallidos) | captain | v4-pro (L3) | **completed** (verificación del capitán) |
| t6 | Revisión del paquete (2 intentos de miembro fallidos) | captain | v4-pro (L2) | **completed** (revisión del capitán) |
| t7 | Integración/PR/merge | captain | flash (L2) | **completed** |

**Revisión independiente obtenida fuera de AgentTeams:** tras los fallos de los miembros, un
revisor subagente **independiente y separado del capitán** revisó el PR #1 y emitió **PASS** con
todas las afirmaciones confirmadas y 3 observaciones no bloqueantes. Esa revisión **sí** es
independiente por autoría (modelo y sesión distintos), aunque no proceda de un miembro del equipo.

---

## Línea base ejecutada (real)

| Etapa | Exit | Resultado |
|---|---|---|
| `build` | 0 | OK |
| `typecheck` | 0 | OK (requiere `build` previo — D-007) |
| `unit` | 0 | 67 tests |
| `integration` | 0 | 102 tests |
| `independence` | 0 | 15 tests |
| `client` | 0 | 14 tests |

Preflight (`scripts/preflight.mjs`): **READY** (MongoDB réplica `rs0` + Redis PONG + 3 workspaces).

---

## Hallazgos abiertos (no corregidos en 02A)

| ID | Sev. | Resumen | Dueño |
|---|---|---|---|
| SEC-01 | high | SSRF: egress sin bloqueo de rangos privados | 02B |
| SEC-02 | high | Clave GuíaTV anunciada pero no aplicada | 02B |
| LIC-01 | high (publicación) | Sin `LICENSE` | producto/02B |
| R2 | high | `playable=true` full scan | 02B |
| R3 | high | Sin CI/CD | milestone posterior |
| SEC-04 | medium | Scraping de YouTube en job backend | 02B |
| SEC-08/SEC-09/SEC-13/SEC-03 | medium | Throttle login, `/metrics` abierto, Mongo/Redis sin auth, clave YouTube en navegador | 02B |
| R1/SEC-11 | media | Ternario muerto en egress | 02B |
| D-010 | — | `country:'INT'` incompatibilidad de contrato | 02B (decisión) |

Ningún hallazgo `blocker` impide la auditoría. **Sí** impiden publicación.

---

## Riesgos sin resolver

1. El producto anuncia autenticación server-to-server que no aplica (SEC-02); cualquier consumidor
   que confíe en esa señal está desprotegido.
2. Sin CI/CD, la verificación depende de que cada milestone la ejecute a mano (mitigado por el
   manifiesto, no eliminado).
3. La licencia del proyecto sigue sin declarar (LIC-01): no se puede publicar ni distribuir.
4. La licencia de iptv-org (Unlicense vs badge CC0) requiere conciliación antes de ingerir.

- **Revisión independiente dentro de AgentTeams: NO completada.** Los intentos de miembro fueron
  **3 en t5** (`auditor` ×2, `architect` ×1) y **2 en t6** (`architect` ×1, `catalogue` ×1):
  **5 intentos en total**, todos sin entregable tras turnos de duración anómala. El capitán completó
  la verificación (`AUDITORIA-INDEPENDIENTE.md`) y la revisión del paquete (`REVISION-INDEPENDIENTE.md`),
  **declarándolas como verificación del capitán**.
- **Revisión independiente fuera de AgentTeams: SÍ obtenida.** Un subagente independiente (modelo y
  sesión distintos, sin acceso a la deliberación del capitán) revisó el PR #1 contra `6f0163e`:
  **PASS**, todas las afirmaciones confirmadas con `ruta:línea`, 0 secretos, 0 bloqueantes y
  3 observaciones no bloqueantes (ya corregidas las dos factuales).
- Los entregables de los 5 especialistas sí se produjeron y están integrados con evidencia citable.

## Criterios de aceptación del milestone

Ver `EXECUTION_CONTRACT.md §9`; específicamente: auditoría con evidencia, línea base validada en
verde, contratos de migración verificables, memoria persistente completa, revisión independiente
`pass` y PR fusionado con verificación del SHA de `origin/main`.

**Estado por criterio:**

| Criterio | Estado |
|---|---|
| Auditoría con evidencia citable | **PASS** (5 informes + verificación con ruta:línea) |
| Línea base reproducible en verde | **PASS** (comandos reales, exit 0; sin sello content-bound, ver limitación ENGINE-04) |
| Contratos de migración verificables | **PASS** (`PLAN-COMPATIBILIDAD-MIGRACION.md`) |
| Memoria persistente completa | **PASS** (6 documentos obligatorios + 4 de apoyo) |
| Revisión **independiente** | **PASS fuera de AgentTeams** / **PARCIAL dentro** (5 intentos de miembro fallidos; subagente independiente emitió PASS sobre PR #1) |
| Gate ENGINE-04 content-bound | **BLOCKED** (limitación del entorno, ver `MODEL_ROUTING_AND_USAGE.md §4.1`) |
| PR fusionado y SHA verificado | **PASS** (`origin/main` = `dbb3d5e`, verificado tras el merge) |
| PR fusionado y SHA verificado | pendiente al cierre |

## Nota de ejecución del gate (medida al cerrar, 2026-11-17)

La suite `unit` se ejecutó en verde varias veces (**290 tests**) durante el milestone. En la última
verificación, bajo carga sostenida de la máquina (78 procesos `node` residuales de ejecuciones
anteriores, y duraciones de etapa 3–4× superiores: `integration` 84,6 s frente a 27,5 s), dos pruebas
**preexistentes y no tocadas por 02C** agotaron su tiempo límite:

- `catalogue-identity/reconcile.indexed.unit.spec.ts` — «preserves every same/review verdict…»,
  timeout de 60 s (llegó a 143 s; antes 24 s).
- `ingestion/snapshot-real.unit.spec.ts` — timeout bajo contención; **pasa en aislamiento**.

**Comprobado que no es una regresión de 02C:** la misma prueba falla igual en `main` base
(`bb54ac9`: `1 failed | 216 passed` de 217), y `git diff --name-only main..HEAD` no toca ninguna de
las dos. Los **135 tests** de los módulos que 02C modifica (`providers`, `playback`, `admin`) pasan
íntegros, y `integration` (128), `ingestion` (9/9), `independence` (15) y `client` (14) están en verde
sobre el commit entregado.

Se declara en lugar de ocultarse: **la etapa `unit` no produjo exit 0 en la última pasada**, y el
motivo es una prueba de rendimiento preexistente sensible a la carga, no un defecto del milestone.
