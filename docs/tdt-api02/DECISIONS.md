# DECISIONS — TDT-API-02

Registro de decisiones con fecha, contexto, alternativas y consecuencia. Una decisión solo se
reabre con una entrada nueva que la sustituya explícitamente; nunca se borra una decisión pasada.

Formato: `D-0NN` · fecha · estado (`ADOPTADA`, `SUSTITUIDA`, `PENDIENTE`).

---

## D-001 — 02A es una auditoría con memoria persistente, no una implementación

- **Estado:** ADOPTADA (2026-11-16)
- **Contexto:** el objetivo final es una API IPTV escalable e independiente. Tocar código antes de
  entender el producto existente arriesga romperlo.
- **Decisión:** 02A produce auditoría con evidencia, línea base reproducible, contratos de
  migración y reglas de ejecución persistentes. **Cero cambios de comportamiento del producto.**
- **Consecuencia:** los deliverable de 02A son documentación + `qa/qa-manifest.json` +
  `scripts/preflight.mjs`. Cualquier arreglo de código (SEC-01, SEC-02, R2…) pertenece a 02B.

## D-002 — Preservar el producto; no reemplazarlo

- **Estado:** ADOPTADA
- **Decisión:** el modelo existente (`ChannelDoc`, `PlaybackSourceDoc`, `ProgrammeDoc`), los
  contratos `/api/v1` y la política de publicación son canónicos. Las fuentes externas aportan
  **instantáneas con procedencia**, nunca sustituyen el modelo.
- **Consecuencia:** cualquier fuente nueva se proyecta sobre el modelo actual. Si un dato no cabe,
  se registra como hallazgo; no se fuerza una migración destructiva.

## D-003 — La licencia del repositorio no autoriza redistribuir el stream

- **Estado:** ADOPTADA
- **Decisión:** se mantiene la distinción taxativa. El producto entrega la URL del emisor y nunca
  proxifica, graba ni transcodifica. Ninguna fuente `unlicensed`, `requiresForgedHeader` o
  `emitterAppOnly` se publica jamás.
- **Evidencia:** `INFORME-SEGURIDAD-DERECHOS.md` §6; `publication-policy.ts:61-85`;
  `docs/PROVENANCE-AND-LICENCES.md:34-35`.

## D-004 — iptv-org: candidato condicionado; Free-TV: bloqueado

- **Estado:** ADOPTADA
- **Contexto:** iptv-org declara **Unlicense / dominio público** según la API de GitHub, pero su
  README muestra un badge **CC0**: las dos declaraciones deben conciliarse antes de ingerir.
  Free-TV/IPTV **no declara licencia** (`license:null`, sin archivo `LICENSE`).
- **Decisión:** iptv-org puede evaluarse en 02B **solo después** de conciliar la licencia y con
  procedencia por fuente. Free-TV queda **bloqueado**.
- **Consecuencia:** la conciliación de licencia de iptv-org es un criterio de aceptación de 02B.

## D-005 — TDTChannels permanece como fuente de referencia, no de runtime

- **Estado:** ADOPTADA
- **Decisión:** se conserva la instantánea suministrada por el operador con Apache-2.0 + atribución
  obligatoria. No se reintroduce dependencia de runtime. El parser `json-tdtchannels` se mantiene
  porque la independencia está probada por test.

## D-006 — El gate de verificación vive en el repositorio

- **Estado:** ADOPTADA
- **Contexto:** el repositorio **no tiene CI/CD** (sin `.github/`).
- **Decisión:** `qa/qa-manifest.json` (formato `engine-04-manifest/1`) declara las etapas
  obligatorias; `scripts/preflight.mjs` verifica dependencias de datos antes de declarar nada
  en verde.
- **Consecuencia:** mientras no exista CI, la verificación es manual pero **reproducible**, y un
  milestone sin esa verificación no puede declararse PASS. Añadir CI es trabajo de un milestone
  posterior (R3).

## D-007 — Orden `build` antes de `typecheck`

- **Estado:** ADOPTADA (verificada empíricamente, no inferida)
- **Contexto:** un `npm run typecheck` en frío sobre un árbol sin `dist/` **falla** (exit 2) en
  `@tdt/api-client`, porque resuelve las declaraciones emitidas de `@tdt/contracts`. Tras
  `npm run build`, el mismo comando devuelve exit 0.
- **Decisión:** el manifiesto declara `build` antes de `typecheck`. No es una relajación: es el
  orden real de dependencias del monorepo.

## D-008 — Redis es opcional y no semántico

- **Estado:** ADOPTADA
- **Decisión:** un Redis no disponible se reporta en preflight pero **no** bloquea la línea base,
  porque `config.ts:52` lo define opcional y una caída de caché nunca cambia una respuesta
  (`cache.ts:1-7`). Convertirlo en requisito duro sería una restricción inventada.

