# EXECUTION_CONTRACT — TDT-API-02

Contrato de ejecución persistente del programa TDT-API-02. Se aplica a **cada** milestone
(`02A`, `02B`, `02C`, …) salvo que un milestone declare en su `MILESTONE_STATUS.md` una
excepción explícita y aprobada. Si algo de este documento entra en conflicto con
`~/.dsh/AGENTS.md` (ENGINE-01..07), **gana la política global**; este contrato solo añade
restricciones, nunca las relaja.

Versión: `TDT-02-CONTRACT-v1` · establecido en 02A · 2026-11-16.

---

## 1. Identidad del proyecto

| Dato | Valor |
|---|---|
| Repositorio real | `C:\Users\Admin\Documents\workspace\streaming\tdt-api01` |
| Remoto `origin` | `https://github.com/manuelxose/epgchannels.git` |
| Rama por defecto | `main` |
| Nombre del workspace npm | `tdt-platform` (monorepo: `packages/contracts`, `packages/api-client`, `apps/backend`, `apps/frontend`) |
| Runtime | Node `>=24` (verificado `v24.18.0`), npm `12.0.1` |
| Servicios de datos | MongoDB 7 (replica set `rs0`, `127.0.0.1:27117`), Redis 7 (`127.0.0.1:27118`) vía `infra/docker-compose.yml` |
| Worktrees | `C:\Users\Admin\Documents\workspace\streaming\wt\<id>` (guard: `wt/`) |

El repositorio **se llama `epgchannels`** aunque el producto se denomine TDT Platform. No renombrar
el remoto ni el directorio en un milestone: es una fuente de ruido y de errores de identidad.

---

## 2. Ciclo de vida Git obligatorio

Cada milestone sigue exactamente esta secuencia.

1. **Localizar** el repositorio y verificar `git remote -v` y la rama por defecto (`main`).
2. **Inspeccionar** el árbol de trabajo (`git status --porcelain`). **Preservar** cambios sin
   confirmar ajenos: nunca `git checkout -f`, `git reset --hard`, `git clean -fdx`.
3. **`git fetch origin --prune`** y actualizar `main` **solo fast-forward**
   (`git merge --ff-only origin/main`). Si no es fast-forward: parar y reportar.
4. **Crear la rama del milestone** (`feat/tdt-api0X-<slug>`) desde el `main` verificado, y anotar
   el SHA base en `MILESTONE_STATUS.md`.
5. **Delegar** trabajo aislado en **worktrees registrados** con `parallel-dev.mjs create`
   (nunca `git worktree add` a mano). Un único escritor por worktree.
6. **Integrar** las contribuciones validadas en la rama del milestone (staging + fast-forward).
7. **Ejecutar** tests/typecheck/build reales y obtener **revisión independiente**; crear PR.
8. **Resolver** todos los findings bloqueantes antes de fusionar.
9. **Fusionar** el PR a `main` solo con las puertas en verde.
10. **Verificar** el SHA de `origin/main` y **eliminar** los worktrees completados
    (`parallel-dev.mjs remove --merged-into`).

Reglas duras:

- **Nunca apilar milestones en ramas de features antiguas.** Cada milestone parte de `main` actualizado.
- **Antes de fusionar**, inspeccionar CI/CD para automatismos de despliegue. **Prohibido** disparar
  un despliegue a producción no autorizado. Un merge a `main` es un evento de release: si algún
  workflow despliega en producción, exige autorización explícita previa del usuario.
- Si el repositorio no tiene CI, dejar constancia en `MILESTONE_STATUS.md` y usar el gate local
  (`qa/qa-manifest.json` + `qa-evidence.mjs`).

---

## 3. Propiedad multiagente

- Un **coordinador** autoritativo (AgentTeams del capitán). Sin coordinadores paralelos.
- **Un escritor por checkout/worktree.** Los agentes que solo leen y verifican (auditor) no
  escriben en el worktree de otro especialista.
- **Separación obligatoria de funciones**: quien implementa no revisa; quien audita no redacta el
  documento que audita. La revisión independiente es obligatoria siempre que el cambio sea
  **de seguridad, de migración o de release** (todo 02B lo es).
- **Escritura compartida solo por el coordinador**: solo el capitán consolida `docs/tdt-api02/`.
- Clase de ruta registrada por tarea con la cabecera `MODEL_ASSIGNMENT` (clase L0–L4, primaria,
  escalado, motivo). Nunca sustituir una ruta en silencio.
- Un agente declara el worktree y la rama en los que trabaja; si un agente no puede escribir en su
  worktree, debe **reportarlo**, no escribir fuera de él.
