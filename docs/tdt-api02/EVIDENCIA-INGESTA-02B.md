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

| Métrica | Valor |
|---|---|
| Países distintos con ISO alpha-2 resuelto | 13 006 canales (iptv-org) |
| Canales con país desconocido (`identity.country: null`) | 697 |
| Canales con idioma declarado o inferido por país | 9 781 |
| Canales con idioma `und` (honesto, sin inventar) | 5 461 |

El idioma venía ausente en el 100 % de las entradas de iptv-org (no publica `tvg-language`). Se
infiere solo para países sin ambigüedad lingüística (`catalogue-identity/language.ts`, 43 países); el
resto queda `und`. No se inventa un idioma.

## 7. Rendimiento

| Escenario | Catálogo previo | Duración | Nota |
|---|---|---|---|
| Pasada 1, iptv-org (18 756) | 0 | 10–21 s | según estado de caché de Mongo |
| Pasada 2, iptv-org (18 756) | 13 703 | 87,5 s | antes de la corrección de tokens genéricos: **199,7 s** |
| Free-TV (4 406) | 13 703 | 22,6 s | |

Perfil por etapas (pasada sobre catálogo poblado): parseo 1,03 s; lectura de identidades 0,42 s;
construcción del índice 0,39 s; reconciliación 87,0 s.

**Hallazgo abierto de rendimiento (R-02B-1):** la reconciliación sigue costando ~4,6 ms por candidato
contra 13 703 canales porque el token genérico `tv` (3 792 canales) expande el conjunto a puntuar.
No cambia ninguna decisión (equivalencia probada contra el oráculo ingenuo), pero domina el tiempo.
Detalle y estado: `MILESTONE_STATUS.md`.

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
