# MODULE-CONTRACT-02D — Automated Stream Verification & Source Health

Contrato de módulos del milestone **TDT-API-02D**. Hereda `MODULE-CONTRACT-02C.md`,
`MODULE-CONTRACT-02B.md` y `EXECUTION_CONTRACT.md`; donde haya conflicto gana la política global
(`ENGINE-01..07`), después `EXECUTION_CONTRACT.md` y después este contrato, que **solo añade**
restricciones.

Establecido: 2026-11-17 · rama `feat/tdt-api02-d-stream-health` · base `2eb218d` (`origin/main`).

---

## 0. Reglas duras

1. **Los cuatro ejes siguen separados y ninguno se deriva de otro:**
   *autorización* (¿podemos? — 02C, `decideSourceEligibility`), *disponibilidad* (¿responde hoy? —
   02D, motor de verificación), *reproducibilidad* (¿un navegador real reproduce?) y *salud agregada*
   (¿qué historia tiene?). Un `HTTP 200` **nunca** es prueba de reproducción.
2. **La elegibilidad se comprueba ANTES de tocar la red.** El verificador no abre un socket si
   `decideSourceEligibility` no es `playable`. El resultado de elegibilidad en el momento del check
   se persiste en la fila de salud (es auditoría, no permiso retroactivo).
3. **Fail-closed en todo lo demás.** Fuente sin URL, tipo no verificable, DNS privado, redirección
   insegura, cuerpo sobredimensionado, presupuesto de profundidad agotado: todos producen una
   categoría de fallo, jamás una marca de salud.
4. **Nadie marca sano un check que no terminó.** Sólo un check con `outcome` terminal y profundidad
   alcanzada puede producir `healthy`. Un `lease` vencido, un proceso caído o un check en vuelo no
   tocan la salud agregada.
5. **Nada de evasión.** Prohibido proxy CORS genérico, cabeceras fabricadas, replay de credenciales,
   bypass de DRM/geobloqueo/autenticación/firma, y **cualquier** petición a un host que el 02C
   declaró `restricted` sin autorización. Un `403`/`451`/`geo` se **registra**, no se sortea.
6. **Sin redifusión.** No se proxya, graba ni transcodifica. Un segmento se valida con un GET
   acotado; nunca se re-sirve.
7. **Sin secretos.** Sólo nombres de variables de entorno. Canarios ficticios en tests. Las URLs
   tokenizadas se redactan (D-015) antes de entrar en una fila de salud.
8. **`/api/v1` compatible.** La salud es aditiva. Ninguna forma de respuesta pública existente se
   rompe; los campos nuevos son opcionales.

---

## 1. Persistencia: tres colecciones, tres responsabilidades

| Colección | Contenido | ¿Mutable? |
|---|---|---|
| `source_health_checks_02d` | Una fila **inmutable** por intento de verificación | sólo `state`/`lease` de transición |
| `source_health_02d` | Estado **agregado** + historia acotada (anillo) por fuente | sí, escritura CAS |
| `verification_policies_02d` | Kill-switch y controles de operador por proveedor/host | sí (auditado) |

La colección heredada `source_health` (schema del catálogo) **no se usa**: su `_id` es `candidateId`
y su unicidad es por candidato, no por `sourceId`. Reutilizarla sería un mapeo silencioso.

### 1.1 `source_health_checks_02d`

```ts
{
  _id: string;                    // idempotency key: `${sourceId}:${scheduledForISO}`
  sourceId: string;
  kind: 'scheduled' | 'manual' | 'retry';
  trigger: { actor: string; reason: string | null };
  state: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  outcome: CheckOutcomeCode | null;    // terminal; null mientras no termina
  depth: ValidationDepth;              // 'eligibility'|'dns'|'transport'|'manifest'|'playlist'|'segments'|'browser'
  eligibilityAt: EligibilitySnapshot;  // lo QUE decía el gate 02C en este instante
  origin: CheckOrigin;                 // host de egreso, región, UA, política
  timings: { queuedAt, startedAt, finishedAt, latencyMs };
  attempt: { number: number; maxAttempts: number; backoffMs: number; };
  failure: FailureDetail | null;       // categoría exacta + evidencia acotada
  uncertainty: Uncertainty;            // qué NO se pudo observar y por qué
  evidence: BoundedEvidence;           // status, content-type, bytes, sha256 de la muestra
  lease: { owner: string; expiresAt: Date } | null;
  createdAt: Date;
}
```

