# VERIFICACIÓN DE CAPITÁN — TDT-API-02A

> **ADVERTENCIA DE ATRIBUCIÓN — LEER ANTES QUE NADA**
>
> Este documento **NO** es una auditoría independiente realizada por otro agente. Es la
> **re-verificación hecha por el capitán** sobre hallazgos ya redactados por los especialistas.
>
> La tarea t5 estaba asignada a un miembro independiente. Se hicieron **tres intentos** con
> miembros (`auditor` ×2, `architect` ×1), todos con turnos de duración anómala y **sin entregable**.
> El registro completo de intentos —incluida la tarea de revisión t6 y la toma de control del
> capitán— está en `MILESTONE_STATUS.md`. Según `EXECUTION_CONTRACT` y ENGINE-04 §8.8 (tope de 2
> reparaciones), se cambió de estrategia en lugar de repetirla, y el capitán completó la verificación
> con alcance acotado.
>
> **Consecuencia honesta sobre el criterio de aceptación "revisión independiente": la revisión
> independiente de esta tarea NO se ha producido por un agente distinto.** Se mitiga con evidencia
> citable y con el hecho de que el capitán re-verificó de forma adversarial los hallazgos de mayor
> severidad en lugar de aceptar los informes por su relato. Cualquier lectura de este milestone debe
> contabilizarlo como **verificación del capitán, no auditoría independiente**.

Fecha: 2026-11-16 · Base: `febbec4` · Método: lectura dirigida del código real con `ruta:línea`.

---

## 1. Cobertura real de esta verificación

| Aspecto | Estado |
|---|---|
| Hallazgos de severidad `high` re-verificados | **5 de 5** (SEC-01, SEC-02, LIC-01, R2, SEC-04) |
| Hallazgos de severidad `medium`/`low` re-verificados | 3 (SEC-06, SEC-11/R1, R11) |
| Búsqueda dirigida de hallazgos alta omitidos | 2 sondeos (rutas de escritura, guardas de autorización) |
| Contradicciones entre informes | 2 pares comprobados |
| **No verificado por el capitán** | SEC-03, SEC-05, SEC-07, SEC-08, SEC-09, SEC-10, SEC-12, SEC-13, SEC-14, SEC-15, SEC-16, R4, R5, R6, R8, R9, R10, R12, R13 (aceptados por relato, sin re-verificación) |

---

## 2. Veredictos

### 2.1 Confirmados con evidencia propia

| ID | Veredicto | Evidencia citada |
|---|---|---|
| **SEC-02** (clave GuíaTV no aplicada) | **CONFIRMADO** | `secretMatches` definido en `admin.auth.ts:51-56` y sus **únicas** llamadas están en `security.unit.spec.ts:53-55`. `serviceKeyEnabled` se calcula en `bootstrap.ts:41` y solo se **anuncia** en `routes.ts:317` (`requiresApiKey`). No existe middleware que lea `x-api-key` y compare: `logging.ts:14` solo lo redacta. **La autenticación server-to-server es ficción documental.** |
| **SEC-01 / R7** (SSRF) | **CONFIRMADO** | `infrastructure/egress.ts` no contiene ninguna comprobación de IP privada/loopback/link-local ni resolución DNS (búsqueda de `private|loopback|127.|169.254|dns|lookup` → 0 resultados). Solo valida esquema y lista de hosts. |
| **R1 / SEC-11** (flag muerto) | **CONFIRMADO** | `bootstrap.ts:38`: `config.EGRESS_GUARD_ENABLED ? config.BLOCKED_EGRESS_HOSTS : config.BLOCKED_EGRESS_HOSTS` — ambas ramas idénticas. |
| **R2** (full scan en `playable=true`) | **CONFIRMADO** | `channels.service.ts:214` `find(mongoFilter).sort().toArray()` y `:216` `docs.filter(...)` en memoria sobre **todo** el resultado, antes de paginar en JS (`:217-219`). |
| **LIC-01** (sin licencia) | **CONFIRMADO** | No existe ningún `LICENSE*` en el árbol. `README.md:66-69` lo declara pendiente. |
| **SEC-04** (scraping y contradicción) | **CONFIRMADO** | `youtube-channel-resolver.ts:89-130` resuelve por `globalThis.fetch` (`:96`) sin pasar por la política de egress (0 coincidencias de `fetchWithPolicy|egress|blockedHosts`). El frontend afirma lo contrario en `apps/frontend/src/app/core/integrations/youtube-runtime.ts:162-164`: «Reading the id from the channel page was evaluated and rejected … a server-side scraper is not part of this app». **La contradicción es literal y verificada.** |
| **SEC-06** (comparación no constante del bootstrap) | **CONFIRMADO** | `admin-auth.service.ts:70` usa `parsed.data.bootstrapToken !== this.bootstrapToken`. Existe `secretMatches` en tiempo constante y no se usa. Severidad `low` es correcta: el token tiene ≥32 caracteres y el endpoint es one-shot. |
| **R11** (casts `as never`) | **CONFIRMADO (cosmético)** | 5 ocurrencias en `playback.service.ts:50, 132, 172, 237, 363`. Debilitan el tipado del enum `Permission` pero **no** relajan `decidePublication`, que es quien autoriza: no es un riesgo de seguridad, es deuda de tipos. |