- Máximo de agentes concurrentes y límites de profundidad: los de `ENGINE-02` (4 miembros, sin
  anidamiento).

---

## 4. Invariantes de seguridad (no negociables)

Derivados de la auditoría 02A (`INFORME-SEGURIDAD-DERECHOS.md`) y verificados por el capitán.

1. **Autorización antes que disponibilidad.** `permission` fuera de `PUBLIC_PERMISSIONS` o con
   condición prohibida nunca se expone, aunque la fuente esté sana (`publication-policy.ts:61-85`).
   Emisor no listado = `unreviewed` y no expuesto (`emitters.ts`).
2. **Sin SSRF.** Todo fetch saliente resuelve DNS y rechaza loopback/RFC1918/link-local/ULA/
   metadata (`127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`,
   `fe80::/10`), con re-chequeo tras redirección y re-resolución. **Hallazgo SEC-01 abierto.**
3. **Ninguna ruta "anunciada pero abierta".** Si `SERVICE_API_KEY_SHA256` está configurada, las
   rutas server-to-server exigen `x-api-key` validada en tiempo constante; si no está configurada,
   se cierran explícitamente. **Hallazgo SEC-02 abierto** (`secretMatches` solo se usa en tests).
4. **Sin redifusión.** El backend nunca proxifica, graba, transcodifica ni modifica una señal. Si
   en el futuro se añade reenvío de segmentos, exige `proxyAllowed` + autorización + auditoría.
5. **Sin credenciales en payloads ni en logs.** El descriptor de reproducción nunca transporta
   credenciales, cookies ni tokens. En informes, commits y documentación: **solo nombres de
   variables de entorno**, jamás valores.
6. **Atribución obligatoria** de todo dato de terceros (`attributionSchema`), con la licencia y
   procedencia registradas por fuente.
7. **Errores genéricos**: envelope único `{error:{code,message,details?},requestId}`; 500 sin
   detalles internos. `/health` no debe filtrar mensajes crudos de dependencias (SEC-15/R12).
8. **Superficie de operador cerrada**: `/metrics`, `/health` y endpoints de administración no
   exponen detalles internos.
9. **Secretos solo por nombre**: ninguna herramienta, log, informe o commit reproduce valores de
   secretos. Los tests de seguridad usan canarios ficticios, nunca secretos reales.
10. **Estado honesto**: nunca se inventa una emisión, un canal ni un estado de reproducción
    (`availability`, `technicalStatus` explícitos).

---

## 5. Uso de REA

- REA **ya está instalado** (`rea-agents` 6.8.0, skill `reverse-engineer-anything` v49, transporte
  MCP `dsh-mcp-client`). **Prohibido reinstalar o modificar** la integración sin una necesidad
  verificada, documentada y aprobada.
- Antes de usar REA, **leer sus instrucciones reales instaladas** y comprobar qué herramientas MCP
  están disponibles/no disponibles. No inventar capacidades.
- Ámbito autorizado: flujos de **reproductor público** (HTML5/HLS/DASH, ciclo de vida, estados de
  carga, arquitectura de la aplicación).
- **Prohibido**: evadir DRM, geobloqueo, autenticación o cualquier restricción de acceso; sortear
  paywalls; instrumentar máquinas ajenas.
- **Evidencia y duda**: cada conclusión REA se acompaña de evidencia exportada
  (`export_evidence_bundle`) y de una declaración explícita de incertidumbre y de lo no observable.
  Sin evidencia no hay conclusión.
- Preferir capturas pasivas/estáticas antes que escenarios activos; usar el navegador que gestiona
  la propia herramienta (perfil temporal), no el perfil personal del usuario.

---

## 6. Política de ahorro de tokens

- Lectura **acotada**: búsqueda por símbolo, greps dirigidos, `read` con `offset/limit`. Nunca leer
  un repositorio entero para responder una pregunta local.
- **Nunca** cargar en contexto playlists completas, volcados de red crudos ni árboles completos:
  usar scripts deterministas (`node`) que devuelvan **recuentos, formatos y muestras acotadas**.
- Los agentes devuelven al coordinador un **brief compacto**, no su razonamiento completo.
- Reutilizar el contexto ya pagado (paquete de contexto, manifiesto de arquitectura) antes de
  re-descubrirlo.
- Registrar el uso real (modelo/ruta por tarea). Los tokens son **MEDIDOS** solo si el proveedor los
  reporta; el coste monetario es **UNKNOWN** en esta instalación (`ENGINE-05`). Nunca convertir un
  contador de conversación en factura.
