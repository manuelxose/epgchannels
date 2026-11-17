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


## D-017 — La autorización se persiste aparte de la disponibilidad y falla cerrada

- **Estado:** ADOPTADA (2026-11-17, 02C)
- **Contexto:** el producto ya distinguía `permission` (¿podemos?) de `technicalStatus` (¿responde
  hoy?), pero nada impedía que un stream sano y sin derecho se sirviera como reproducible. La misión
  02C exige que la autorización desconocida **impida** la reproducción pública.
- **Decisión:**
  1. La decisión de autorización vive en su propia colección (`source_authorizations_02c`) con su propio
     vocabulario, **nunca** derivada de un sondeo HTTP. El camino de autorización no importa ningún
     cliente de red.
  2. Cinco clases exactas: `permitted-direct-playback`, `permitted-official-embed`,
     `external-link-only`, `restricted`, `unresolved`.
  3. Sin registro, `unresolved` o `restricted` ⇒ **sin reproducción**. La ausencia de política
     publicada **no** es permiso.
  4. Una clase permisiva exige cita real: `isRealCitation()` requiere un URL `http(s)` absoluto y
     parseable, además de cláusula citada para `published-terms`. Una cadena centinela (`'n/a'`,
     `'editorial:registration'`) **no** cuenta.
  5. Un tipo de origen que no puede autorizar (`shortener`, `cdn`, `catalogue_reference`) nunca
     produce veredicto permisivo, **aunque** se le adjunte un registro aprobado. Es estructura, no
     convención.
- **Relación con D-016:** D-016 sigue gobernando la **admisión** en catálogo (la licencia no veta la
  entrada). D-017 añade un eje más estricto en la **fuente**: admisible ≠ reproducible.
- **Consecuencia declarada y visible para el operador:** registrar una fuente **sin** puntero a
  evidencia de licencia la deja `unresolved` y **no se reproduce**; con un puntero real, sí. Este es el
  cambio de comportamiento más importante del milestone y afecta a `POST /api/v1/admin/sources`.

## D-018 — `external-link-only` es una clase con adaptador propio, no una excepción del gate

- **Estado:** ADOPTADA (2026-11-17, 02C)
- **Contexto:** un canal que el emisor sólo publica en su reproductor debe ofrecerse como **enlace**,
  no como reproducción embebida. La primera implementación hizo un retorno temprano que concedía
  `playable: true` antes de la corroboración del adaptador; la revisión independiente señaló que eso
  saltaba las comprobaciones de clase y modalidad.
- **Decisión:** existe un adaptador real `external-link` (`grants: 'external-link-only'`, método
  `external-link`). El tipo `grants` del adaptador admite esa clase, y `satisfies()` la acepta
  explícitamente. Sin retorno temprano.
- **Consecuencia:** un derecho `external-link-only` sobre una fuente HLS sigue siendo **no**
  reproducible (clase no concedida), y una fuente externa sin derecho, `unresolved` o `restricted`
  sigue denegada. Seis tests cubren las combinaciones.

## D-019 — El operador puede auto-registrar la decisión, nunca la evidencia

- **Estado:** ADOPTADA (2026-11-17, 02C)
- **Contexto:** `POST /api/v1/admin/sources` crea fuentes; sin registrar una decisión, el gate
  rechazaría la fuente que el operador acaba de aprobar. La revisión independiente demostró que la
  primera versión acuñaba un derecho permisivo **sin evidencia** (cláusula sintética), lo que permitía
  publicar una fuente sin licencia.
- **Decisión:** el registro puede crear la decisión automáticamente, pero **no puede fabricar la
  evidencia que la hace citable**. Sin puntero a evidencia ⇒ `verdict: 'unresolved'`,
  `basis: 'none'`, `clauseUrl: null`. El estado de revisión es `pending-review`, distinto de
  `reviewed`, para que un auditor distinga un derecho auto-registrado de uno investigado.
