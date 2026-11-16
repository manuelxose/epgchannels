# RUTAS DE MODELO Y USO REAL — TDT-API-02A

Registro de la ruta asignada y **del uso realmente observable**. No se ha inventado ninguna cifra:
lo que no está disponible se declara `UNKNOWN` / `NO_OBSERVADO`.

Fecha: 2026-11-16. Política aplicable: `ENGINE-05` / `ENGINE-02 §6.2` / `~/.dsh/AGENTS.md §12.6`.

---

## 1. Asignaciones

| Rol | Miembro | Proveedor / modelo | Clase | Motivo |
|---|---|---|---|---|
| Capitán / coordinación | `lead` | `deepseek-official` / `deepseek-flash` | L0–L2 | Coordinación, redacción de memoria persistente, operaciones Git deterministas |
| Arquitectura y backend | `architect` | `deepseek-official` / `deepseek-v4-pro` | L3 | Auditoría cross-module sobre 65 ficheros TS |
| REA y reproducción web | `rea-research` | `deepseek-official` / `deepseek-flash` | L2 | Investigación acotada con herramientas MCP, sin código de producción |
| Catálogo / M3U / upstreams | `catalogue` | `deepseek-official` / `deepseek-v4-pro` | L3 | Análisis de compatibilidad y migración cross-source |
| Seguridad / derechos / licencias | `legal` | `deepseek-official` / `deepseek-v4-pro` | L4 | security-critical y release-sensitive; exige revisión independiente |
| Auditoría independiente | `auditor` | `deepseek-official` / `deepseek-v4-pro` | L3 | Verificación adversarial de terceros |

Esfuerzo de razonamiento observado en el runtime del equipo: `reasoning: high` para todos los
miembros (valor por defecto del modelo de destino; no se forzó un `effort` distinto).

**Sin escalados.** No se recurrió a Claude Code ni a Codex: ningún trabajo alcanzó la condición de
escalado (fallo repetido de la ruta barata, o necesidad de otra familia de modelos). No se sustituyó
ninguna ruta en silencio.

---

## 2. Rutas ejecutadas frente a rutas asignadas

Las rutas anteriores son las **asignadas** por el capitán y confirmadas por el estado del equipo
(`.agent-teams/tdt-api02a/team.json`: `provider` + `model` por miembro). La verificación de la ruta
**ejecutada** debe hacerse contra metadatos del arnés (sesión), no contra el autorreporte del modelo.

- Rutas ejecutadas verificadas por metadatos del arnés: **NO_OBSERVADO** en este registro
  (el estado del equipo no expone la traza de peticiones por miembro).
- No se afirma ninguna ruta ejecutada que no esté respaldada por metadatos.

---

## 3. Tokens y coste

| Concepto | Estado |
|---|---|
| Tokens de entrada/salida por miembro | **UNKNOWN** — el estado del equipo no publica muestras de uso (`usage: null` en los 5 miembros) |
| Tokens cacheados | **UNKNOWN** |
| Coste monetario | **UNKNOWN** — el adaptador instalado no lee metadatos de coste del proveedor (`ENGINE-05 §9.4`) |
| Herramientas externas (Claude/Codex) | No usadas → sin coste de suscripción asociado |

**Regla respetada:** el contador de conversación del arnés **no** se ha convertido en factura. No se
reporta ningún importe.

---

## 4. Herramientas realmente invocadas

| Herramienta | Uso en 02A |
|---|---|
| `AgentTeams` (este equipo) | Coordinación, DAG, calidad y archivo |
| `parallel-dev.mjs` (ENGINE-03) | Creación de 6 worktrees registrados; sellado y retirada |
| `qa-evidence.mjs` (ENGINE-04) | `manifest-check` → OK |
| MCP `rea__*` | Inventario de capacidades y herramientas de navegador/bundle (detalle en `RESEARCH_EVIDENCE.md E-07`) |
| `pwsh`, `read`, `write`, `grep`, `glob` | Inspección acotada y ejecución real de tests |

### 4.1 Limitación real del gate ENGINE-04 en este host (declarada, no oculta)

`qa-evidence.mjs verify` **no pudo ejecutar las etapas** en esta sesión: las cinco devolvieron
exit `127` con `windows-acl-run: CreateProcessAsUserW failed (Win32 2)`. Causa identificada leyendo
el propio motor (`qa-evidence.mjs:144-152`): el runner de sandbox se resuelve vía
`process.resourcesPath` (solo válido dentro del host Electron); bajo un host Node puro cae a una ruta
por defecto que **no existe** en esta instalación (comprobado: no hay
`@deepseek-ai/dsh-sandbox-windows-acl` en `resources/` ni en `.dsh/`). El motor lo detecta y marca
`sandboxFailure`, y la evidencia queda **inválida** (no se ha usado para declarar nada).

**Consecuencia honesta:** el milestone tiene verificación **ejecutada de verdad y reproducible**
(comandos reales del manifiesto con exit codes), pero **sin evidencia content-bound sellada** por el
motor ENGINE-04. Estado del gate: **BLOCKED por falta de capacidad del entorno**, no por un fallo
del código. No se ha fabricado ni simulado ninguna evidencia.

Remediación aplicada: se conserva el manifiesto y el `verify` queda documentado como reproducible
desde un host con el runner disponible (sesión del escritorio Electron). Se recomienda ejecutar
`qa_gate` (`operation=verify`) desde ahí antes de un release.

## 5. Skills invocadas (sin inventar disponibilidad)

Se aplicaron **como política**, no como carga formal por `skill`:

- Arranque **Ponytail** (ya activo en el contexto del arnés) para el estilo de cambios mínimos.
- Política **ENGINE-07 #11** de contexto eficiente (lectura acotada, scripts deterministas).

Skills del catálogo **no invocadas** y por qué: `office*`, `seo*`, `core-web-vitals`,
`web-quality-audit`, `ui-ux-pro-max`, `web-design-guidelines`, `accessibility` no aplicaban a una
auditoría de backend/documentación. `reverse-engineer-anything` describe el uso de REA que ejecutó
el miembro `rea-research` con las herramientas MCP directamente.
