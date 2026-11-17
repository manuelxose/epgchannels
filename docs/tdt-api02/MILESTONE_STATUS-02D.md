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

Pendiente de cerrar con: los siete stages (`build`, `typecheck`, `unit`, `integration`, `ingestion`,
`independence`, `client`) con exit codes reales y evidencia `engine-04`, el SHA congelado, y el veredicto
independiente de t5.

**Ningún veredicto se declara aquí.** Un milestone no es PASS porque este documento lo diga.