- **Consecuencia:** un operador que registra una fuente sin evidencia obtiene una fuente **registrada
  pero no reproducible**, que es la respuesta honesta.

## D-020 — La salud de una fuente es un eje propio, con vocabulario cerrado y `lease`

- **Estado:** ADOPTADA (2026-11-17, 02D)
- **Contexto:** la misión de 02D exige verificar fuentes automáticamente y persistir su historia, sin
  que caídas de proceso marquen una fuente como sana. La exploración mostró que la colección heredada
  `source_health` tiene `_id = candidateId` y unicidad por candidato, no por `sourceId`.
- **Decisión:** la salud vive en colecciones **propias** (`source_health_checks_02d`,
  `source_health_02d`, `verification_policies_02d`); **no** se reutiliza la heredada (sería un mapeo
  silencioso). El vocabulario de resultados es cerrado (`healthy|degraded|failing|unknown|unverifiable`)
  y la **categoría de fallo** es otro vocabulario. Un check toma un `lease`; un lease vencido se
  reconcilia como `state: failed`, `outcome: unknown`, `failure.category: unknown-error`,
  `uncertainty.leaseExpired`, y la salud agregada **no se toca**.
- **Por qué:** un proceso caído no es evidencia de que el stream funcione ni de que falle. «No lo sé, y
  no lo sé porque el proceso murió» es `unknown`, y así se registra.
- **Consecuencia:** el `_id` del check es determinista (`sourceId:scheduledFor`), de modo que un
  reintento tras una caída **no duplica** trabajo ni dispara una segunda petición externa.

## D-021 — Tres presupuestos de tamaño distintos, y el tercero no es un filtro

- **Estado:** ADOPTADA (2026-11-17, 02D), tras corregir dos veces
- **Contexto:** el contrato fijaba «2 MiB manifiesto, 512 KiB segmento, 64 KiB por segmento muestreado».
  La primera implementación aplicó los 64 KiB al segmento entero: un directo HD sano se reportaba
  `missing-segments`. La segunda subió el techo a 512 KiB y siguió rechazando streams sanos (un
  segmento real medido: 1 915 156 B). **Una política de tamaño estaba diciendo «no reproducible» de una
  fuente sana.**
- **Decisión:** (1) manifiesto 2 MiB; (2) **tolerancia** de longitud declarada del segmento 4 MiB, que
  NO es filtro de admisión; (3) **sonda** de 64 KiB: los bytes realmente leídos por segmento muestreado,
  mediante `prefixBytes` en `safeFetch` (HEAD primero y lectura de prefijo acotada). El ancho de banda
  por muestra queda acotado (medido: 1 544 984 B → 65 536 B, 23× menos).
- **Consecuencia declarada:** un segmento enorme que se sirve bien se **muestrea y se reporta sano**.
  `SEGMENT_MAX_BYTES` **no** garantiza que un cuerpo sobredimensionado se rechace cuando fluye. La
  garantía que sí se mantiene es el ancho de banda por muestra. «Saludable» significa que manifiesto,
  variante y segmentos muestreados se recuperan y son del tipo correcto; **no** significa «cualquier
  tamaño es aceptable».

## D-022 — Una playlist maestra desciende exactamente un nivel

- **Estado:** ADOPTADA (2026-11-17, 02D)
- **Contexto:** la implementación inicial devolvía `degraded` con `failure: null` al reconocer un
  maestro, **sin pedir ninguna variante**. Como casi todo emisor publica un maestro, la capa de
  segmentos —la que de verdad demuestra que hay vídeo— era **inalcanzable**. El caso medido: maestro
  `200`, variante `404`; el navegador lo detectaba y el motor decía «degraded».
- **Decisión:** se sigue **exactamente una** variante (constante explícita, sin recursión). Si esa
  variante es a su vez un maestro, se registra `nested-master-not-followed` y no se pide nada más. El
  número de peticiones está acotado por construcción y hay un test que lo afirma.
