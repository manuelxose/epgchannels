# MODULE-CONTRACT-02C — Provider Registry & Playback Eligibility

Contrato de módulos del milestone **TDT-API-02C**. Hereda `MODULE-CONTRACT-02B.md` y
`EXECUTION_CONTRACT.md`; donde haya conflicto, gana la política global (`ENGINE-01..07`) y después
este contrato, que **solo añade** restricciones.

Establecido: 2026-11-16 · rama `feat/tdt-api02-c-providers` · base `bb54ac9`.

---

## 0. Reglas duras

1. **Dos ejes, nunca colapsados.** *Autorización* (¿podemos?) y *disponibilidad* (¿responde hoy?) son
   campos y caminos separados. Un sondeo HTTP correcto **jamás** produce autorización. La autorización
   **nunca** se deriva de `reachable`/`playable`/`technicalStatus`.
2. **Fail-closed.** Autorización `unknown`/`unresolved`/ausente ⇒ **sin reproducción pública**. La
   ausencia de política no es permiso.
3. **MODO DEMO (D-016) sigue vigente para la ADMISIÓN en catálogo**, no para la ELEGIBILIDAD de
   reproducción. Una entrada de catálogo puede publicarse sin licencia; su **fuente** sólo es
   reproducible con autorización registrada. Decisión del propietario del producto (2026-11-16).
4. **Cinco valores exactos** de clasificación: `permitted-direct-playback` · `permitted-official-embed` ·
   `external-link-only` · `restricted` · `unresolved`. Ninguno más.
5. **Nada de evasión.** Prohibidos proxy CORS genérico, cabeceras fabricadas, replay de credenciales,
   y cualquier bypass de DRM, geobloqueo, autenticación o protección de firma.
6. **Sin redifusión.** Nunca proxy, grabación ni transcodificación.
7. **Sin secretos.** Sólo nombres de variables de entorno en código, tests, logs y docs. Canarios
   ficticios en tests.
8. **`/api/v1` compatible.** La elegibilidad es **aditiva**; ninguna forma de respuesta pública
   existente se rompe.
9. **Registro extensible.** Un adaptador se añade por **registro**, no editando un `switch` central.

---

## 1. Campos obligatorios por fuente

Toda fuente registrada porta, como mínimo:

| Campo | Significado |
|---|---|
| `provider` + `origin` | Proveedor y origen (host real, con `providerKind`) |
| `discoveryEvidence` | De dónde salió: upstream + snapshot + ruta + línea, o URL de documento oficial |
| `authorizedPlaybackMethod` | Método autorizado (directo / embed oficial / enlace externo / ninguno) |
| `territory` | Territorio permitido (`worldwide`, `regions[]`, o `null` = desconocido) |
| `publicationScope` | Alcance de publicación permitido |
| `restrictions[]` / `requiredAttribution` | Restricciones conocidas y atribución exigida |
| `lifecycle.state` + `expiresAt` | Ciclo de vida y caducidad |
| `validatedAt` | Última validación **técnica** |
| `authorizedAt` | Última decisión de **autorización** |
| `reviewStatus` | Estado de revisión (`unreviewed`, `verified`, `requires-written-licence`…) |

---

## 2. `provider_kind` — quién puede autorizar

| `provider_kind` | ¿Puede producir veredicto `permitted`? |
|---|---|
| `broadcaster` / `broadcaster_cdn` | Sí, con evidencia documental o licencia escrita |
| `fast_platform` | Sí, sólo por sus propios términos, y no cubre derechos subyacentes |
| `shortener` | **No** — hay que resolver el destino |
| `cdn` | **No** — sirve ficheros, no es un emisor |
| `catalogue_reference` | **No** — unlist/licencia del *fichero*, no de los streams |

Esto se codifica como **regla del gate con test**, no como convención de datos.

---

## 3. Estados de escalado

