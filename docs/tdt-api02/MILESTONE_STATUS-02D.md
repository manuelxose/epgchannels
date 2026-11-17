# MILESTONE_STATUS-02D — Verificación automática de streams y salud de fuentes

Estado: **EN CURSO** (este documento se escribe mientras t12 y t13 están en vuelo; se cerrará con el
SHA congelado, el gate y el veredicto independiente).

Fecha: 2026-11-17 · Rama `feat/tdt-api02-d-stream-health` · Base verificada `2eb218d` (`origin/main`, 02C fusionado).

---

## 1. Identidad Git

| Dato | Valor |
|---|---|
| Remoto | `https://github.com/manuelxose/epgchannels.git` |
| SHA base | `2eb218d91a115e4514c3ee726c2c61f3371409f6` |
| Rama | `feat/tdt-api02-d-stream-health` |
| CI/CD | **No** (sin `.github/`) → el merge no dispara despliegue |

## 2. Alcance y no-alcance

**Dentro:** verificación automática con ledger de salud persistente — defensas SSRF, motor de validación
en capas, cola/planificador con concurrencia acotada, backoff, circuit breakers, controles de operador,
métricas, y verificación de reproducción real en navegador medida aparte de la alcanzabilidad HTTP.

**Fuera (declarado, no olvidado):**

- **Consumir `healthy` en el descriptor público `/api/v1`.** `publication-policy.ts:isSourceHealthy()`
  sigue tratando `technicalStatus: 'unknown'` como sano. Cambiarlo altera el descriptor público de
  reproducción y es trabajo de un milestone posterior, no una decisión para el último tramo.
- **Persistir el rastro de descenso maestro→variante.** Se produce y tipa, pero `health.repository.ts`
  lo copia verbatim; ensanchar el esquema persistido es un cambio de contrato de almacenamiento.
- **LatAm / resto del catálogo internacional.** Ninguna afirmación.
- **CI/CD (R3).** Sigue sin existir.
- **SEC-02** (clave de servicio) permanece fuera de alcance.

## 3. Propiedad de ficheros (cumplida)

| Área | Autor | Ficheros |
|---|---|---|
| SSRF / egreso seguro | `ssrf-engineer` | `infrastructure/{safe-egress,ip-classification,egress}.ts`, `verification/ssrf.unit.spec.ts`, `verification/fixtures/http-fixtures.ts` |
| Motor de validación + ledger | `validator-engineer` | `verification/{validator,manifest,failures,health.schema,health.repository,backoff}.ts` + specs |
| Cola / planificador / controles / métricas | `scheduler-engineer` | `verification/{queue,scheduler,metrics,controls,types,egress-classification,runtime}.ts` + specs, `modules/admin/verification.admin.ts`, scripts de medida |
| Cableado | `scheduler-engineer` (t4) | `config/config.ts`, `server/{context,bootstrap,routes}.ts`, `jobs/scheduler.ts`, `infrastructure/mongo.ts`, `migrations/008-*`, `migrations/runner.ts` |
| Documentación, PR, merge | capitán | `docs/tdt-api02/**` |

Un escritor por worktree; worktrees creados solo con `parallel-dev.mjs`; sellado solo con la puerta de
globs. Todas las fusiones pasaron por revisión del capitán del diff real.

## 4. Resultado central: HTTP 200 ≠ vídeo reproducible

Ver `VERIFICACION-FUENTES-02D.md`. El caso medido: un maestro público responde **200 con manifiesto
válido** y su única variante responde **404**. El eje de alcanzabilidad no puede verlo; el navegador sí
(`playback-failed-format`). Verificado de forma independiente por el capitán.

## 5. Defectos reales encontrados EJECUTANDO (no leyendo)

La lección dominante del milestone. Cada fila se encontró ejecutando el motor contra red real o
fixtures reales, después de que la suite estuviera en verde.