**Idempotencia:** `_id` determinista por `(sourceId, scheduledFor)` ⇒ reintentar tras un crash
**no duplica** trabajo ni dispara una segunda petición externa.

### 1.2 `source_health_02d`

```ts
{
  _id: string;                    // sourceId
  status: 'healthy' | 'degraded' | 'failing' | 'unknown' | 'paused' | 'unverifiable';
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastOutcome: CheckOutcomeCode | null;
  lastCheckedAt: Date | null;
  nextCheckAt: Date;
  circuit: { state: 'closed' | 'open' | 'half-open'; openedAt: Date | null; reopenCount: number };
  history: HealthSample[];        // anillo acotado, default 30
  revision: number;               // CAS
  updatedAt: Date;
}
```

`status` sólo cambia con un check **terminal**. Un `lease` vencido se libera y se re-encola;
la salud agregada queda **intacta** y `uncertainty` queda escrito en la nueva fila.

### 1.3 Categorías de fallo (vocabulario exacto, ninguna más)

`timeout` · `dns-failure` · `tls-failure` · `connection-refused` · `http-404` · `http-403` ·
`http-401` · `http-451` · `http-5xx` · `invalid-manifest` · `unsupported-format` · `missing-segments` ·
`segments-forbidden` · `cors-limitation` · `browser-incompatible` · `codec-failure` · `georestriction` ·
`expired-source` · `ssrf-blocked` · `ineligible` · `response-too-large` · `redirect-unsafe` ·
`unknown-error`

Cada categoría mapea a **una** de las causas del eje: `authorization` (sólo `ineligible`),
`network`, `protocol`, `content`, `browser`, `policy`.

> **Alcance real del vocabulario (verificado en implementación).** El vocabulario es completo, pero no
> toda categoría es *alcanzable* por el motor: `georestriction` y `expired-source` no se pueden producir
> en ninguna capa, porque una restricción geográfica registrada o un `lifecycle` caducado hacen la
> fuente **inelegible en la capa 1** (02C), no fallida. Se conservan en el tipo porque un adaptador
> futuro sí podría observarlas desde la red, pero **hoy no se emiten**, y los tests lo afirman
> explícitamente en vez de fabricar un caso. `unknown-error` es exclusivamente la categoría del check
> huérfano por lease vencido (§6).

---

## 2. Defensas SSRF (SEC-01 se cierra aquí)

- Resolución DNS explícita **antes** de conectar; se rechaza todo destino no público:
  `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16` (incluye metadata `169.254.169.254`),
  `172.16/12`, `192.168/16`, `192.0.0/24`, `192.0.2/24`, `198.18/15`, `198.51.100/24`, `203.0.113/24`,
  `224/4`, `240/4`, `::1`, `::`, `fc00::/7`, `fe80::/10`, `ff00::/8`, IPv4-mapped IPv6 (`::ffff:0:0/96`),
  y nombres reservados (`localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`).
- **Anti-rebinding:** se valida la **lista de IPs resultantes** y se conecta al conector con la IP
  validada, fijando el `Host`/SNI, para que una segunda resolución no pueda desviar la conexión
  (verificación de *pinning*). Un resultado que cambie entre la validación y la conexión es
  `ssrf-blocked`.
- **Redirecciones:** máximo 5, validadas una a una con la misma política; cualquier salto a otro
  esquema, a otro puerto no estándar de egreso o a una IP privada ⇒ `redirect-unsafe`.
- **Credenciales:** el verificador **nunca** envía `Authorization`, `Cookie`, `Origin` ni cabeceras del
  operador. Detecta `userinfo` en la URL ⇒ `ineligible`, no la usa.
- **Tamaño:** `content-length` verificado **y** contador incremental; 2 MiB manifiesto, 512 KiB
  segmento, 64 KiB por segmento muestreado.
- Todo esto se prueba con **fixtures controlados**: servidor HTTP local en loopback que simula
  redirecciones, cuerpos grandes, DNS rebind y timeouts. Los fixtures corren en
  `*_BOUND_LOOPBACK` sólo bajo un flag explícito de test.

---

## 3. Validación en capas (profundidad medida, nunca supuesta)

| # | Capa | Qué la supera | Qué la deniega |
|---|---|---|---|
| 1 | Elegibilidad 02C | `playable: true` | `unresolved`/`restricted`/sin registro ⇒ `ineligible` |
| 2 | DNS y transporte | IPs públicas, puerto estándar, TLS correcto | `ssrf-blocked`, `dns-failure`, `tls-failure` |
| 3 | HTTP y content-type | 2xx + tipo coherente | `http-*`, `response-too-large`, `redirect-unsafe` |
| 4 | Manifiesto | `#EXTM3U` en cabecera, URLs relativas resolubles | `invalid-manifest`, `unsupported-format` |

