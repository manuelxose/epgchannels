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

- **Estado:** PENDIENTE (decisión de 02B)
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
