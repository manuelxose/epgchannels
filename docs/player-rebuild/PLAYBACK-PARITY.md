# Paridad de reproducción — TDT-CLONE-10

Este documento registra, con evidencia real, qué canales del catálogo publicado se
reproducen **dentro de nuestra aplicación** y cuáles no, y por qué. La condición de
cierre del hito es reproducción real y paridad comprobada canal por canal, no que
compilen las pruebas.

## Cómo se comprueba

| Artefacto | Qué contiene | Quién lo genera |
| --- | --- | --- |
| `artifacts/playback/FULL-PLAYBACK-AUDIT.json` | Un registro por canal: datos publicados, reglas aplicadas, lo que observó el navegador y el veredicto con su causa | `scripts/playback/audit-parity.mjs` |
| `artifacts/playback/PLAYBACK-PARITY-REPORT.md` | Recuento por veredicto y límites de observación | idem |
| `artifacts/playback/PLAYBACK-FAILURES.md` | Fallos del reproductor propio con su causa | idem |
| `artifacts/playback/CHANNEL-COVERAGE.csv` | La misma información en formato de tabla | idem |
| `artifacts/playback/progress.json` | Punto de control por canal (el auditor es reanudable) | idem |
| `artifacts/playback/INDEPENDENT-VERIFICATION.json` | Muestra verificada por un procedimiento **distinto** que no confía en la auditoría | `scripts/playback/verify-independent.mjs` |

Una reproducción sólo cuenta como tal cuando el navegador, en nuestro reproductor:

1. decodifica fotogramas (`videoWidth > 0`), y
2. el tiempo de medio **avanza** durante una ventana de reloj, y
3. el estado de la interfaz es `playing` con un motor real (`hls`/`dash`).

Un manifiesto que responde, un buffer iniciado o unos metadatos disponibles **no
son** reproducción, y no se contabilizan.

## Cómo se obtiene el catálogo

`www.tdtchannels.com/lists/tv.json` no envía cabeceras CORS, así que un navegador
sirviendo nuestra aplicación desde otro origen no puede leerlo (CORS es una regla del
navegador). Las comprobaciones siembran **los mismos bytes publicados** en el mismo
origen, que es como se sirven en un despliegue real, y **nunca reescriben ni
interceptan las URLs de los medios**. La muestra independiente desactiva además los
stubs de rutas.

## Veredictos

| Veredicto | Significado | Evidencia |
| --- | --- | --- |
| `PARITY_PASS` | Nuestro reproductor decodifica vídeo y avanza el tiempo de medio durante toda la ventana de observación | navegador |
| `OUR_PLAYER_FAIL` | Hay fuente jugable autorizada, el reproductor se monta y aun así no reproduce | navegador |
| `EXTERNAL_ONLY` | El emisor sólo sirve la señal desde su propio reproductor o página | catálogo + navegador |
| `RIGHTS_BLOCKED` | Exige la aplicación del emisor (`UAG*`) o una cabecera `Referer` que no falsificamos (`REF*`) | catálogo |
| `EVENT_ONLY` | El catálogo la marca como emisión eventual | catálogo |
| `GEO_RESTRICTED` | La **propia fuente** está marcada como restringida a su región | catálogo |
| `ORIGINAL_UNAVAILABLE` | No publica ninguna señal ni página | catálogo |
| `MISCLASSIFIED` | La regla del catálogo y la aplicación discrepan: se investiga, nunca cuenta como PASS | navegador |
| `UNVERIFIED` | No hay evidencia suficiente para concluir | — |

## Reglas de autorización aplicadas

- **Una restricción de acceso del emisor manda sobre una URL que parezca jugable.**
  Un canal con `UAG`, `NONAV` o cualquier variante `REF*` (`REF`, `REFI1`, `REFC1`…)
  nunca se etiqueta «Ver en directo»: se ofrece el acceso oficial. Antes, el orden de
  las comprobaciones hacía que ETB Deportes y los canales 101TV montaran un reproductor
  sobre respuestas 403.
- **La etiqueta `GEO` del canal es un aviso, no una prueba.** RTVE marca La 1, La 2 y
  24h como `GEO` y sus emisiones se ven en esta región. Sólo el `geo2` de la propia
  fuente la marca como restringida.
- **No se evade ningún control del proveedor.** Un CDN sin cabeceras CORS es un
  rechazo del emisor, no un defecto nuestro: no se interpone ningún proxy.
- **YouTube sólo mediante el reproductor oficial incrustado** y únicamente cuando la
  URL es direccionable (canal `/live` o vídeo `/live/<id>`); jamás se extraen flujos
  internos.

## Límites de la observación

- Las conclusiones que dependen del catálogo (`GEO_RESTRICTED`, `RIGHTS_BLOCKED`,
  `EXTERNAL_ONLY`, `EVENT_ONLY`) describen la información publicada en el momento de
  la auditoría; no se reintentan canales que las reglas no permiten intentar.
- El resultado de `OUR_PLAYER_FAIL` se clasifica por la causa que devuelve el
  servidor: 404/403/400 y DNS son del emisor; CORS sin cabeceras es una política del
  proveedor.
- Las emisiones cambian: un canal que hoy no responde puede responder mañana y al
  revés. Cada ejecución deja su fecha y su huella del catálogo.
