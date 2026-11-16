# EVIDENCIA DE INGESTA — TDT-API-02B

Cifras obtenidas por **ejecución real** contra MongoDB real (`127.0.0.1:27117`, replica set `rs0`)
con los snapshots capturados el 2026-11-16. Cada número es reproducible con el comando indicado.
Ningún dato de esta página es estimado.

---

## 1. Snapshots utilizados (D-014)

| Upstream | Commit SHA | Capturado | Ficheros | Entradas |
|---|---|---|---|---|
| iptv-org | `61b5e2ace91b35262d830e60cd266a9df64e3b1e` | 2026-11-16T14:53:23Z | 400 (de 466 listas; límite `MAX_FILES`) | **18 756** |
| Free-TV | `dcc6ca561f4ee666508ccdc0ae00091bf23764dd` | 2026-11-16T14:56:04Z | 99 (todas) | **4 406** |

Reproducción: `node data/fetch-snapshots.mjs --upstream all`, después
`node apps/backend/dist/scripts/ingest-catalogue.js --snapshot <dir>`.

**Honestidad sobre la cobertura:** el snapshot de iptv-org está **truncado** por un límite explícito
de 400 ficheros (`MAX_FILES` en `ingestion/snapshot.ts`). 18 756 entradas son las de esos 400
ficheros, **no** el total del repositorio. La truncación se registra en `manifest.json`
(`truncated: true`, `totalPlaylistPathsInRepo`) y no se presenta como cobertura completa.

---

## 2. Ingesta — primera pasada sobre catálogo vacío (iptv-org)

| Métrica | Valor |
|---|---|
| Entradas importadas | 18 756 |
| Líneas rechazadas (con motivo y línea) | 20 |
| **Canales canónicos creados** | **13 703** |
| Canales en staging | 13 703 (100 %) |
| Canales aprobados/publicables | **0** |
| Duplicados detectados | 0 (no había catálogo previo) |
| Sin coincidencia (nuevos) | 18 736 |
| En revisión manual | 0 (no había catálogo previo) |
| Alias `tvg-id` registrados | 12 352 |
| Duración | **21,3 s** (≈ 880 entradas/s) |

## 3. Ingesta — segunda pasada sobre el MISMO catálogo (idempotencia)

| Métrica | Pasada 1 | Pasada 2 | Lectura |
|---|---|---|---|
| Entradas importadas | 18 756 | 18 756 | igual |
| **Canales NUEVOS creados** | 13 703 | **0** | **idempotente** |
| Canales canónicos | 13 703 | 13 703 | sin cambio |
| Candidatos | 18 756 | 18 756 | sin cambio |
| Duplicados detectados | 0 | 15 268 | ahora sí hay catálogo contra el que comparar |
| Revisión manual | 0 | 3 467 | preguntas nuevas, no repetidas |
| Filas de `ingestion_runs` | 1 | 2 | una fila por ejecución (no se sobrescribe) |

**Conclusión:** re-ejecutar no crea canales nuevos ni candidatos nuevos. Las 3 467 revisiones de la
pasada 2 no son repeticiones: son candidatos que en la pasada 1 crearon canal y ahora, al existir el
catálogo, se puntúan como coincidencia parcial.

## 4. Dos fuentes → un canal (la invariante central)

Medido tras ingerir ambas fuentes en la misma base:

| Métrica | Valor |
|---|---|
| Canales con al menos un candidato | 15 242 |
| **Canales que reciben fuentes de AMBAS fuentes** | **641** |
| Canales con una sola fuente | 14 601 |
| Canales con mismo nombre+país pero **separados** (posible estación dividida) | **0** |

Comprobación aritmética: 13 703 (iptv-org) + 1 539 (nuevos de Free-TV) = 15 242; de ellos 641 están
compartidos. **Ninguna estación de las dos fuentes se contabilizó como dos canales.**

Muestra real de canales con fuentes de ambas fuentes:

