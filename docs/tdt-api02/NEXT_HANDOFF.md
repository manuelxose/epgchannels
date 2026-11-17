# NEXT_HANDOFF — TDT-API-02 (traspaso a 02E)

Documento de traspaso. Se lee **antes** de empezar cualquier trabajo nuevo. Si algo aquí contradice el
estado real del repositorio, **gana el repositorio**: actualízalo y dilo.

Última actualización: 2026-11-17 (cierre de 02D).

---

## 0. Leer primero, en este orden

1. `EXECUTION_CONTRACT.md` — reglas obligatorias (Git, agentes, seguridad, REA, tokens, pruebas).
2. `MILESTONE_STATUS-02D.md` — estado real de 02D, **calificación PARTIAL y por qué** (§9).
3. `MODULE-CONTRACT-02D.md` — contrato del sistema de verificación. **Gobierna 02D y sucesores.**
4. `GATE-02D.md` — qué se midió, con qué exit codes, y **por qué engine-04 no puede certificarlo aquí**.
5. `VERIFICACION-FUENTES-02D.md` — HTTP 200 ≠ reproducible, medido; y la limitación del catálogo.
6. `DECISIONS.md` — **D-020..D-023** (salud como eje propio; tres presupuestos de tamaño; maestro
   desciende un nivel; **toda defensa necesita prueba por la vía real**). D-016/D-017/D-019 siguen vigentes.
7. `MUTACION-SSRF-02D.md` — cómo se probó que el probe SSRF discrimina de verdad.

---

## 1. Estado al entregar 02D

- **Motor de verificación en capas** (elegibilidad → DNS/transporte → HTTP/content-type → manifiesto →
  playlist/segmentos → navegador), con **`safeFetch` SSRF-safe**: resolución DNS explícita, rechazo de
  direcciones privadas/reservadas, **fijación de la IP validada** (pin), re-validación de cada salto de
  redirección, sin credenciales, y **lectura de prefijo acotada** (`prefixBytes`).
- **Ledger de salud persistente** con `lease`, `revision` CAS, anillo de historia y recuperación tras caída.
- **Planificador** con concurrencia global y **por host**, backoff determinista con jitter, tope de
  reintentos, **circuit breakers** por fuente y por host, y **un solo canal** de decisión de reintento.
- **Controles de operador** autenticados que fallan cerrado (`/api/v1/admin/verification/*`): pausar,
  reanudar, reintentar con motivo, estado y métricas Prometheus **sin URLs ni hostnames** (buckets).
- **Medido, no afirmado:** 3 de 4 fuentes públicas de prueba `healthy` a profundidad `segments`; la
  cuarta rota en el origen (404 real). Matriz de fixtures **14/14**. Probe SSRF adversarial **10/10
  rechazados, 0 conexiones**, con prueba de mutación.

## 2. Lo que **no** se hizo (deliberado, y por qué)

- **Consumir `healthy` en el descriptor público.** `publication-policy.ts:isSourceHealthy()` sigue
  tratando `technicalStatus: 'unknown'` como sano. Cambiarlo altera el descriptor público de
  reproducción: es una decisión de producto, no un detalle de implementación.
- **Persistir el rastro maestro→variante.** Se produce y tipa, pero `health.repository.ts` copia la
  evidencia verbatim; ensanchar el esquema persistido es un cambio de contrato de almacenamiento.
- **Verificación del catálogo real.** Ver §3.1. **Ninguna fuente del catálogo ha sido verificada.**
- **CI/CD (R3).** Sigue sin existir.
- **SEC-02** (clave de servicio) sigue fuera de alcance.

---

## 3. Lo más importante para 02E

### 3.1 La limitación que gobierna todo lo demás

**El motor no ha verificado ni una sola fuente del catálogo.** Medido: **81** fuentes publicadas
`hls`/`dash` con URL, **0** con registro de autorización; ni `source_authorizations_02c` ni
`source_authorization` existen en la base operativa. El gate las declara `ineligible` y **no abre
sockets** — que es lo correcto, pero significa que 02D demostró el motor contra fuentes públicas de
prueba, **no** contra el catálogo.

**Para desbloquearlo no hace falta código: hace falta que un operador registre autorizaciones reales,
con evidencia citable.** La vía está en 02C (`AuthorizationRepository.record`). No fabriques derechos
para que las cifras suban: ése fue exactamente el defecto que la revisión de 02C encontró.

### 3.2 La lección más cara: verde con la vía real apagada

`safe-egress` tuvo **131 tests en verde** sin poder descargar **ninguna** URL https real, porque todos
inyectaban `deps.lookup`. Después, `prefixBytes` se fusionó pero `runtime.ts` lo descartaba. Es el mismo
defecto que 02C encontró (defecto 5) en otro eje.

**Regla para 02E (D-023):** ninguna defensa de red está probada mientras su única cobertura inyecte la
capa que puede romperse. Exige **una** prueba por la vía real y **una mutación con recompilación**.

### 3.3 Trampas confirmadas esta ronda

- **`git stash` en un worktree puede borrar ficheros rastreados** si luego haces `stash drop`. Me pasó:
  recuperé con `git checkout --`. No uses stash para «limpiar» un worktree.
- **`dist/` heredado hace vacuas las pruebas de mutación.** Recompila **siempre** entre mutar y medir.
- **El gate de sellado compara contra el *baseline* original**, no contra el head actual: en un worktree
  ya fusionado marca como violación todo el histórico del milestone. `git status --porcelain` en el
  worktree es la medida correcta; el sello captain-side con scope completo sigue siendo obligatorio.
- **El runner ACL de engine-04 no puede lanzar `npm` en este host** (`CreateProcessAsUserW Win32 2`).
  Ejecuta cada etapa **directamente** y registra los exit codes; no lo presentes como gate certificado.
- **`npx vitest` debe ejecutarse con cwd = `apps/backend`** (la config es relativa al paquete).
- Los CDN **no informan `content-length` en HEAD** (devuelven 0). Nunca trates 0 como «cabe».

### 3.4 El patrón de defecto dominante

**Culpar al contenido de una decisión de política.** Ocurrió dos veces: 64 KiB aplicados al segmento
entero (directo HD sano → `missing-segments`) y bipbop_16x9 tratado como «irreparable» cuando su
segmento era `video/MP2T` válido. Cuando una fuente sana se reporta rota, sospecha primero del
presupuesto, no del origen.

## 4. Reglas de oro (sin cambios)

1. Un escritor por worktree; worktrees solo vía `parallel-dev.mjs`.
2. Nunca `git reset --hard`, `git clean -fdx`, `checkout -f` ni push forzado.
3. Nunca fusionar sin tests reales, revisión independiente y comprobación de CI/CD.
4. Nunca inventar resultados ni afirmar que algo funciona sin exit code real.
5. Nunca escribir valores de secretos: solo nombres de variables de entorno.
6. Toda tarea de revisión nace con dependencias explícitas.
7. **Congela el SHA antes de pedir revisión; no escribas mientras te revisan.**
8. **Un defecto encontrado al ejecutar vale más que diez leídos**; y uno encontrado en el **resultado
   observable** vale más que diez unitarios.
9. **Cuando declares un `inScope`, incluye todos los ficheros que tus propias instrucciones piden**
   (me pasó dos veces en 02D y bloqueó dos tareas correctas).