| # | Defecto | Cómo apareció | Estado |
|---|---|---|---|
| 1 | `safeFetch` no podía descargar **ninguna** URL https real (`ERR_INVALID_IP_ADDRESS`) | ejecución contra red real | corregido (t6) |
| 2 | El filtro de `content-type` ocultaba el estado HTTP de las respuestas de error | matriz de fixtures | corregido (t6) |
| 3 | Cuerpo sobredimensionado reportado como `invalid-manifest` | matriz de fixtures | corregido (t6) |
| 4 | Servidor colgado reportado como `response-too-large` | matriz de fixtures | corregido (t6) |
| 5 | Clasificación por **texto del mensaje** en vez del código: «Redirect limit **exceed**ed» → `response-too-large` | matriz de fixtures | corregido (t8) |
| 6 | Playlist **maestra** nunca descendía: la capa de segmentos era inalcanzable | matriz de fixtures | corregido (t10) |
| 7 | `segmentSample=0` hacía que un maestro válido se reportara `invalid-manifest` | detectado por el autor | corregido (t10) |
| 8 | Allow-list de `content-type` **más estricta** que el parser: `audio/mpegurl` rechazado | medición **live** | corregido (t11) |
| 9 | Presupuesto de 64 KiB (sonda) aplicado al **segmento entero** → un directo HD sano reportado `missing-segments` | medición **live** | t12 |
| 10 | Clasificador de reintentos **muerto** en la ruta de producción (`thrown` nunca es true) | reportado por el propio autor | t13 |

**Por qué importa:** el defecto 1 convivió con **131 tests en verde**. Todos inyectaban `deps.lookup`,
es decir, sustituían exactamente la costura donde estaba el fallo. Una defensa de red no está probada
mientras su única cobertura inyecte la capa que puede romperse. Queda escrito en el contrato (§9) como
regla permanente.

El defecto 10 lo reportó el autor **contra su propio código**, antes de que la revisión lo encontrara.
Eso es exactamente el comportamiento que el contrato pide.

## 6. Verificación

Matriz de fixtures controlados: **14/14**, exit 0 (`evidence/verification-02d/fixture-matrix.json`).
Cubre sano, 200-que-no-es-playlist, playlist vacía, sin segmentos, segmentos 404/403, 404, 403, 451,
5xx, cuerpo sobredimensionado, timeout, redirección a metadatos, bucle de redirección.

Probe SSRF adversarial independiente (`ssrf-adversarial-probe.mjs`), **sin seam inyectado**: 10/10
rechazados, **0 conexiones** a ningún destino privado, control positivo 200 en el mismo proceso, exit 0.
Prueba por mutación (`MUTACION-SSRF-02D.md`): con UNA capa caída sigue habiendo 0 conexiones; con AMBAS
caídas hay conexión real y el probe devuelve exit 1 → la puerta discrimina de verdad.

Queries del gate: **pendiente de la ejecución final** sobre el SHA congelado.

## 7. Limitación principal (declarada, sin adornos)

**El motor no ha verificado ni una sola fuente del catálogo real.** Medido en la base viva: **81**
fuentes publicadas `hls`/`dash` con URL y **0** con registro de autorización
(`source_authorizations_02c` no existe). El gate las declara `ineligible` y no abre sockets: correcto,
pero implica que la verificación real del catálogo **no está demostrada**. Lo que sí está medido con red
real son distribuciones públicas de prueba y la comprobación de reproducción en navegador.

## 8. Estado del gate y del veredicto

### 8.1 Revisión independiente — `pass`

Ejecutada por `deepseek-official/deepseek-v4-pro` (familia distinta de todos los implementadores, que
fueron `deepseek-flash`) sobre el árbol congelado `9d5bc10` / tree `a0c66a5`. Re-ejecutó el gate por sí
misma (build 0, typecheck 0, unit 549, integration 181, ingestion 9/9, independence 15, client 14),
escribió su **propio** probe SSRF en `%TEMP%` con contador de conexiones independiente (9/9 destinos
bloqueados con **0 conexiones**), hizo **mutación con recompilación** (`isPublicAddress → true`,
suite SSRF 50 fallos/113 pases, con `ENETUNREACH` y `ECONNREFUSED` reales), probó timeout/404/no-reintento/
concurrencia medida (8 global, 2 por host) y la recuperación tras caída. Buscó el patrón de defecto de
02C y **no encontró ninguno**.

Cuatro hallazgos, ninguno bloqueante:

