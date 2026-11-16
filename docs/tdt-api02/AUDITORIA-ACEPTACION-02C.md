# AUDITORÍA DE ACEPTACIÓN — TDT-API-02C

Auditoría de aceptación contra el contrato de misión del milestone. **Esta auditoría es del
CAPITÁN, no independiente.** Se declara así explícitamente para no confundirla con la revisión
independiente, que sí existió para el código (ver §5).

- Árbol auditado: `HEAD = 80fb91575168f0bf6968d74d9aebe2e5825b0d59` (`80fb915`), `TREE = 33e6e424…`,
  `git status --porcelain` vacío.
- Rama: `feat/tdt-api02-c-providers`.
- Fecha: 2026-11-17.

---

## 1. Tabla de aceptación

| # | Criterio de la misión | Estado | Evidencia |
|---|---|---|---|
| 1 | Integraciones reales de proveedor donde la autorización y las pruebas lo permiten | **PASS** | 4 adaptadores reales en `adapter.registry.ts`: `broadcaster-direct`, `youtube-embed`, `official-embed`, `external-link`. Registro extensible por `register()`, sin `switch` central |
| 2 | Evidencia documentada por integración aceptada | **PASS** | `RESEARCH_EVIDENCE-02C.md` (cláusulas literales por operador con URL) + `REA-EVIDENCIA-02C.json` |
| 3 | Casos no soportados reportados con transparencia | **PASS** | 6 operadores `unresolved`, 5 `restricted`; Mediaset y CRTVG marcados **NO VERIFICADO** y sin clasificar. Cero fuentes españolas declaradas reproducibles |
| 4 | Autorización persistida separada de la disponibilidad | **PASS** | Colección propia `source_authorizations_02c`; `technicalStatus` permanece en el documento de fuente. El camino de autorización no importa cliente de red |
| 5 | Cada fuente con todos los campos exigidos | **PASS** | `AuthorizationRecord`: operatorId + providerKind, `DiscoveryEvidence`, `method`, `TerritoryScope` + `publicationScope`, `restrictions[]` + `attribution`, `lifecycle` + `expiresAt`, `validationTimestamp`, `authorizationTimestamp`, `reviewStatus`. Verificado por `operator-seeds.unit.spec.ts` |
| 6 | Cinco clases exactas | **PASS** | `eligibilityClassSchema` = `permitted-direct-playback`, `permitted-official-embed`, `external-link-only`, `restricted`, `unresolved`. Test de exhaustividad (5 casos) |
| 7 | Autorización desconocida impide la reproducción pública | **PASS (verificado por mutación)** | Test nuevo a nivel de API pública (`public-api.integration.spec.ts:357`): sin derecho / `restricted` / `unresolved` ⇒ `unavailable` + `url: null`; con derecho ⇒ `available`. **Mutación**: quitar `isEligibleSource` del filtro de `buildDescriptor` ⇒ el test FALLA (`expected available to be unavailable`); restaurado ⇒ verde |
| 8 | Sin proxy CORS genérico, cabeceras fabricadas ni replay de credenciales | **PASS** | Grep del módulo `providers/`: cero `fetch(`, `setHeader`, `Authorization:`, `x-api-key`, `Cookie`, `X-Forwarded`. Las únicas coincidencias son nombres de campo, la restricción `NO_PROXY` y la lista de hosts de YouTube. 17 tests de ausencia en `security.unit.spec.ts` |
| 9 | Documentación persistente y siguiente traspaso actualizados | **PASS** | `MODULE-CONTRACT-02C.md`, `RESEARCH_EVIDENCE-02C.md`, `REA-EVIDENCIA-02C.json`, `MILESTONE_STATUS.md`, `NEXT_HANDOFF.md`, `DECISIONS.md` |
| 10 | Revisión independiente de seguridad y derechos | **PARCIAL** | t5 (`needs_revision`, 5 findings, todos reparados) y t8 (`PASS`) los emitió el auditor independiente, pero sobre árboles **anteriores**. **No existe veredicto independiente de aceptación para `80fb915`** |

---

## 2. Etapas del gate (ejecutadas realmente)

| Etapa | Exit | Resultado |
|---|---|---|
| `build` | 0 | OK |
| `typecheck` | 0 | OK |
| `unit` | 0 | **290 tests** |
| `integration` | 0 | **128 tests** |
| `ingestion` | 0 | **9/9** escenarios |
| `independence` | 0 | **15 tests** |
| `client` | 0 | **14 tests** |