- Nunca ahorrar tokens saltándose un test, un typecheck, una revisión de seguridad o la revisión
  independiente.

---

## 7. Requisitos de prueba

- Todo milestone debe ejecutar, con exit code real registrado:
  `build` → `typecheck` → `unit` → `integration` → `independence` → `client`
  (declarados en `qa/qa-manifest.json`, validados con `qa-evidence.mjs verify`).
- **Orden**: `build` **antes** de `typecheck`. `@tdt/api-client` y `@tdt/backend` resuelven las
  declaraciones emitidas de `@tdt/contracts`; un `typecheck` en frío sin `dist/` falla aunque el
  código sea válido. Esto está verificado, no es una hipótesis.
- Los tests de integración e independencia requieren MongoDB (réplica) y Redis: `npm run infra:up`
  y `node scripts/preflight.mjs` (READY/NOT READY).
- **Un test que no se ejecutó no está en verde.** Un test fallido nunca se reporta como pasado.
- Los E2E de Playwright del frontend (`apps/frontend`, `@playwright/test` 1.65.0) **no** forman
  parte del gate de 02A: requieren navegadores instalados y `ng build` previo. Si un milestone los
  declara como etapa, se ejecutan de verdad; nunca se simulan resultados.

---

## 8. Decisiones de fuente y legalidad

> **MODO DEMO — decisión explícita del propietario del producto (2026-11-16).** El proyecto está en
> modo demostración: **las licencias no son una norma** y no bloquean nada. Este producto **no es
> para producción ni para distribución al público**; es una demo funcional. Las secciones siguientes
> describen el modelo **pre-demo**, conservadas como historia; lo vigente en modo demo es lo que dice
> este bloque y `DECISIONS.md` D-016.

- **En modo demo todas las fuentes se incluyen y se pueden publicar**, incluidas las que no declaran
  licencia (Free-TV, `reuse: unlicensed`). La licencia se sigue **registrando como procedencia**
  (atribución y trazabilidad), pero **nunca se usa para bloquear** una entrada del catálogo.
- El comportamiento por defecto no cambia: toda ingesta crea registros en **staging** y la publicación
  requiere una decisión explícita de operador (`promoteChannel`). Lo que ya no existe es el veto por
  licencia.
- Se mantiene **la única restricción de integridad técnica** (no de licencia): no se publica una
  fuente que exija **cabecera falsificada** (`requiresForgedHeader`) o que solo funcione en la app del
  emisor (`emitterAppOnly`). Eso no es una norma legal, es que nuestro reproductor no puede servirla
  sin fingir ser otro cliente.
- El producto **nunca** proxya, graba ni transcodifica señales.
- Prohibido importar: cabeceras falsificadas, URLs tokenizadas (se redactan, D-015),
  proxy/transcodificación.

### 8-bis. Modelo histórico (pre-demo, conservado)

- **Licencia del repositorio ≠ permiso para redistribuir el stream.** El producto **nunca** proxya
  señales.
- Fuentes upstream: TDTChannels (**Apache-2.0**, atribución obligatoria, sin dependencia de runtime),
  iptv-org (**Unlicense/dominio público**), Free-TV (**sin licencia declarada**).
- ~~**Nada se publica** desde una fuente `unlicensed`~~ — **reemplazado en modo demo por el bloque
  superior**.
- El proyecto **no declara licencia** (`README.md:66-69`): LIC-01 deja de ser precondición en demo.

---

## 9. Criterios de finalización (por milestone)

Un milestone solo puede declararse **PASS** cuando:

1. Todas las tareas requeridas del DAG están en estado terminal y los agentes inactivos.
2. `build`, `typecheck`, `unit`, `integration`, `independence` y `client` han corrido de verdad con
   exit 0, con evidencia content-bound (digests) y sin deriva posterior.
3. La **revisión independiente** emite `verdict=pass` sin findings `blocker`/`high` abiertos.
4. Los artefactos persistentes del milestone están actualizados
   (`EXECUTION_CONTRACT`, `ARCHITECTURE`, `RESEARCH_EVIDENCE`, `DECISIONS`, `MILESTONE_STATUS`,
   `NEXT_HANDOFF`).
5. El PR existe, las puertas están en verde y el merge a `main` está verificado por SHA.
6. No ha habido despliegue a producción no autorizado.
7. Los worktrees completados están eliminados.

Estado final **siempre** uno de: `PASS`, `PARTIAL`, `BLOCKED`, `FAIL` — con el motivo.
Un modelo que dice "hecho" no es evidencia; la única evidencia es el comando y su resultado real.