## D-009 — Hallazgos de seguridad abiertos se documentan; se corrigen en 02B

- **Estado:** ADOPTADA
- **Contexto:** la auditoría L4 identificó **SEC-01 (SSRF)** y **SEC-02 (clave GuíaTV no aplicada)**
  como `high`, y **LIC-01 (sin LICENSE)** como condicionante de publicación.
- **Decisión:** no se parchea código en 02A (D-001). Se registran como invariantes obligatorios en
  `EXECUTION_CONTRACT §4` y como criterio de aceptación de 02B.
- **Consecuencia:** **el producto no está listo para publicación** hasta cerrar SEC-01, SEC-02 y
  LIC-01. La auditoría en sí no está bloqueada.

## D-010 — `country: 'INT'` es una incompatibilidad de contrato a resolver en 02B

- **Estado:** ADOPTADA en 02B (2026-11-16) — opción (b), sin cambiar el contrato público
- **Decisión 02B:** el campo público `country` **no cambia**. Un catálogo global necesita países
  reales, así que la identidad canónica vive en `identity.country` (ISO 3166-1 alpha-2 **o `null`
  cuando el país es genuinamente desconocido**), y `identity.scope` expresa
  `national | regional | local | international`. El `country` de primer nivel se queda como
  agregado de compatibilidad (`'ES'` para España, `'INT'` para el resto), que **no** es una
  afirmación de nacionalidad. Nada se inventa: si el upstream no declara país, `identity.country`
  es `null` y el registro entra en revisión manual.
- **Por qué (b):** (a) habría metido un pseudopaís `INT`/`INTL` en un campo que los clientes usan
  como país, y `INTL` ni siquiera casa con `countryCodeSchema`; romper el contrato en 02B exigiría
  regenerar SDK y OpenAPI por una necesidad que se resuelve con un campo nuevo.
- **Consecuencia:** `identity` es aditivo y opcional para registros antiguos; `countryCodeSchema`
  y la forma de `/api/v1` no se tocan en 02B. La decisión de exponer `identity` en la API pública
  es de 02C.

## D-010-bis — Contexto original (conservado)
- **Contexto:** el importador escribe `country: 'ES' | 'INT'` (`catalogue-import.ts:226`,
  `migration-executor.ts:172`), pero `countryCodeSchema` exige `^[A-Z]{2}$`
  (`packages/contracts/src/common.ts:29-31`). `INT` cumple el patrón (3 letras), `INTL` **no**.
  Verificado por el capitán.
- **Opciones:** (a) añadir un código agregado explícito en el contrato; (b) mapear a un campo
  `scope` separado. Ambas requieren cambio de contrato + regeneración de SDK.
- **Consecuencia:** 02B debe decidirlo **antes** de importar catálogos internacionales.

## D-011 — Las correcciones se prueban con canarios, nunca con secretos reales

- **Estado:** ADOPTADA
- **Decisión:** los tests de seguridad (SSRF, API key) usan canarios ficticios y servidores locales
  desechables. Ningún secreto real se envía fuera del host ni aparece en evidencias.

## D-012 — Licencia de iptv-org conciliada: dominio público; Free-TV sigue bloqueado

- **Estado:** ADOPTADA (2026-11-16, 02B)
- **Evidencia medida (no inferida):**
  - `https://api.github.com/repos/iptv-org/iptv` → `license.spdx_id: "Unlicense"`.
  - `LICENSE` en `master` descargado y leído: texto literal de *Unlicense* («This is free and
    unencumbered software released into the public domain»), 1 235 bytes.
  - El README muestra un badge CC0. **Ambas declaraciones son renuncias a derechos**, no exigen
    atribución y permiten copiar, modificar y redistribuir. La contradicción aparente no cambia el
    derecho de reutilización; se registra la discrepancia en la procedencia de la fuente.
  - `https://api.github.com/repos/Free-TV/IPTV` → `license: null`; `LICENSE` en `master` → **HTTP
    404**. Sigue sin licencia declarada.
- **Decisión original:** iptv-org se ingiere en la **catalogación privada (staging)** con procedencia
  completa y queda **elegible para publicación** solo tras autorización del emisor
  (`SourceAuthorization` + `publication-policy`). Free-TV se ingiere **exclusivamente en staging**
  y era **nunca publicable** (`reuse: unlicensed`).
- **Estado:** **SUSTITUIDA PARCIALMENTE por D-016** (modo demo, 2026-11-16). La parte de Free-TV queda
  revocada: en modo demo sí se publica. La evidencia de licencias se conserva porque sigue siendo dato
  de procedencia.
- **Consecuencia:** D-004 queda resuelta para iptv-org; para Free-TV, D-016 la reemplaza.

## D-016 — MODO DEMO: las licencias no son una norma y no bloquean la publicación