| Canal | Fuentes | Nombres vistos |
|---|---|---|
| `cafbcbd7…` | free-tv + iptv-org | `TRT World`, `TRT World [Not 24/7]`, `TRT World HD` |
| `ef415f11…` | free-tv + iptv-org | `Radio Italia Trend` |
| (R9) | free-tv + iptv-org | `R9`, `R9 [Not 24/7]` |

## 5. Free-TV: ingerido, nunca publicable (D-012)

| Dato | Valor |
|---|---|
| Licencia registrada | `reuse: unlicensed` |
| Entradas | 4 406 |
| Canales nuevos creados | 1 539 |
| Estado de todos esos canales | `staging` |
| Canales publicados | **0** |

## 6. Cobertura

Cifras leídas de la colección `channels` (el catálogo de registro), no de los scripts de medición:

| Métrica | Valor |
|---|---|
| Canales con país ISO alpha-2 resuelto | **13 006** (139 países distintos) |
| Canales con país genuinamente desconocido (`identity.country: null`) | 697 |
| Canales con idioma conocido | **8 740** (10 idiomas distintos) |
| Canales con idioma `und` (honesto, sin inventar) | 4 963 |
| Canales sin documento `identity` | **0** |

Idiomas principales: `en:2725 es:1419 ru:829 de:588 it:397 pt:388 fr:356 sv:255 tr:207 nl:202`.
Países principales: `US:2571 RU:829 IN:825 DE:550 IT:397 CN:391 ES:377 FR:356`.

El idioma venía ausente en el **100 %** de las entradas de iptv-org (no publica `tvg-language`). Se
infiere solo para países sin ambigüedad lingüística (`catalogue-identity/language.ts`, 43 países); el
resto queda `und`. No se inventa un idioma.

**Corrección de una medición errónea:** `ingestion-metrics.mjs` informaba `languageCoverage.distinct: 0`
porque contaba solo el idioma **declarado por el upstream** en el candidato, no el idioma efectivo
resuelto en el canal. Un cero que contradice los datos es un fallo de medición; se ha pedido al
especialista separar «declarado por la fuente» de «conocido en el catálogo» y usar el segundo como
autoritativo.

## 7. Rendimiento

| Escenario | Catálogo previo | Duración | Entradas/s | Nota |
|---|---|---|---|---|
| Pasada 1, iptv-org (18 756) | 0 | **8,7 s** | ≈ 2 156 | crea 13 703 canales |
| Pasada 2, iptv-org (18 756) | 13 703 | **28,3 s** | ≈ 663 | idempotente, 0 canales nuevos |
| Free-TV (4 406) | 13 703 | 22,6 s | ≈ 195 | primera versión, antes de la corrección |

Perfil por etapas de la pasada 2 (medido, `data/profile-stages.cjs`): parseo 1,40 s; lectura de
identidades 0,57 s; construcción del índice 0,43 s; reconciliación 28,03 s = **1,49 ms por
candidato** contra 13 703 canales.

### Historia de la optimización (todas las cifras medidas)

La reconciliación empezó con un recorrido lineal **y un reordenamiento del array completo en cada
llamada**: 108,5 ms por llamada con 4 000 canales. Una ingesta completa tardaba **más de 10 minutos**
y empeoraba con el catálogo. Correcciones sucesivas, cada una verificada contra el oráculo ingenuo:

| Corrección | Coste por llamada | Pasada 2 completa |
|---|---|---|
| Línea base (escaneo + reordenamiento) | 108,5 ms (4 000 canales) | > 600 s (abortada) |
| Índice por key/token/tvg-id/host | 4,64 ms (13 703) | 199,7 s |
| País como filtro, no como expansor | 4,64 ms | 87,5 s |
| Corte de tokens genéricos (`tv`: 3 792 canales) | **1,49 ms** | **28,3 s** |

**Decisión de equivalencia:** en cada paso se comprobó `reconcileIndexed === reconcileNaive` y que
las decisiones finales no cambiaran (13 703 canales, 15 268 duplicados, 3 467 revisiones, 0 nuevos)
antes y después.