- **Consecuencia:** un maestro cuya variante falla produce una **categoría de fallo nombrada**, no un
  «degraded» vacío.

## D-023 — Toda defensa necesita al menos una prueba por la vía real, sin seam inyectado

- **Estado:** ADOPTADA (2026-11-17, 02D) — la lección más cara de la ronda
- **Contexto:** `safe-egress` se entregó con **131 tests adversariales en verde** y **no podía descargar
  ninguna URL `https` pública** (`ERR_INVALID_IP_ADDRESS`): el `lookup` fijado respondía una dirección
  única y Node lo invoca con `{all:true}` exigiendo un **array**. Todos los tests pasaban porque
  **todos inyectaban `deps.lookup`**: ejercitaban la vía de prueba, nunca la de producción. En la misma
  ronda, `prefixBytes` se fusionó pero `runtime.ts` lo **descartaba** silenciosamente.
- **Decisión:** ninguna defensa de red ni capacidad de la capa de egreso se considera probada mientras
  su única cobertura inyecte la capa que puede romperse. Se exige, como mínimo, **una** prueba por
  costura crítica que recorra la ruta real (una petición real a un host público; un fixture de loopback
  sin `lookup` simulado), y una **prueba por mutación con recompilación** que demuestre que la suite
  falla cuando la defensa cae.
- **Consecuencia:** los módulos de la capa de red deben exponer su costura para poder probar la vía real,
  y el revisor independiente tiene instrucción explícita de auditar toda defensa que sólo se ejercite a
  través de un doble.
## D-024 — Catálogo abierto al propietario del producto (iptv-org íntegro)

- **Estado:** ADOPTADA (2026-11-17, ronda iptv-org) — decisión explícita del propietario
- **Contexto:** el propietario pidió incorporar el catálogo de iptv-org (18 756 entradas, 31 843 filas
  de base de canales) y, al plantearse las restricciones existentes, respondió: «todas las que
  funcionen en el catálogo, nada de restricciones». D-016 y el gate de elegibilidad limitaban la
  exposición a fuentes con autorización registrada y a orígenes capaces de autorizar.
- **Decisión:**
  1. El catálogo iptv-org se importa **íntegro** (fuentes cerradas, NSFW y con cabeceras incluidas) y
     con sus fuentes **habilitadas**.
  2. La exposición se registra como **decisión del operador**, no como permiso del emisor:
     `basis: 'written-licence'` citando literalmente la decisión y su fecha en `quotedClause`,
     `reviewStatus: 'reviewed'`, y la licencia del listado (Unlicense/CC0) en `clauseUrl`. No se afirma
     en ningún sitio que el emisor haya autorizado nada.
  3. `catalogue_reference` pasa a poder autorizar reproducción **sólo** con esa clase citable; un
     acortador o una CDN de activos estáticos siguen sin poder autorizar, porque desde ahí no se llega
     a la emisión.
  4. El contenido adulto **se etiqueta** (categoría `adultos` y marca `· adulto` en el nombre), no se
     oculta ni se excluye.
  5. El país del canal usa el **ISO real** (`countryMode: 'iso'`), en lugar de plegar todo lo no español
     en `INT` (se revisa D-010).
- **Consecuencias y límites, dichos sin adornos:**
  - El catálogo pasa de 412 a ~8 760 canales publicados en 139 países. Es cobertura real, no
    certificada: **la verificación (02D) marcará lo que no responde**, y los 90 canales que la base
    declara cerrados entrarán aunque probablemente no emitan.
  - La licencia de iptv-org cubre **la lista**, nunca la señal. El producto sigue sin proxyar, grabar ni
    transcodificar, y la atribución de cada fuente viaja con ella.
  - Es una decisión de producto del propietario y así queda registrada; una autorización de emisor
    seguiría siendo un hecho distinto y más sólido.