> **Frontera entre `unsupported-format` e `invalid-manifest` (resuelta durante la implementación).**
> `unsupported-format` = la respuesta **no es una playlist** (content-type fuera del conjunto HLS/DASH):
> se rechaza en la capa de transporte, antes de parsear nada. `invalid-manifest` = la respuesta **dice
> ser** una playlist (content-type correcto) y **falla** las comprobaciones de sintaxis. Un `200` con
> `text/html` es lo primero, no lo segundo. La distinción importa para el operador: «me devuelven una
> página web en vez de un stream» y «el manifiesto está roto» exigen acciones distintas.
| 5 | Playlist y segmentos | `#EXT-X-STREAM-INF` o `#EXTINF` + al menos N segmentos muestreados 2xx con tipo media | `missing-segments`, `segments-forbidden` |
| 6 | Reproducción en navegador | sólo cuando el operador la habilita y el navegador es accesible | `browser-incompatible`, `codec-failure`, `cors-limitation` |

El `depth` reportado es la capa **de la que se obtuvo evidencia**, no la solicitada. Un check que
falla en la capa 3 nunca alega profundidad 6. La profundidad 6 se marca además `uncertain` si el
navegador no está disponible: **no se infiere que la fuente no se reproduce** — se declara no
observable.

---

## 4. Planificación: mínimo ancho de banda y mínima carga al proveedor

- Intervalo base por estado: `healthy` 6 h · `degraded` 2 h · `failing` 30 min · `unknown` 15 min.
- **Backoff exponencial con jitter** `base * 2^(n)`, tope 24 h, jitter ±20 % determinista por
  `(sourceId, attempt)` (reproducible en tests, sin thundering herd en producción).
- **Tope de reintentos** por check: 3. Superado ⇒ no se reintenta; se espera al siguiente ciclo.
- **Circuit breaker** por `sourceId` **y** por host: 5 fallos consecutivos ⇒ `open` (ninguna petición)
  durante `min(2^n * 5 min, 60 min)`; luego un único `half-open` decide.
- **Presupuesto por host y por ronda:** máximo `X` peticiones concurrentes por host y `Y` por tick
  completo; un host saturado se posterga, no se desborda.
- **`HEAD` antes que `GET`** cuando el tipo lo permite: un manifiesto que no existe no se descarga.
- **Sin verificación de segmentos** cuando el manifiesto ya falló (no se gasta nada aguas abajo).
- **Diagnóstico de segmentos por muestreo:** N=2 segmentos, nunca la lista completa.
- Por defecto **ninguna** verificación de navegador en la ronda programada (`browser: manual-only`).

---

## 5. Controles de operación

- Pausar/reanudar por fuente, por proveedor y global. Un `pause` **no** borra historia.
- Reintento manual explícito con motivo obligatorio (queda en `kind: 'manual'` + auditoría).
- Todo cambio de política escribe `audit_log` con actor y antes/después.
- Endpoints **de operador** bajo el mismo auth que `/admin`; ninguno en la superficie pública.

---

## 6. Recuperación tras caída

- Cada check toma un `lease` con TTL. Un check `running` cuyo `lease.expiresAt` venció se
  **reclama** como `state: 'failed'`, `outcome: 'unknown'`, `failure.category: 'unknown-error'` y
  `uncertainty.leaseExpired: true` — **nunca** como sano.
  > **Corrección (2026-11-17, durante la implementación).** La versión inicial de este contrato decía
  > `outcome: 'unknown-error'`, que no es un `CheckOutcomeCode` válido: `outcome` pertenece al
  > vocabulario de resultados (`healthy|degraded|failing|unknown|unverifiable`) y una **categoría de
  > fallo** es otro vocabulario (`§1.3`). Se corrige el contrato, no el código: la ambigüedad era del
  > texto. Un check huérfano es «no sé, y no lo sé porque el proceso murió», que es `unknown`.
- El estado agregado se actualiza con CAS (`revision`); un escritor obsoleto falla y reintenta,
  nunca sobrescribe.
- Al arrancar, el planificador reconcilia: filas `pending` huérfanas se re-encolan; no se duplica
  porque el `_id` es determinista.

---

## 7. Propiedad de ficheros (escritores disjuntos)

