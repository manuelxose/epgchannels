# MILESTONE_STATUS — TDT-API-02A

**Estado global: IN_PROGRESS** (se actualizará a `PASS`/`PARTIAL`/`BLOCKED`/`FAIL` al cierre).

Última actualización: 2026-11-16.

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
| `tdt02a-arch` | `feat/tdt02a-arch` | architect | informes entregados |
| `tdt02a-rea` | `feat/tdt02a-rea` | rea-research | en curso |
| `tdt02a-cat` | `feat/tdt02a-cat` | catalogue | informes entregados |
| `tdt02a-sec` | `feat/tdt02a-sec` | legal | informe entregado |
| `tdt02a-base` | `feat/tdt02a-base` | captain | línea base + memoria persistente |
| `tdt02a-docs` | `feat/tdt02a-docs` | captain | reservado |

---

## Tareas

| ID | Tarea | Propietario | Ruta (clase) | Estado |
|---|---|---|---|---|
| t1 | Auditoría arquitectura/backend | architect | v4-pro (L3) | **completed** |
| t2 | Investigación REA de reproducción | rea-research | flash (L2) | en curso |
| t3 | Catálogo/M3U/plan de migración | catalogue | v4-pro (L3) | **completed** |
| t4 | Seguridad/derechos/licencias | legal | v4-pro (L4) | **completed** |
| t5 | Auditoría independiente | auditor | v4-pro (L3) | en curso |
| t6 | Revisión independiente del paquete | architect | v4-pro (L2) | pendiente (t5) |
| t7 | Integración/PR/merge | captain | flash (L2) | pendiente (t6) |

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

- **Revisión independiente: NO completada por un agente distinto.** Se intentó 6 veces con 3
  miembros (`auditor` ×2, `architect` ×2, `catalogue` ×1) más una toma de control del capitán; **todos
  los intentos de miembro terminaron sin entregable** tras turnos de duración anómala. El capitán
  completó la verificación (`AUDITORIA-INDEPENDIENTE.md`) y la revisión del paquete
  (`REVISION-INDEPENDIENTE.md`), **declarándolo como verificación del capitán, no como auditoría
  independiente de terceros**. Este criterio de aceptación queda **PARCIAL**, no PASS.
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
| Revisión **independiente** | **PARCIAL** (verificación del capitán; ver arriba) |
| Gate ENGINE-04 content-bound | **BLOCKED** (limitación del entorno, ver `MODEL_ROUTING_AND_USAGE.md §4.1`) |
| PR fusionado y SHA verificado | pendiente al cierre |