**Nota de revisión del capitán:** la justificación escrita del corte genérico afirmaba que un token
genérico nunca puede alcanzar `review` (0,475 < 0,55). Eso **omite el peso del host** (0,10): la cota
real es 0,575, por encima del umbral. La implementación sigue siendo correcta porque el host y el
tvg-id se recogen siempre por sus propios índices, pero la razón escrita era incompleta; se pidió
corregir el comentario y añadir el caso como test.

## 8. Rollback

| Comprobación | Resultado |
|---|---|
| `--rollback <runId>` de la pasada 2 | exit 0 |
| Registros eliminados | **0** |
| Canales de la pasada 1 tras el rollback | 13 703 → **13 703** (intactos) |
| Candidatos de la pasada 1 tras el rollback | 18 756 → **18 756** (intactos) |

Antes de la corrección, el rollback de la pasada 2 **borraba los 18 756 candidatos de la pasada 1**,
porque la pasada 2 reescribe filas idénticas. El run ledger ahora registra solo lo que **insertó**.

## 9. Comandos reproducibles

```
node data/fetch-snapshots.mjs --upstream all
node apps/backend/dist/scripts/ingest-catalogue.js --snapshot data/snapshots/iptv-org-<ts>
node apps/backend/dist/scripts/ingest-catalogue.js --snapshot data/snapshots/free-tv-<ts>
node apps/backend/dist/scripts/ingest-catalogue.js --rollback <runId>
node apps/backend/scripts/ingestion-scenario.mjs      # escenarios (t4)
node apps/backend/scripts/ingestion-bench.mjs         # rendimiento (t4)
```

---

## 10. Medición completa del bench (ambos upstreams, ejecutado)

`node apps/backend/scripts/ingestion-bench.mjs` → **exit 0**

| Métrica | Valor |
|---|---|
| Entradas medidas | **23 162** (18 756 iptv-org + 4 406 Free-TV) |
| Ingesta en frío | 24 526 ms |
| **Throughput** | **944,4 entradas/s** |
| Migraciones | 1 779 ms |
| Verificación + parseo | 720 ms |
| Pico de RSS | 355,63 MiB |
| Total del proceso | 27 463 ms |
| Canales canónicos | **15 242** |
| Staging / aprobados | 15 242 / **0** |
| Candidatos (reconciled/duplicate/rejected) | 15 242 / 7 880 / 40 |
| Fuentes por canal (media/máx) | 1,52 / 44 |
| Países distintos | 140 (14 360 conocidos, 882 desconocidos) |
| Idiomas distintos | 30 (9 781 conocidos, 5 461 `und`) |
| Revisión manual | 2 060 |
| Alias | 13 968 |
| Base de datos eliminada | `true` (verificado listando bases después) |

## 11. Aislamiento staging→público y puerta de autorización (ejecutado)

**Aislamiento probado con el filtro real del listado público** (`editorialStatus: 'published'`,
`mergedInto: null`):

| Comprobación | Resultado |
|---|---|
| Canales tras ingerir 18 756 entradas | 13 703 |
| `editorialStatus: 'published'` | **0** |
| `editorialStatus: 'draft'` | 13 703 |
| `catalogueState: 'staging'` | 13 703 |
| Servidos por el listado público | **0** |

**Puerta de autorización probada de extremo a extremo** (`promoteChannel`):

| Intento | Resultado | Motivo |
|---|---|---|
| Sin autorización | rechazado | `authorisation-missing` |
| Autorización `pending` | rechazado | `authorisation-not-approved` |
| `approved` pero requiere cabecera falsificada | rechazado | `conditions-prohibited` |
| `approved` y limpia | **promovido** | — |

Tras la promoción: `catalogueState: 'approved'`, `editorialStatus: 'published'`, `reviewedAt`
presente, 1 canal publicado y 1 fila de auditoría. **La ingesta no puede publicar**: crea `draft` +
`staging`, y solo una decisión de autorización registrada y validada promueve un registro.

**Nota de honestidad:** el modelo `SourceAuthorization` existía desde t3 pero **nadie lo consumía**.
La promoción estaba bloqueada solo porque la ingesta escribe `draft`. Eso es bloqueo, no
autorización. `catalogue/authorisation.ts` cierra esa brecha y se prueba arriba.
