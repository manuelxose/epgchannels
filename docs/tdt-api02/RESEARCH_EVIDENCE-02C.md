# RESEARCH_EVIDENCE — TDT-API-02C

Investigación de fuentes oficiales de reproducción (t1). Complementa `RESEARCH_EVIDENCE.md` (02A/02B)
y `REA-EVIDENCIA-02C.json` (observación de navegador).

Última actualización: 2026-11-16 (02C, t1 · intento `d0ef0cdb`).

> **Regla de lectura.** Esto es evidencia de **autorización publicada**, no de disponibilidad técnica.
> Que un manifiesto HLS responda 200 no autoriza nada. La ausencia de política publicada **no** se
> interpreta como permiso: se clasifica `unresolved` y bloquea la reproducción.
>
> Método: GETs públicos anónimos únicamente a páginas legales/de política del operador. **No** se
> sondeó ningún manifiesto de stream, **no** se falsificaron cabeceras, **no** se reprodujeron
> credenciales y **no** se evadió geobloqueo. Cada cita proviene de la URL exacta indicada. Lo que no
> se pudo capturar figura como **no verificado**, nunca inferido.

---

## 0. Línea base medida del catálogo (no inferida)

Fuente: snapshot `data/snapshots/iptv-org-20261116T145323Z` (commit `61b5e2a`, `retrievedAt`
2026-11-16T14:53:23Z), ficheros `streams/es*.m3u`.

| Fichero | Entradas |
|---|---:|
| `es.m3u` | 307 |
| `es_pluto.m3u` | 137 |
| `es_rakuten.m3u` | 36 |
| `es_samsung.m3u` | 3 |
| `es_yowi.m3u` | 0 |
| **Total** | **483** |

- **191 hosts distintos** para 483 entradas; 483/483 declaran `tvg-id`.
- **48** entradas llevan el marcador explícito `[Geo-blocked]` del upstream.

Reproducción: `node data/profile-es-sources.cjs <snapshotDir>` (herramienta de mantenimiento; `data/`
no se versiona, D-014).

---

## 1. Taxonomía de `provider_kind` (no colapsar)

| Host | Qué es realmente | ¿Puede autorizar? | `provider_kind` |
|---|---|---|---|
| `jmp2.uk` (137/483 = 28 %) | **Acortador de URL**; las entradas son redirecciones de procedencia desconocida | **No** | `shortener` — resolver, registrar destino, descartar como evidencia |
| `cdn.jsdelivr.net` (7) | **CDN de assets estáticos** | **No** | `cdn` |
| iptv-org, Free-TV, TDTChannels | Referencias de catálogo | **No** (Unlicense cubre el *fichero de playlist*, no los streams) | `catalogue_reference` |
| `rtvelivestream*.rtve.es`, `ztnr.rtve.es` | CDN operado por RTVE | Sólo vía licencia de RTVE | `broadcaster_cdn` → dueño = RTVE |
| `directes-tv-*.3catdirectes.cat` | Operado por CCMA/3Cat | Sólo vía licencia de CCMA | `broadcaster_cdn` → dueño = CCMA |
| `cdn1.etbon.eus` | Operado por EITB | Sólo vía licencia de EITB | `broadcaster_cdn` |
| Pluto / Rakuten / Samsung TV Plus / Yowi | Operadores FAST (distribuidores licenciados, no emisores) | Sólo por sus propios términos | `fast_platform` |

**La estructura de una URL nunca es evidencia de autorización.** Alcanzabilidad = *disponibilidad*,
eje distinto de *autorización*: es exactamente la separación que 02C exige.

---

## 2. España — operadores oficiales