- `requires-written-licence`: operador con canal de licencia documentado (Atresmedia
  `portalventas`, CCMA, RTVA, EITB, CACVSA). **Bloqueado** pero **escalable**: una acción del
  operador puede cambiar el veredicto. No es exclusión permanente.
- `unverified`: la página legal no se pudo capturar (Mediaset, CRTVG). **No** se clasifica en ningún
  sentido hasta nueva captura.

---

## 4. YouTube como caso especial

`permitted-official-embed` con `platform: youtube` **sólo** cuando el propio emisor es titular del
canal. El permiso proviene de los términos de embed de YouTube, **no** del emisor, y **nunca**
constituye autorización de reproducción directa del stream.

---

## 5. Propiedad de ficheros (escritores disjuntos)

| Área | Propietario | Rutas |
|---|---|---|
| Registro de adaptadores, gate, tests adversarios | `adapter-engineer` | `apps/backend/src/modules/providers/`, `apps/backend/src/modules/playback/`, `apps/backend/src/catalogue/`, `packages/contracts/src/`, `apps/backend/src/migrations/` |
| Evidencia REA | `rea-investigator` | `docs/tdt-api02/REA-EVIDENCIA-02C.json`, `evidence/` |
| Integración, docs, PR y merge | capitán | `docs/tdt-api02/**` |

Un escritor nunca edita fuera de su ámbito; si lo necesita, lo **reporta** al capitán.

---

## 6. Aceptación

Ver `MILESTONE_STATUS.md`. Como mínimo: build/typecheck/unit/integration/ingestion/independence/client
en verde con exit codes reales; tests positivos **y** negativos; test central que demuestre que un
stream técnicamente sano con autorización `unresolved` **no** es reproducible; revisión independiente
`pass`; PR fusionado con SHA verificado.

---

## 7. El gate es de doble cara (verificado, no supuesto)

El gate **no** es «denegar siempre». Un veredicto permisivo exige, a la vez:

1. `basis` con derecho citable: `published-terms` **con** `quotedClause` no vacío y `clauseUrl`, o
   `written-licence` con `clauseUrl`;
2. `method` coherente con la clase (`official-embed` para la embed, `direct-playback` para directa);
3. `publicationScope: 'in-app'`;
4. `lifecycle: 'active'` y no caducado;
5. `providerKind` capaz de autorizar;
6. `territory` que cubra lo solicitado (y, si no se nombra territorio, **sólo** si es `worldwide` sin
   restricciones — una autorización limitada a un país se deniega cuando el llamante no nombra
   territorio);
7. para una fuente del emisor, `attribution` presente.

Un registro válido para una fuente del emisor, por tanto, necesita `written-licence` **y**
atribución: es una decisión deliberada, no un defecto. La revisión independiente lo confirmó con un
control positivo (fuente `available` con URL real) y 13 denegaciones por defecto individual, cada una
con el stream técnicamente sano.

Esto último demuestra la tesis del milestone: **una fuente sana y sin derecho citable no es
reproducible, y el motivo declarado es la autorización, no la disponibilidad.**

---

## 8. Evidencia: reglas de compromiso

- Las **capturas crudas de REA nunca se versionan.** Una captura de navegador de un sitio ajeno
  captura también *sus* claves: la captura de Mediaset Infinity contenía la clave de cliente de
  Firebase de un tercero en una URL de Remote Config. Aunque un identificador de cliente público no
  sea un secreto de servidor, `EXECUTION_CONTRACT §4.5/§4.9` prohíben valores de credenciales en
  informes y commits sin excepción, y no había necesidad de guardarlo.
- Se versionan sólo derivados **sin credenciales** (resumen, índice de registros, vectores) y los
  SHA-256 de los registros crudos, para poder contrastar una reproducción con los bytes analizados.
- Regla verificada por test: `.gitignore` ignora `evidence/rea02c/records/capture_*.json` y
  `evidence/rea02c/rea-session-bundle-*.json`, y **no** ignora el resumen ni el índice. El test lee
  el `.gitignore` real, de modo que estrechar la regla rompe la suite.