- **Estado:** ADOPTADA (2026-11-16) — decisión explícita del propietario del producto.
- **Contexto:** el producto está en modo demostración, no destinado a producción ni a distribución al
  público. Tratar la licencia de terceros como bloqueo impedía demostrar el catálogo global completo.
- **Decisión:**
  1. **Todas las fuentes se incluyen y se pueden publicar**, incluidas las que no declaran licencia
     (Free-TV). Se elimina el veto `licence-not-publishable` de `catalogue/authorisation.ts`.
  2. La licencia **sigue registrándose** (snapshot, candidato, fila de auditoría de la promoción) como
     **procedencia y atribución**, nunca como condición de admisión.
  3. Se mantiene el único veto **técnico** (no legal): no se publica una fuente que exija cabecera
     falsificada o que solo funcione en la app del emisor, porque nuestro reproductor no puede
     servirla sin fingir ser otro cliente.
  4. La ingesta sigue creando **staging** por defecto; publicar sigue exigiendo una decisión
     explícita de operador.
- **Por qué no se borra D-012:** una decisión no se borra, se sustituye con una entrada nueva. D-012
  permanece como historia del razonamiento y como registro de la evidencia de licencias.
- **Consecuencia e implicación declarada:** en modo demo el proyecto puede contener y servir listados
  de fuentes sin licencia declarada. **Eso no sería aceptable en producción ni en distribución
  pública**; si el producto sale de modo demo, D-012 debe reactivarse antes de publicar nada.

## D-013 — Política de reconciliación: incertidumbre va a revisión, nunca a fusión

- **Estado:** ADOPTADA (2026-11-16, 02B)
- **Decisión:** la asignación de un *source candidate* a un canal canónico es determinista y
  puntuada. Tres bandas: `different` (< `REVIEW_THRESHOLD`), `review` (entre umbrales), `same`
  (≥ `SAME_THRESHOLD`). Solo `same` crea vínculo automático; `review` encola
  `ReconciliationReview` para una persona. **Un calificador regional o local distinto fuerza
  `review` y jamás `same`**, aunque el nombre coincida al 100 %.
- **Por qué:** el fallo más caro del producto sería fundir una emisora autonómica o local con otra
  (información falsa al usuario, pérdida de identidad irrecuperable en el histórico). Un falso
  duplicado en revisión cuesta trabajo manual; una fusión incorrecta cuesta credibilidad.
- **Consecuencia:** la puntuación y sus señales se publican en el informe
  (`INFORME-INGESTA-02B.md`) y cada decisión guarda sus señales para auditoría posterior.

## D-015 — La URL de un candidato se guarda redactada; la credencial no entra en la BD

- **Estado:** ADOPTADA (2026-11-16, 02B)
- **Contexto:** t1 detectó URLs con `userinfo` (`user:pass@host`) y con parámetros de tipo token en
  los listados upstream. `EXECUTION_CONTRACT §4.5` prohíbe credenciales en payloads y logs.
- **Decisión:** al construir el candidato se eliminan `userinfo` y los valores de query con pinta de
  token, y el candidato queda con `authRequired` (bandera `UNPUBLISHABLE_FLAGS`). El hash y la clave
  de idempotencia se calculan sobre la URL **normalizada y ya redactada**, así que dos capturas del
  mismo enlace producen el mismo `_id` sin que la contraseña se guarde nunca.
- **Alternativa descartada:** guardar la URL completa para "poder reproducirla más adelante". Un
  sistema que no va a proxificar la señal no necesita un secreto ajeno almacenado, y guardarlo
  convierte cualquier volcado de la colección en una filtración.
- **Consecuencia:** un emisor que exige credencial no puede publicarse desde nuestro catálogo; su
  candidato existe solo como evidencia de procedencia. Si 02C necesita el valor original, se relee
  del snapshot en el momento, nunca de la base de datos.

## D-014 — Los snapshots upstream viven fuera de Git y son la única entrada de ingesta

- **Estado:** ADOPTADA (2026-11-16, 02B)
- **Contexto:** el producto no puede depender de GitHub en runtime, y el volumen de los listados
  upstream (≈4 MB y creciendo) haría insostenible el repositorio además de repartir datos ajenos sin
  necesidad.
- **Decisión:** `data/fetch-snapshots.mjs` (herramienta de mantenimiento, único punto con red)
  captura directorios inmutables `data/snapshots/<upstream>-<fecha>/` con `manifest.json`
  (commit SHA, `retrievedAt`, licencia, SHA-256 por fichero). `data/` **no se versiona**. La ingesta
  consume exclusivamente un snapshot verificado; un digest que no casa rechaza el snapshot completo.
- **Consecuencia:** reproducir las cifras del milestone exige recapturar (o pedir el snapshot); el
  `manifest.json` del snapshot usado se adjunta en la evidencia del milestone con su digest.