| # | Proveedor (titular) | Host(s) | Embed oficial público | Método autorizado | Política publicada — cita literal (URL) | Territorio | Atribución | Veredicto |
|---|---|---|---|---|---|---|---|---|
| ES-1 | **RTVE** — La 1, La 2, RTVE Play | `rtvelivestream.rtve.es`, `rtvelivestream-rtveplayplus.rtve.es`, `ztnr.rtve.es` | Manifiestos referenciados por terceros; **sin API/embed oficial publicada** | Desconocido — nada publicado | Reserva de derechos: «Cualquier ejercicio de los anteriores derechos… requiere autorización previa y por escrito» — [rtve.es/comunes/aviso_legal.html](https://www.rtve.es/comunes/aviso_legal.html). Los términos RSS prohíben redistribución («los contenidos no pueden ser redistribuidos, retransmitidos, suministrados, ni cedidos a terceros por medio alguno») pero rigen **sindicación de texto**, no vídeo. El **embedding no se menciona** | Algunas entradas restringidas por derechos, elemento a elemento | Sin marcas/logos de RTVE sin permiso escrito | **unresolved** |
| ES-2 | **Mediaset España** — Telecinco, Cuatro, Mitele/Infinity | CDN no verificado | Desconocido | Desconocido | **NO VERIFICADO.** `mediaset.es/aviso-legal/`, `/legal/aviso-legal.html`, `telecinco.es/legal.html`, `cuatro.com/avisolegal.html`, `mediasetinfinity.es/aviso-legal/` → 404 o shells JS. Sin cláusula capturada: no afirmar en ningún sentido | Desconocido | Desconocido | **unresolved** |
| ES-3 | **Atresmedia** — Antena 3, laSexta, Neox, Nova, Mega, Atresplayer | CDN de atresplayer (no verificado) | Desconocido; **embedding prohibido contractualmente** | Ni el enlace externo: §1.2 prohíbe «linkados»; sólo licencia escrita vía portalventas | §1.2: «no podrán ser reproducidos, copiados, pegados, linkados, transmitidos, distribuidos o manipulados de cualquier forma… sin la autorización previa y por escrito de Atresmedia». §1.4: «Queda prohibido establecer frames o marcos de cualquier tipo que envuelvan al Portal o permitan la visualización de sus contenidos a través de direcciones de Internet distintas a las del propio Portal» — [statics.atresmedia.com/sites/assets/legal/legal.html](https://statics.atresmedia.com/sites/assets/legal/legal.html). Canal de licencias: `portalventas.atresmedia.com` | Sin restricción publicada | Avisos de copyright intactos; sin patrocinio implícito | **restricted** |
| ES-4 | **laSexta** (Atresmedia) | = ES-3 | = ES-3 | = ES-3 | Mismo aviso legal que ES-3 | = ES-3 | = ES-3 | **restricted** |
| ES-5 | **Cuatro** (Mediaset) | = ES-2 | = ES-2 | = ES-2 | = ES-2 (no verificado) | = ES-2 | = ES-2 | **unresolved** |
| ES-6 | **3Cat** — TV3, SX3, 3/24 (CCMA) | `directes-tv-cat.3catdirectes.cat`, `directes-tv-int.3catdirectes.cat` | Reproductor oficial 3Cat; sin API de embed publicada | Desconocido — nada publicado | «en queda prohibida la còpia, la comunicació pública, la distribució, la comercialització o qualsevol altra activitat amb una finalitat o ús públic… si no es compta amb un consentiment exprés» — [3cat.cat/avis-legal/que-oferim/](https://www.3cat.cat/avis-legal/que-oferim/). Carve-out estrecho: «Podràs inserir determinats continguts als teus blogs o a d'altres espais web, sempre que… no es causi confusió… i no es manipuli de cap manera cap element identificatiu de l'autoria» — [condicions-utilitzacio-del-portal](https://www.3cat.cat/avis-legal/condicions-utilitzacio-del-portal/). Cubre **insertar contenido publicado**, no la reproducción en directo de una parrilla de agregador | Existe feed internacional (`directes-tv-int`) → algunos canales se publican internacionalmente; no es una concesión de licencia | Marcas de autoría inalterables | **restricted** |
| ES-7 | **Canal Sur** — CanalSur TV, Andalucía TV (RTVA) | `canalsur.es` / CanalSur Más | Reproductor oficial; sin API de embed | Desconocido | «Cualquier reproducción, transmisión, adaptación, traducción, modificación, comunicación al público, o cualquier otra explotación comercial o no… está expresa y estrictamente prohibida, salvo autorización expresa previa y por escrito de RTVA» — [canalsur.es/enlaces-legales/normas-de-uso/](https://www.canalsur.es/enlaces-legales/normas-de-uso/) | No publicado | «Únicamente se autoriza a los usuarios la utilización personal y privada» — la atribución es irrelevante porque el uso está vedado | **restricted** |
| ES-8 | **ETB** — ETB1, ETB2, ETB Basque (EITB) | `cdn1.etbon.eus` | Reproductor oficial; sin API de embed | Desconocido | «Los Usuarios pueden hacer uso privado del Sitio Web y de sus Contenidos, si bien, en ningún caso podrán hacer uso comercial del mismo, ni alterar sus elementos, reproducirlos más allá de su uso privado, distribuirlos o comunicarlos públicamente» — [eitb.eus/es/aviso-legal/](https://www.eitb.eus/es/aviso-legal/) §3 | No publicado | Avisos de copyright intactos (§3) | **restricted** |
| ES-9 | **TVG** — TVG, tvG2 (CRTVG/CSAG) | `crtvg.es` | Desconocido | Desconocido | **NO EXTRAÍDO** — `crtvg.gal/aviso-legal` y `crtvg.es/aviso-legal` devolvieron shell sin cuerpo | Desconocido | Desconocido | **unresolved** |
| ES-10 | **À Punt** — À Punt TV/Ràdio (CACVSA) | `apuntmedia.es` | Reproductor oficial; sin API de embed | Desconocido | «queden expressament prohibides la reproducció, distribució i comunicació pública, inclosa la modalitat de posada a disposició… amb finalitats comercials… sense l'autorització prèvia de l'CACVSA» y «En cap circumstància s'entendrà que es concedeix cap llicència» — [apuntmedia.es/condicions-d-us/](https://www.apuntmedia.es/condicions-d-us/) | No publicado | Ninguna ofrecida | **restricted** |

Nota sobre ES-6: el carve-out de blogs de CCMA es el **único** texto permisivo hallado entre los ocho
operadores. Es estrecho (insertar contenido en un blog, sin confundir autoría) y **no** se extiende a
un servicio de reproducción de parrilla de canales. Se registra como excepción documentada con su
alcance exacto **sin** promover el veredicto de 3Cat.

---

## 3. Plataformas FAST / agregadores

| # | Proveedor (titular) | Host | Embed oficial | Método autorizado | Política publicada — cita (URL) | Territorio | Atribución | Veredicto |
|---|---|---|---|---|---|---|---|---|
| FAST-1 | **Pluto TV** (Pluto TV Europe GmbH / Paramount-Skydance) | `pluto.tv` + redirecciones `jmp2.uk` | Sin embed documentado para terceros | Como mucho enlace externo | §4: servicios «deben ser utilizados únicamente para su uso personal no comercial… no cedible»; «Usted no deberá… distribuir, difundir, transmitir o circular a terceros (incluyendo… en o a través de un sitio web de terceros)… sin el consentimiento previo por escrito de Pluto». §6 prohíbe uso comercial «mediante el establecimiento de enlaces» y el scraping — [legal.paramount.com/es/es/plutotv/terms-of-use](https://legal.paramount.com/es/es/plutotv/terms-of-use) | Términos por región (variante España); disponibilidad de canales variable | No implicar respaldo | **restricted** |
| FAST-2 | **Rakuten TV** | canales FAST de rakuten.tv | Sin embed publicado | Desconocido | Sin política de integración localizada. **No verificado** | Desconocido | Desconocido | **unresolved** |
| FAST-3 | **Samsung TV Plus** | destinos de `jmp2.uk` | Sin embed publicado | Desconocido | Sin política de integración localizada. **No verificado** | Desconocido | Desconocido | **unresolved** |
| FAST-4 | **Yowi** (0 entradas) | — | — | — | Nada que evaluar | — | — | **unresolved** |

Las FAST son **distribuidores licenciados**, no emisores: sus catálogos están sublicenciados, así que
ni siquiera un permiso de plataforma cubriría por sí solo los derechos del canal subyacente.

---

## 4. LatAm / Europa / internacional

No investigado en esta pasada por acotación de presupuesto (España + FAST + taxonomía). **No se
afirma nada** sobre ningún emisor latinoamericano, europeo o internacional. Todo host no español del
snapshot de 400 ficheros queda **`unresolved` → bloqueado**, con nota de muestra representativa y
**no** de enumeración: el patrón aquí establecido (el aviso legal del operador reserva los derechos de
comunicación pública; no hay política de integración publicada) es el **prior esperado**, pero es un
prior, **no evidencia**, y no puede usarse para clasificar a un emisor concreto.

---

## 5. Resultado principal

**Ningún operador español ni plataforma FAST publica una política que autorice a un agregador tercero
a reproducir sus canales en directo.** Cero candidatos alcanzan `permitted-direct-playback` o
`permitted-official-embed` con evidencia publicada.

El único camino contractual encontrado es una **solicitud de licencia por escrito** (Atresmedia
`portalventas`, CCMA, RTVA, EITB, CACVSA), que es una acción de contratación, no técnica.

### Consecuencia honesta

Esto no es un fallo de la investigación: es el resultado correcto. La misión pide «maximizar la
cobertura legítima»; la evidencia demuestra que la cobertura legítima **publicada** es cero para
estas fuentes, y por eso el registro debe servir `unresolved`/`restricted` → bloqueo fail-closed.
Inventar autorización para «tener algo verde» sería exactamente el defecto que el milestone existe
para prevenir.

---

## 6. Consecuencias de implementación

1. **Fail-closed no es una formalidad: es el resultado completo de España.** Todos los hosts deben
   caer en `authorization = unknown` (o `restricted`) y quedar bloqueados.
2. Forma por fuente: `authorizationRecord { sourceUrl, quotedClause, verdict, retrievedAt, territory,
   operatorId, providerKind }`. La autorización persistida **nunca** se deriva de `reachable`/`playable`.
3. Estado de escalado **`requires-written-licence`** para ES-3/ES-4 (portalventas), ES-6 (CCMA),
   ES-7 (RTVA), ES-8 (EITB), ES-10 (CACVSA): tienen canal de licencia documentado, luego una acción
   del operador puede cambiar el veredicto. Están bloqueadas, **no** excluidas para siempre.
4. ES-1 (RTVE), ES-2/ES-5 (Mediaset), ES-9 (CRTVG) necesitan una **pasada de evidencia de
   seguimiento** (texto legal no capturado / no aborda el embedding) antes de afirmar veredicto. Que
   un revisor posterior no confunda «no se citó prohibición» con permiso.
5. `jmp2.uk`, `cdn.jsdelivr.net`, iptv-org/Free-TV y TDTChannels deben ser **estructuralmente
   incapaces** de producir un veredicto `authorized`. Se codifica como test del gate, no como
   convención.
6. **YouTube IFrame** es la única vía técnicamente viable para estos canales, y sólo cuando el propio
   emisor es dueño del canal: ese permiso proviene de los términos de embed de YouTube, **no** del
   emisor, y debe registrarse como `permitted-official-embed` acotado a `platform: youtube`, **nunca**
   como autorización de reproducción directa.

---

## 7. Restricciones y atribución registradas

- Toda fuente `restricted` exige identificación del emisor si en algún momento se muestra como enlace
  externo (`external-link-only`).
- Las entradas con `[Geo-blocked]` se registran con `territory` restringido y no deben intentarse
  fuera de su territorio.
- Ninguna fuente de este informe permite proxy, grabación ni transcodificación.

---

## 8. Evidencia de navegador (REA) — qué se observó y qué no

Índice completo: `REA-EVIDENCIA-02C.json`; registros por captura en `evidence/rea02c/records/`.

**Interpretación de capacidad corregida.** Un primer intento de captura falló por *deadline* y se
atribuyó a una limitación del host. **Era falso**: la ruta de captura funciona. El fallo era
específico del objetivo (RTVE tarda ~23 s en cargar y sólo emite analítica y consentimiento). Se
corrige aquí porque una limitación mal atribuida se propagaría a futuros milestones.

| Objetivo | Estado | Lo observado |
|---|---|---|
| **CCMA / 3Cat TV3** | **observado** | HLS sobre segmentos `.ts` con **Bitmovin** en Chromium vía MSE (`<video src=blob:>`); `master.m3u8` → `bitrate_3.m3u8` + `bitrate_7.m3u8` → `geo-br3_<seq>.ts`, todo HTTP 200 en `directes3-tv-es.3catdirectes.cat`. La respuesta de media lleva el **nombre** de cabecera `access-control-allow-origin` (valor no retenido). **Sin** interfaz de embed/iframe del emisor ni postMessage: sólo consentimiento TCF e iframes publicitarios. Sin error de autoplay/geo/DRM en pantalla. DRM y códecs **no observables** (cuerpos no seleccionados) |
| RTVE La 1 | cargado, **media no observado** | 23 s de carga; sólo logs de Conviva/OneTrust/Gigya; ninguna inicialización de reproductor |
| Mediaset Infinity (`mitele.es`) | cargado, **media no observado** | `cookieWall` + Didomi; contenedor de reproductor vacío; ningún `<video>`, ninguna petición de media. El consentimiento **no** se otorgó por automatización |
| Atresplayer Antena 3 | cargado, **media no observado** | Sólo el shell de la SPA; `playTresLivePlayer`/FreeWheel/PAL/Conviva cargados; sin petición de media. El `embedUrl` de su schema.org `VideoObject` es la propia URL de la página: **declarado, no verificado** |
| Canal Sur directo | cargado, **media no observado** | Captura de DOM únicamente (red no seleccionada); página bCube NX que referencia `window.jwplayer`; sin `<video>` |
| ETB, CRTVG, À Punt, LatAm/Europa | **no intentado** | Fuera del presupuesto acotado |

**`not_observed` no significa «no se reproduce».** Significa que dentro de la ventana acotada no se
observó media. Ninguna conclusión sobre el tipo de reproducción, DRM o geobloqueo de esos cinco
operadores puede inferirse de la estructura de sus URLs.

**Consecuencia para el registro.** Sólo la reproducción de 3Cat está respaldada por observación. No
obstante su **veredicto no cambia**: sigue siendo `restricted`, porque su condición jurídica viene de
`3cat.cat/avis-legal/...` (§2), no de que el stream responda. Esto es exactamente la separación de
ejes: *que se pueda reproducir técnicamente* (observado) ≠ *que esté autorizado* (prohibido).


---

## 9. Redacción de las capturas REA (defecto encontrado en revisión independiente)

Los **registros crudos** de captura REA (`evidence/rea02c/records/*.json`) **no se versionan**. Motivo
concreto y verificado: la captura de Mediaset Infinity contiene, en una URL de Google Remote Config,
la **clave de cliente de Firebase de un tercero** (proyecto `rtispa-ott-esp`). Se trata de un
identificador de cliente público por diseño, no de un secreto de servidor, pero el contrato
(`EXECUTION_CONTRACT §4.5` y `§4.9`) prohíbe **valores** de credenciales en informes y commits sin
excepción para claves públicas, y no había necesidad de almacenar el identificador ajeno.

Un segundo motivo, independiente: esos ficheros son volcados completos de página y red de sitios de
terceros (~44 000 líneas). No se auditó exhaustivamente su contenido más allá de las comprobaciones
de credenciales, así que no se afirma que estén limpios.

**Lo que sí se versiona y es verificable:** `captures-summary.json` (resumen derivado, sin
credenciales), `records/index.json` (mapa `evidence_id` → fichero), `reference-vectors.json` y los
scripts auxiliares. El SHA-256 de cada registro crudo queda registrado en `REA-EVIDENCIA-02C.json`
para poder comprobar una reproducción contra los bytes exactos analizados.

Comprobación de ausencia en los artefactos versionados: **0** claves `AIzaSy*`, **0** cabeceras
`Authorization`/`Bearer`, **0** valores `Set-Cookie`, **0** identificadores de sesión, **0**
`access_token`/`id_token`.

**Lección para 02D:** una captura de navegador de un sitio ajeno captura también las claves de ese
sitio. La redacción debe aplicarse en el momento de la captura, no después; y un fichero de
evidencia no es «sin credenciales» sólo porque el resumen lo sea.