---

## 3. Defectos encontrados en esta ronda (5, todos reparados)

| # | Cal. | Defecto | Cómo se encontró | Corrección |
|---|---|---|---|---|
| 1 | blocker | Clave de Firebase de un tercero en un commit de evidencia | Revisión independiente (t5) | Capturas crudas fuera de Git **y del historial** de la rama (reescritura); `.gitignore` con glob |
| 2 | high | El fallback por operador no casaba: consultaba `sourceUrl` mientras las filas guardan la página de cita | Sonda adversaria contra MongoDB real | Consulta por `_id` (`operator:<id>`) |
| 3 | medium | `YOUTUBE_PLATFORM_SEED` sin `hosts`: la única integración permitida era inalcanzable | Sonda adversaria | `YOUTUBE_PLATFORM_HOSTS` con igualdad exacta |
| 4 | blocker | La ruta de escritura podía acuñar un derecho permisivo **sin evidencia** (cláusula sintética) | Revisión independiente (t6, sobre el diff sin confirmar) | Sin evidencia ⇒ `unresolved` + `basis: none` + `clauseUrl: null`; `hasCitableRight` exige ahora un URL `http(s)` real y absoluto |
| 5 | **blocker** | **Un stream sano sin derecho, `restricted` o `unresolved` se servía como `available` con URL**, porque `createSource` pasa por el servicio real que auto-registra una decisión permitida y la fixture no la eliminaba | **Auditoría de aceptación del capitán a nivel HTTP** | `deleteForSourceId()`; la fixture elimina la decisión antes de aplicar una postura negativa. Test permanente a nivel de API, **verificado por mutación** |

**El defecto 5 es el más importante de la ronda.** Ningún test unitario ni de integración lo detectó:
toda prueba que pedía una postura negativa estaba afirmando lo contrario de lo que decía, y pasaba.
Solo una comprobación sobre el **resultado HTTP real** lo reveló.

---

## 4. Limitaciones declaradas

1. **Sin veredicto independiente para el árbol final.** t5 y t8 son independientes pero sobre árboles
   anteriores. La auditoría de este documento es del capitán.
2. **La captura de navegador REA sólo se observó para 3Cat TV3.** RTVE, Mediaset, Atresplayer y Canal
   Sur cargaron sin petición de media dentro de la ventana y constan como `not_observed`, **no** como
   «no se reproduce». ETB, CRTVG, À Punt y toda muestra LatAm/UE no se intentaron.
3. **LatAm, Europa e internacional no se investigaron.** No se afirma nada sobre ningún emisor fuera
   de España; todos quedan `unresolved` y bloqueados.
4. **Mediaset y CRTVG sin clasificar** (páginas no capturadas). No se afirma permiso ni prohibición.
5. **`file:line` de los defectos 1–4** se refiere a versiones anteriores del árbol; el contenido vive en
   los commits posteriores de la rama.

---

## 5. Revisión independiente obtenida (histórico)

| Tarea | Veredicto | Árbol | Resultado |
|---|---|---|---|
| t5 | `needs_revision` | `48d9a87` | 5 findings (TDT02C-REV-001..005), todos reparados |
| t8 | `pass` | `fc0d4f5` | Re-verificación independiente: matriz de operadores contra MongoDB real, control positivo descriptivo, 14 denegaciones, mutación del cableado, ausencia de capturas en árbol e historial |

Además, el auditor **se corrigió a sí mismo** cuando una sonda suya dio un falso positivo (declaró
`www.youtube.com.attacker.example.org` jugable por inyectar el registro saltándose el repositorio, y
lo rectificó tras re-ejecutar por el camino real). Ese comportamiento es el que se quiere de un
revisor.

---

## 6. Veredicto de aceptación (capitán)

**PASS con una limitación declarada.**

Los 9 criterios verificables están cubiertos con evidencia ejecutada; el criterio 10 (revisión
independiente) está cubierto para el código por t5 y t8 pero **no para el árbol exacto** que se
entrega. Se declara en vez de ocultarse. Si la organización exige un veredicto independiente sobre el
árbol final, debe obtenerse antes de considerar el milestone cerrado del todo.