| Área | Propietario | Rutas |
|---|---|---|
| Defensas SSRF/egreso + fixtures adversariales | `ssrf-engineer` | `apps/backend/src/infrastructure/egress.ts`, `apps/backend/src/infrastructure/ssrf.ts`, `apps/backend/src/verification/ssrf-*.spec.ts`, `apps/backend/src/verification/fixtures/` |
| Motor de validación + manejador de salud | `validator-engineer` | `apps/backend/src/verification/` (excepto lo anterior) |
| Cola, planificador, controles de operador | `scheduler-engineer` | `apps/backend/src/verification/scheduler.ts`, `.../queue.ts`, `.../controls.ts`, `apps/backend/src/jobs/scheduler.ts`, `apps/backend/src/modules/admin/verification.admin.ts`, `.../verification.admin.integration.spec.ts` |
| Observabilidad y métricas | `scheduler-engineer` (mismo autor, distinta Tarea) | `apps/backend/src/verification/metrics.ts` |
| Verificación de reproducción en navegador | capitán (script determinista) | `apps/backend/scripts/browser-playback-check.mjs` |
| Docs, contratos, PR, merge | capitán | `docs/tdt-api02/**` |

Un escritor nunca edita fuera de su ámbito; si lo necesita, lo **reporta** al capitán.

---

## 8. Aceptación

Ver `MILESTONE_STATUS.md`. Como mínimo:

1. `build`/`typecheck`/`unit`/`integration`/`ingestion`/`independence`/`client` en verde con exit codes reales.
2. SSRF adversarial: loopback, RFC1918, link-local/metadata, ULA, redirección a privada, DNS rebind,
   esquema no-http, cuerpo sobredimensionado — cada uno con su categoría y **cero** sockets abiertos
   hacia el destino bloqueado (comprobado con un contador en el fixture).
3. Timeout/retry: un servidor que no responde produce `timeout`; un 503 transitorio reintenta y
   respeta el tope; un fallo permanente **no** se reintenta 3 veces sin motivo.
4. Concurrencia: la concurrencia medida nunca supera el límite configurado, ni por host.
5. Recuperación: matar el proceso a mitad de check deja la salud **sin cambiar** y el check huérfano
   se reconcilia como fallido al re-arrancar.
6. Reproducción real en navegador sobre al menos una fuente autorizada, con veredicto separado del
   `HTTP 200` (documento que pruebe la diferencia).
7. Revisión independiente `pass`; PR fusionado con SHA verificado.

---

## 9. El defecto más importante de esta ronda: verde con la vía real apagada

`safeFetch` se entregó con **131 tests adversariales en verde** y, aun así, **no podía descargar
ninguna URL `https` pública**. La causa: el `lookup` inyectado en el conector, que fija la IP validada,
respondía con una dirección única, mientras que Node lo invoca con `{ all: true }` y en ese modo exige
un **array**. Todo test pasaba porque **todos inyectaban `deps.lookup`**: el banco de pruebas
ejercitaba la "vía de prueba", nunca la vía que usa producción.

Es el mismo patrón que el defecto 5 de 02C, en otro eje: allí una fixture construía por un servicio
que auto-creaba el estado que la prueba examinaba; aquí los tests sustituían exactamente la costura
donde estaba el fallo. **Lección operativa:** una defensa de red no está probada mientras su única
cobertura inyecte la capa que puede romperse. Hace falta, como mínimo, **una** prueba por costura
crítica que recorra la ruta real (aquí: una petición real a un host público y una petición real a un
fixture de loopback **sin** `lookup` simulado).

Se encontraron así cuatro defectos que ningún test podía ver, todos al ejecutar el motor contra la red
real y contra fixtures reales:

| # | Defecto | Cómo se manifestó |
|---|---|---|
| 1 | `lookup` incompatible con `all: true` | **toda** descarga `https` real fallaba con `ERR_INVALID_IP_ADDRESS` |
| 2 | el filtro de `content-type` se aplicaba a respuestas de error | un 404, 403, 451 y 503 se reportaban como `unknown-error` en vez de por su estado |
| 3 | cuerpo sobredimensionado mal reportado | se reportaba `invalid-manifest` en vez de `response-too-large` |
| 4 | servidor que nunca responde mal reportado | `response-too-large` en vez de `timeout` |

Ninguno de los cuatro era detectable leyendo el código ni ejecutando la suite. La tabla de la §8.2
("cero sockets") seguía siendo cierta y no habría detectado nada de esto: por eso el criterio 6 de
aceptación exige además una prueba **real** contra `HTTP 200`, no sólo el control negativo.
