# NEXT_HANDOFF — TDT-API-02

Documento de traspaso. Se lee **antes** de empezar cualquier trabajo nuevo. Si algo aquí contradice
el estado real del repositorio, gana el repositorio: actualiza este fichero y dilo.

Última actualización: 2026-11-16 (cierre de 02A).

---

## 0. Leer primero, en este orden

1. `EXECUTION_CONTRACT.md` — reglas obligatorias (Git, agentes, seguridad, REA, tokens, pruebas).
2. `MILESTONE_STATUS.md` — dónde está el programa ahora y qué queda abierto.
3. `ARCHITECTURE.md` — qué existe de verdad, con `ruta:línea`.
4. `DECISIONS.md` — decisiones tomadas que no se reabren sin una entrada nueva.
5. `RESEARCH_EVIDENCE.md` — evidencia y sus límites.
6. `INFORME-REA-REPRODUCCION.md`, `AUDITORIA-ARQUITECTURA.md`, `INFORME-CATALOGO-M3U.md`,
   `INFORME-SEGURIDAD-DERECHOS.md`, `PLAN-COMPATIBILIDAD-MIGRACION.md`,
   `AUDITORIA-INDEPENDIENTE.md`, `REVISION-INDEPENDIENTE.md` — los informes de origen.

---

## 1. Estado al entregar 02A

- Auditoría completa de TDT-API-01 con evidencia y verificación adversarial independiente.
- Línea base reproducible: `qa/qa-manifest.json` + `scripts/preflight.mjs`, ejecutada en verde.
- Plan de compatibilidad/migración campo a campo, sin reemplazar el producto.
- **Cero cambios de comportamiento del producto.**

## 2. Qué NO se hizo (deliberadamente)

- No se corrigió ningún hallazgo de código (SEC-01, SEC-02, R2, SEC-04, SEC-08, SEC-09, SEC-13).
- No se añadió CI/CD.
- No se declaró la licencia del proyecto.
- No se ingirió ningún catálogo nuevo.
- No se ejecutaron los E2E Playwright ni `test:load`.

---

## 3. Primer trabajo recomendado: TDT-API-02B

Orden sugerido por riesgo, no por comodidad:

### 3.1 Cerrar SEC-02 — clave de servicio GuíaTV no aplicada (high)

- **Hecho verificado:** `secretMatches` solo se usa en tests; `serviceKeyEnabled` se anuncia en
  `routes.ts:317` pero ningún middleware valida `x-api-key`.
- **Trabajo:** middleware de validación en tiempo constante sobre `/integration/guiatv/*`, cerrar
  las rutas cuando la clave no esté configurada (nunca "anunciada pero abierta"), y tests de
  integración que demuestren 401 sin clave y 200 con clave válida (canario ficticio).
- **Aceptación:** test que falla si se retira el middleware.

### 3.2 Cerrar SEC-01 — SSRF (high)

- **Trabajo:** resolver DNS antes de conectar y rechazar loopback/RFC1918/link-local/ULA/metadata,
  con re-chequeo tras redirección; extender a las rutas de verificación y al job de egress.
- **Aceptación:** tests con servidor local desechable que demuestren bloqueo de `169.254.169.254`,
  `127.0.0.1` y RFC1918, y permiso para hosts públicos.

### 3.3 Resolver D-010 — `country:'INT'` vs `countryCodeSchema`

Decisión de contrato **antes** de importar catálogos internacionales. Requiere cambio de contrato
+ regeneración de SDK + actualización de OpenAPI.

### 3.4 Rendimiento R2 — `playable=true`

Sustituir el full scan en memoria (`channels.service.ts:214-216`) por paginación en BD, sin cambiar
la forma de la respuesta pública.

### 3.5 Reabrir la licencia (LIC-01) con el propietario del producto

No es una decisión de ingeniería. Sin `LICENSE` no hay publicación ni distribución legal.

---

## 4. Trampas conocidas (no volver a descubrirlas)

- **`typecheck` en frío falla.** Ejecuta `build` antes. Ver `DECISIONS D-007`.
- **`@playwright/test` está en `apps/frontend/node_modules`**, no en la raíz. Buscarlo en la raíz da
  un falso negativo.
- **El repo se llama `epgchannels`**, no `tdt-api01` ni `tdt-api02`.
- **Redis es opcional**: su ausencia no es un fallo, solo una degradación de caché.
- **Los servicios de datos son contenedores locales** ya en marcha (`tdt-api01-mongo` en 27117,
  `tdt-api01-redis` en 27118). No recrear contenedores ni borrar `infra/.data`.
- **`EGRESS_GUARD_ENABLED` no hace nada** (`bootstrap.ts:38`): no asumir que desactivarlo cambia el
  comportamiento.
- **El `INT` de `country` no casa con el contrato**: no "arreglarlo" cambiando solo el validador.

## 5. Reglas de oro para el siguiente agente

1. Un escritor por worktree; worktrees solo vía `parallel-dev.mjs`.
2. Nunca `git reset --hard`, `git clean -fdx`, `checkout -f` ni fuerza de push.
3. Nunca fusionar sin tests reales, revisión independiente y comprobación de CI/CD.
4. Nunca inventar resultados de pruebas ni afirmar que algo funciona sin exit code real.
5. Nunca escribir valores de secretos: solo nombres de variables de entorno.
6. Nunca evadir DRM, geobloqueo, autenticación o restricciones con REA.
