# NEXT_HANDOFF — TDT-API-02

Documento de traspaso. Se lee **antes** de empezar cualquier trabajo nuevo. Si algo aquí contradice el
estado real del repositorio, gana el repositorio: actualiza este fichero y dilo.

Última actualización: 2026-11-17 (cierre de 02C).

---

## 0. Leer primero, en este orden

1. `EXECUTION_CONTRACT.md` — reglas obligatorias (Git, agentes, seguridad, REA, tokens, pruebas).
2. `MILESTONE_STATUS.md` — estado real y lo que queda abierto.
3. `MODULE-CONTRACT-02C.md` — el contrato del registro de proveedores y del gate de elegibilidad.
   **Este es el documento que gobierna 02C y sucesores.**
4. `AUDITORIA-ACEPTACION-02C.md` — la auditoría de aceptación del milestone, con sus limitaciones.
5. `DECISIONS.md` — **D-017 (autorización separada, falla cerrada)**, **D-018 (`external-link-only`
   con adaptador propio)**, **D-019 (el operador auto-registra la decisión, nunca la evidencia)**,
   D-016 (modo demo: licencias son procedencia) y las anteriores.
6. `RESEARCH_EVIDENCE-02C.md` y `REA-EVIDENCIA-02C.json` — qué se investigó y qué se observó de verdad.

---

## 1. Estado al entregar 02C

- **Registro de adaptadores de proveedor extensible** por registro (`register()`), con cuatro
  adaptadores reales: `broadcaster-direct`, `youtube-embed`, `official-embed`, `external-link`.
- **Autorización persistida aparte de la disponibilidad**: colección `source_authorizations_02c`. Un
  sondeo HTTP correcto **jamás** crea un derecho; el camino de autorización no tiene cliente de red.
- **Gate de elegibilidad de 8 reglas, falla cerrada**, aplicado en la ruta pública **y** en el payload
  de administración, no sólo en una función pura.
- **Cinco clases exactas**; cada fuente con proveedor/origen, evidencia de descubrimiento, método
  autorizado, territorio y ámbito, restricciones/atribución, ciclo de vida y caducidad, marcas de
  validación y autorización, y estado de revisión.
- **Cita real obligatoria**: `isRealCitation()` exige un URL `http(s)` absoluto; una cadena centinela
  no vale.
- Gate completo en verde: build 0 · typecheck 0 · unit 290 · integration 128 · ingestion 9/9 ·
  independence 15 · client 14.

## 2. Qué NO se hizo (deliberadamente)

- **No se investigó LatAm, Europa ni el resto del catálogo internacional.** No se afirma nada sobre
  ningún emisor fuera de España. Todos quedan `unresolved` y bloqueados.
- **Ninguna fuente española se declara reproducible.** Cinco operadores están `restricted` con cláusula
  citada; seis `unresolved`. Eso **es** el resultado, no un fallo.
- No se expusieron `identity` ni las colecciones nuevas en `/api/v1` como superficie aditiva nueva.
- No se añadió CI/CD (R3).
- SEC-01 (SSRF) y SEC-02 (clave de servicio) siguen abiertos, fuera del alcance de 02C.

---

## 3. Lo más importante para 02D

### 3.1 Cambio de comportamiento visible para el operador (D-019)

Registrar una fuente **sin** puntero a evidencia de licencia la deja `unresolved` y **no se reproduce**;
con un puntero real, sí. Afecta a `POST /api/v1/admin/sources`. Es el cambio más consecuente del
milestone y cualquier documentación de operador debe reflejarlo.

### 3.2 El patrón de bug que más costó esta ronda

Los cinco defectos reales de 02C **no** se encontraron leyendo código:

| # | Defecto | Cómo apareció |
|---|---|---|
| 1 | Clave de terceros en un commit de evidencia | revisión independiente |
| 2 | El fallback por operador nunca casaba | sonda adversaria contra MongoDB real |
| 3 | YouTube inalcanzable (sin `hosts`) | sonda adversaria |
| 4 | La ruta de escritura acuñaba un derecho sin evidencia | revisión independiente del diff |
| 5 | **Un stream sano sin derecho se servía como `available`** | **auditoría a nivel HTTP** |

**El defecto 5 es la lección.** `createSource` construye a través del servicio real, que ahora
auto-registra una decisión permitida. La fixture pedía una postura negativa y el registro permisivo del
**servicio** sobrevivía: **toda prueba que pedía una postura negativa afirmaba lo contrario de lo que
decía, y pasaba.** Sólo mirar el **resultado HTTP real** lo reveló.

Regla para 02D: **toda prueba que pida un estado negativo debe construir ese estado y comprobar el
resultado observable, no confiar en que un helper lo deje así.** Si un servicio auto-crea el registro
que la prueba examina, la prueba lo borra explícitamente o no prueba nada.

### 3.3 Disciplina de congelación (petición expresa del revisor independiente)

Esta ronda sufrió un árbol que se movía durante la revisión: el capitán escribió mientras el revisor
auditaba, se perdió un ciclo entero y estuvo a punto de emitirse un veredicto sobre bytes que ya no
existían. **Para 02D: confirmar y bloquear el SHA PRIMERO; revisar después.** Los cuatro primeros
defectos se habrían encontrado igual y con la mitad del trabajo.

### 3.4 Añadir un adaptador nuevo

`new ProviderAdapterRegistry([...])` o `register()`. Un adaptador declara `id`, `types`,
`providerKinds`, `requiresAuthorization`, `grants`, `method`, `territoryScope`, `attribution` y
`platform`. No hay `switch` central. Si el tipo de integración no existe, `forType()` devuelve vacío y
el gate **deniega** (falla cerrado).

---

## 4. Trampas conocidas (no volver a descubrirlas)

- **`typecheck` en frío falla.** Ejecuta `build` antes (D-007).
- **`data/` no está versionado.** Para reproducir: `node data/fetch-snapshots.mjs --upstream all`.
- **Mutar el gate para comprobar que un test muerde**: si la mutación no compila, `vitest` usa el `dist/`
  viejo y el test pasa **falsamente**. Hay que rebuildear entre mutación y ejecución, o la comprobación
  de mutación no vale nada.
- **Las capturas crudas de REA no se versionan** (contienen claves de terceros). Sólo el resumen, el
  índice y los vectores. `.gitignore` lo ignora con glob y hay un test que lo verifica.
- **`snapshot-real.unit.spec.ts` roza su presupuesto de 15 s** en la suite unitaria; bajo contención ha
  llegado a 26,9 s. Es preexistente, no de 02C.
- **La captura de navegador REA funciona**, pero algunos objetivos (RTVE: ~23 s de carga + analítica +
  consentimiento) agotan la ventana. Registrar `not_observed`, nunca «no se reproduce».
- **El repo se llama `epgchannels`**, no `tdt-api01` ni `tdt-api02`.

## 5. Reglas de oro para el siguiente agente

1. Un escritor por worktree; worktrees solo vía `parallel-dev.mjs`.
2. Nunca `git reset --hard`, `git clean -fdx`, `checkout -f` ni push forzado.
3. Nunca fusionar sin tests reales, revisión independiente y comprobación de CI/CD.
4. Nunca inventar resultados ni afirmar que algo funciona sin exit code real.
5. Nunca escribir valores de secretos: solo nombres de variables de entorno.
6. **Toda tarea de revisión nace con `dependencies: [<tarea integradora>]`.**
7. **Congela el SHA antes de pedir revisión; no escribas mientras te revisan.**
8. **Un defecto encontrado al ejecutar vale más que diez leídos**, y un defecto encontrado en el
   **resultado observable** vale más que diez unitarios.
