# NEXT_HANDOFF — TDT-API-02

Documento de traspaso. Se lee **antes** de empezar cualquier trabajo nuevo. Si algo aquí contradice el
estado real del repositorio, gana el repositorio: actualiza este fichero y dilo.

Última actualización: 2026-11-16 (cierre de 02B).

---

## 0. Leer primero, en este orden

1. `EXECUTION_CONTRACT.md` — reglas obligatorias (Git, agentes, seguridad, REA, tokens, pruebas).
2. `MILESTONE_STATUS.md` — estado real y qué queda abierto, incluidos los 9 defectos encontrados solo
   al ejecutar.
3. `MODULE-CONTRACT-02B.md` — el contrato de módulos que gobierna toda la ingesta.
4. `EVIDENCIA-INGESTA-02B.md` — las cifras medidas, con su comando de reproducción.
5. `DECISIONS.md` — D-010 (país), D-012 (licencias), D-013 (reconciliación), D-014 (snapshots), D-015
   (redacción de credenciales).
6. `ARCHITECTURE.md`, `AUDITORIA-ARQUITECTURA.md`, `INFORME-SEGURIDAD-DERECHOS.md` — el producto
   previo.

---

## 1. Estado al entregar 02B

- Ingesta propia, sin dependencia de runtime de iptv-org, Free-TV ni TDTChannels.
- Snapshots acotados y versionados (commit SHA + `retrievedAt` + SHA-256 por fichero), fuera de Git.
- 8 conceptos separados y persistidos: canal canónico, alias, variante, candidato de fuente,
  procedencia, autorización, salud y mapeo EPG.
- Reconciliación determinista con puntuación; la incertidumbre va a **revisión manual**, nunca a fusión.
- Catálogo privado (staging) por defecto; la promoción exige una autorización aprobada y se audita.
- Migraciones `004`–`007` idempotentes y reversibles; identidades y relaciones existentes preservadas.
- Ingesta idempotente: re-ejecutar no crea canales ni candidatos nuevos.

## 2. Qué NO se hizo (deliberadamente)

- **No se publicó nada.** Todo el catálogo está en `staging`; `approved` es 0.
- No se expusieron `identity` ni las nuevas colecciones en `/api/v1` (es trabajo de 02C).
- No se añadió CI/CD (R3).
- No se declara la licencia del proyecto (LIC-01, decisión de producto): sin ella no hay publicación.
- Free-TV queda ingerido en staging y **nunca publicable** (sin licencia, D-012).

---

## 3. Primer trabajo recomendado: TDT-API-02C

Por orden de riesgo, no de comodidad.

### 3.1 Los 8 332 candidatos en revisión son trabajo de producto, no de ingeniería

La corrección TDT02B-REV-004 dejó de fusionar automáticamente los candidatos dudosos. Consecuencia:
son **8 332** (`reconciliation_review`). 02C necesita:

- una herramienta de operador que liste y resuelva la cola por lotes con sus señales
  (`score`, `signals`, `reason`);
- resolver un `review` significa o bien **confirmar** `proposedChannelId` (y entonces enlazar de verdad)
  o bien **crear un canal nuevo** (p. ej. una variante regional con su `identity.variantKey`);
- registrar quién decidió qué, cuándo y por qué (auditoría como `promoteChannel`).

**No** reutilizar el fallback por clave de identidad para "vaciar la cola": fue precisamente el defecto
que la revisión independiente encontró.

### 3.2 Cerrar SEC-02 — clave de servicio GuíaTV no aplicada (high, abierto desde 02A)

Sigue abierto: `secretMatches` solo se usa en tests y `serviceKeyEnabled` se anuncia en
`routes.ts:317` sin middleware que valide `x-api-key`. Middleware en tiempo constante + cerrar las
rutas cuando la clave no esté configurada.

### 3.3 Cerrar SEC-01 — SSRF (high, abierto desde 02A)

`infrastructure/egress.ts` resuelve DNS y bloquea rangos, pero **no se ha demostrado con tests
adversariales** desde 02A. Aceptación: servidor local desechable que pruebe el bloqueo de
`169.254.169.254`, `127.0.0.1` y RFC1918, y permiso para hosts públicos, con re-chequeo tras
redirección.

### 3.4 Exponer el catálogo global en la API pública

`identity` es aditivo y opcional. Decidir cómo se expone (campo versionado, sin romper `/api/v1`),
regenerar OpenAPI + SDK y actualizar el cliente. Revisar R2 (`playable=true` full scan) antes de crecer
el catálogo.

### 3.5 Rendimiento de ingesta como historia, no como deuda

La ingesta tarda 48,2 s para 23 162 entradas. El coste lo pone la reconstrucción del índice en
calendario de duplicación. Si 02C necesita más velocidad, el camino correcto es **indexar por clave en
O(1)** (un mapa de vistas pendientes consultado antes del índice de buckets), no rebajar la corrección
de la reconciliación. Cualquier cambio ahí debe mantener la equivalencia con `reconcileNaive`.

---

## 4. Trampas conocidas (no volver a descubrirlas)

- **`typecheck` en frío falla.** Ejecuta `build` antes (D-007).
- **`data/` no está versionado.** Para reproducir cifras: `node data/fetch-snapshots.mjs --upstream all`.
  El snapshot de iptv-org está **truncado a 400 ficheros** por `MAX_FILES` en esa herramienta.
- **El bench necesita `TDT_SNAPSHOT_DIR`** si lo ejecutas desde un worktree que no es la raíz del repo.
- **Un worktree de feature no contiene `pipeline.ts`.** La integración vive en la rama del milestone;
  t8 falló (correctamente) al intentar reparar allí. Los arreglos cross-scope son del capitán.
- **MongoDB `dropDatabase()` es asíncrono**: crear en el mismo namespace justo después falla con
  «database is in the process of being dropped». Por eso `dropDisposable` espera a que desaparezca.
- **`ingestion-metrics.mjs` distingue dos cifras de idioma**: `channelLanguageCoverage` (autoritativa,
  del canal) y `languageDeclaredByUpstream` (lo que declara la fuente, que en iptv-org es 0). No las
  mezcles.
- **Redis es opcional**; su ausencia no es un fallo.
- **El repo se llama `epgchannels`**, no `tdt-api01` ni `tdt-api02`.

## 5. Reglas de oro para el siguiente agente

1. Un escritor por worktree; worktrees solo vía `parallel-dev.mjs`.
2. Nunca `git reset --hard`, `git clean -fdx`, `checkout -f` ni push forzado.
3. Nunca fusionar sin tests reales, revisión independiente y comprobación de CI/CD.
4. Nunca inventar resultados ni afirmar que algo funciona sin exit code real.
5. Nunca escribir valores de secretos: solo nombres de variables de entorno.
6. **Toda tarea de revisión nace con `dependencies: [<tarea integradora>]`.** Aprobar un plan no valida
   su grafo: t6 se despachó sobre un árbol vacío porque no tuvo dependencia.
7. Un defecto encontrado al ejecutar vale más que diez leídos: los 9 defectos reales de 02B salieron de
   ejecutar el sistema, no de leerlo.