| # | Sev. | Hallazgo | Resolución |
|---|---|---|---|
| F1 | medium | El contrato §2 seguía diciendo «512 KiB = techo absoluto ⇒ response-too-large» cuando el código aplica 4 MiB de tolerancia + 64 KiB de sonda | **corregido**: contrato reescrito con los tres presupuestos y la consecuencia declarada |
| F2 | medium | La evidencia engine-04 comprometida no estaba ligada al árbol congelado | **corregido**: snapshot re-hecho sobre el árbol final (1 406 artefactos, `gaps: []`) y `GATE-02D.md` |
| F3 | low | El documento nombraba `source_authorizations_02c` y el revisor creía que la real era `source_authorization` | **rechazado con evidencia**: la constante de código `AUTHORIZATION_COLLECTION` **es** `source_authorizations_02c`. Además **ninguna de las dos existe** en la base viva, así que la limitación (0 autorizaciones) se confirma igual |
| F4 | low | `runtime.ts` recorta `maxBytes` a `VERIFY_MAX_BYTES` (2 MiB por defecto) | **verificado inofensivo y documentado**: con lectura por prefijo ambas cotas devuelven 65 536 B; no muerde, pero las dos cotas estaban confladas y ahora el código lo explica |

### 8.2 Gate — medido directamente, **no** certificado por engine-04

Las siete etapas salen **0** con exit codes reales sobre el árbol final. **Pero el gate automático no
pudo ejecutarlas**: el runner ACL de Windows falla con `CreateProcessAsUserW failed (Win32 2)` y
`ingestion/migration-rollback` con `spawn EPERM`. Es una limitación del entorno, no del código.

Por tanto, en el vocabulario de `ENGINE-04 §8.6`, este milestone **no puede declararse PASS
certificado**: es **medido directamente y verificado por revisión independiente**, pero **no**
engine-04-gated. Ver `GATE-02D.md`.

## 9. Calificación honesta del milestone

**PARTIAL** — en el eje de certificación, no en el funcional.

- Todo lo medible se midió, con exit codes reales y verificación independiente que incluyó mutación.
- Los criterios funcionales del §3 se cumplen y están probados por ejecución.
- **No** se declara PASS certificado porque el gate engine-04 no puede ejecutarse en este host.
- **No** se declara PASS pleno además porque la verificación contra el catálogo real sigue sin
  demostrarse (0 autorizaciones registradas, §7) — el motor sólo ha verificado fuentes públicas.

Un milestone no es PASS porque este documento lo diga.

---

## 10. Cierre — merge y verificación del SHA (2026-11-17)

| Dato | Valor |
|---|---|
| PR | **#6** `feat(tdt02d): automated stream verification and source health` |
| Estado del PR | **MERGED** |
| Merge commit en `origin/main` | `19d9c67bc693b8a577864c28c4abe80a3159032b` |
| `main == origin/main` | **verificado** |
| CI/CD | **No hay** `.github/` – el merge no dispara ningún despliegue |
| Worktrees | los cuatro eliminados; `git worktree list` sólo muestra el checkout principal |

### Gate re-ejecutado SOBRE `main` después del merge

No se da por supuesto que el merge haya conservado el verde: se volvió a medir.

| Etapa | Exit | Resultado |
|---|---|---|
| `build` | 0 | OK |
| `typecheck` | 0 | OK |
| `unit` | 0 | 549 tests |
| `integration` | 0 | 181 tests |
| `ingestion` | 0 | 9/9 |
| `independence` | 0 | 15 tests |
| `client` | 0 | 14 tests |

### Incidente durante el cierre, declarado

Al limpiar los worktrees, una secuencia de comandos captain-side (`git reset --soft` sobre un `main`
local inexistente, más la manipulación de una unión de `node_modules`) dejó el árbol de trabajo con
**178 ficheros rastreados ausentes en disco** y el árbol de dependencias vacío. Detectado por
`git status`, **recuperado por completo** `git checkout -- .` desde el índice (que estaba intacto y
coincidía con `HEAD`), y las dependencias se reinstalaron con `npm ci` desde el lockfile (TypeScript
5.9.3, exacto). El gate completo se re-ejecutó **después** de la recuperación y sale 0 en las siete
etapas, como muestra la tabla.

Ningún fichero del milestone se perdió: el daño fue en el árbol de trabajo, no en el contenido
rastreado, y `origin/main` nunca estuvo afectado. Lección registrada: **no usar `git reset` para alinear
ramas, y no manipular uniones de `node_modules` a mano.**

### Estado final: PARTIAL

Ver §9. La certificación engine-04 sigue sin poder ejecutarse en este host; todo lo demás está medido y
revisado de forma independiente.