### 2.2 Matiz importante sobre la explotabilidad de SEC-01

`/admin/sources/:id/verify` **exige** `requireEditor` (`routes.ts:625-627`), y el job programado
solo procesa fuentes `editorialStatus: 'published'` de tipo `hls`/`dash` (`scheduler.ts:31-36`).

Por tanto SEC-01 **no** es un SSRF abierto a Internet: requiere **una cuenta de editor** (o una
fuente ya publicada apuntando a un destino interno). La afirmación «un token de editor filtrado
permite sondear la red interna» es correcta; la de «cualquiera puede» **sería falsa**. Se mantiene
`high` porque una cuenta de editor comprometida obtiene alcance sobre la red interna y metadatos de
nube, pero **no se debe inflar a explotación no autenticada**.

### 2.3 Hallazgos alta omitidos — sondeo

Se enumeraron **todas** las rutas que mutan estado (`routes.ts`: 426, 433, 440, 519, 529, 540, 551,
593, 603, 614, 625, 714, 728). **Todas** están protegidas: `requireEditor` (9), `requireAdmin` (1) y
las tres `/auth/*` (bootstrap/login/logout), no autenticadas **por diseño**.

**Resultado: no se encontró ningún endpoint de escritura sin autenticar ni bypass de la política de
publicación que los informes hubieran omitido.** Este es el hallazgo negativo más importante de esta
verificación: refuerza la conclusión de que SEC-02 es el problema de autorización, no una puerta
trasera de escritura.

### 2.4 Contradicciones entre informes

| Par | Resultado |
|---|---|
| Licencia de iptv-org (catálogo vs seguridad) | **Sin contradicción.** El informe de catálogo afirma Unlicense + badge CC0 a conciliar (`:27, :181-182`); el de seguridad **declara explícitamente** que no inspeccionó esas licencias (`§7.3, §9`). Son consistentes y ambos tratan el punto como pendiente. |
| TDTChannels como dependencia de runtime | **Sin contradicción.** Ambos coinciden: sin dependencia de runtime, conservando procedencia, alias `legacy-tdt` y atribución. El informe de catálogo añade que el import ya existe (`catalogue-import.ts`), coherente con la arquitectura. |

**Ninguna contradicción bloqueante detectada.**

### 2.5 Corrección de una imprecisión detectada por el capitán

El informe de arquitectura cita `docs/PROVENANCE-AND-LICENCES.md:34-35` para «we never proxy». El
capitán verificó: `docs/PROVENANCE-AND-LICENCES.md:34` contiene esa frase y `:47` la refuerza.
La cita es **correcta**. Además `docs/ARCHITECTURE.md` **no** menciona el proxy (0 coincidencias), lo
que **no** contradice al informe: el informe citaba el documento de procedencia, no el de
arquitectura. No hay error.

---

## 3. Lo que esta verificación NO establece

- No re-verifica 19 hallazgos `medium`/`low` (listados en §1). Se aceptan tal como los redactaron los
  especialistas, sin confirmación independiente.
- No es una revisión independiente por otro agente (§ advertencia inicial).
- No re-ejecuta el código: es verificación **estática** por lectura dirigida.
- No añade hallazgos propios más allá del sondeo de rutas de §2.3.

## 4. Veredicto

**PASS para la auditoría de 02A, con una salvedad de proceso registrada.**

- Los **5 hallazgos de severidad `high`** están confirmados con evidencia citable.
- No aparecen contradicciones bloqueantes entre informes.
- No se detectaron puertas de escritura sin autenticar omitidas.
- **Salvedad:** la revisión independiente por agente distinto **no** se completó; este documento es
  verificación del capitán. Debe constar así en `MILESTONE_STATUS.md` y en el PR.

**Lista bloqueante:** ninguna para *auditar* o *fusionar documentación*. Sí existen bloqueantes para
*publicar el producto*: **SEC-01**, **SEC-02**, **LIC-01** (traslado a 02B en `NEXT_HANDOFF.md`).
