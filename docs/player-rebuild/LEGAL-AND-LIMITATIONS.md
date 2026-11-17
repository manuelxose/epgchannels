# LEGAL, LIMITACIONES Y DERECHOS PENDIENTES

Este documento separa de forma explícita cuatro dimensiones que **no deben
colapsarse** en un único "PASS".

---

## 1. FUNCTIONAL CLONE — experiencia y componentes

**Estado: implementado y probado.**

La aplicación implementa el conjunto de funcionalidades observado en el original:
catálogo con búsqueda/categorías/favoritos/paginación, ficha de canal, reproductor
HLS propio con controles y estados, EPG (ahora/siguiente/después/parrilla),
estados diferenciados de canal, temas y diseño adaptativo.

El código es **original**: arquitectura propia (puertos y adaptadores, máquina de
estados, signals), CSS propio, identidad visual propia y textos propios. No se ha
copiado código, CSS, imágenes ni recursos del original.

Verificación: `docs/RECONSTRUCTION-MATRIX.md` (39 PASS, 4 PARTIAL, 2 NOT-DONE
deliberados, 1 N/A).

---

## 2. DATA COVERAGE — cobertura real del catálogo

**Estado: cobertura del 100 % del esquema publicado, con dependencia externa.**

- Fuente: `https://www.tdtchannels.com/lists/tv.json`
  (sha256 `f1ceaef3…` en la investigación).
- El adaptador consume la estructura publicada completa
  (`countries → ambits → channels`, con `options`, `extra_info`, `epg_id`).
- Del catálogo real se han medido **768 canales** (466 España, 302 internacional).
- **Riesgo**: si el esquema cambia, la validación descarta los registros no
  conformes y la aplicación informa en pantalla. No se rompe, pero la cobertura
  puede degradarse hasta el catálogo de demostración.
- **Sin caché ni respaldo offline del catálogo real**: no se almacena una copia
  del catálogo de terceros en el repositorio (decisión deliberada, ver §4).

Los datos de demostración (`public/demo/*.json`) son sintéticos y no representan
canales reales.

---

## 3. PLAYBACK COVERAGE — fuentes legítimamente reproducibles

**Estado: parcial y dependiente de condiciones externas.**

Medición objetiva (`docs/research/PLAYBACK-PROBES.json`): de una muestra
determinista de 24 fuentes HLS del catálogo público, **19 devolvieron manifiesto
válido con CORS permitido** desde este equipo. El resto:

| Situación | Qué significa | Qué hace la app |
| --- | --- | --- |
| 403 / 401 | Restricción geográfica, DRM o de derechos del emisor | Error visible con explicación y enlace al reproductor oficial |
| Timeout / DNS | Fuente caída | Reintento acotado y, si persiste, error visible |
| CORS bloqueado | El emisor no permite incrustar | Estado `unsupported` con enlace externo |

**Lo que esta aplicación NO hace y no debe hacer**: eludir geobloqueo, DRM,
autenticación, controles de acceso o protecciones anti-bot. Cuando una fuente
requiere una de esas cosas, la aplicación la muestra como no disponible aquí.

**Verificación de reproducción real** (no simulada): en Chrome 157, con
Playwright/Chromium completo y con el motor hls.js, se ha reproducido vídeo
H.264/AAC real (`readyState≥2`, `videoWidth>0`) con los medios de demostración, y
con una fuente pública real (RTVE La 1) durante la investigación.

---

## 4. INTEGRATION READINESS — preparación para GuíaTV

**Estado: preparada por diseño, sin integración realizada (fuera de alcance).**

- Sin dependencias del original ni de su infraestructura.
- Puertos y adaptadores permiten inyectar otra fuente de catálogo/EPG.
- Bundle dividido: el motor HLS (151 kB transferidos) se carga solo al abrir un
  canal; la parte inicial es ~71 kB comprimidos.
- Ver `docs/INTEGRATION-PLAN-GUIATV.md`.

**No se ha modificado el repositorio GuíaTV.**

---

## Derechos y licencias

### Código de esta aplicación

Código original de este proyecto. Sin licencia declarada todavía: **antes de
publicarlo, el titular debe elegir una licencia explícita**. No se incluye una
licencia de terceros en `src/`.

### Datos del catálogo y de la EPG

- El catálogo público de referencia se publica bajo **Apache-2.0** por su autor,
  con sujeción adicional a las condiciones de servicio del sitio que lo aloja.
- **Esta aplicación los consume en tiempo de ejecución desde su origen
  público**; no se redistribuyen ni se empaquetan en el repositorio.
- Antes de un despliegue público debe revisarse si dicho consumo encaja con las
  condiciones de servicio del proveedor. Es una decisión del titular del producto.

### Logotipos de los canales

Son marcas de sus emisores. La aplicación los muestra mediante enlace directo a
la URL publicada por el catálogo. **Para un producto público se recomienda**
sustituirlos por una representación neutra o contar con autorización.

### Señales de vídeo

No se almacena ni se retransmite ninguna señal. Se enlaza/embebe la URL publicada
por el emisor cuando esta lo permite técnicamente. Los derechos son de cada
emisor. Si un emisor solicita la retirada, basta con retirar su entrada.

### Medios de demostración

`public/demo/media/` es vídeo generado con ffmpeg a partir de patrones sintéticos
(`testsrc2`, `sine`). No contiene material de terceros.

---

## Limitaciones conocidas (honestas)

1. **"Modo cine" y "Más opciones"** del original: no se investigó su
   comportamiento; no se implementan. No se declara cobertura inventada.
2. **Subtítulos y pistas de audio múltiples**: la API y los controles existen y
   se muestran cuando el flujo las expone, pero el flujo de prueba tiene una sola
   pista, por lo que la prueba automática no cubre el cambio real de pista.
3. **Marcador de "Directo"**: implementado con `liveSyncPosition` de hls.js; no
   está cubierto por una prueba E2E porque los medios de prueba son VOD cortos.
4. **Refresco de EPG cada 30 minutos**: la lógica existe, pero no se prueba una
   espera real de 30 minutos.
5. **Geobloqueo**: no se intenta eludir. Algunas fuentes funcionarán solo en
   España y fuera de España aparecerán como no disponibles (correcto).
6. **Sin backend**: toda la lógica es de cliente. No hay proxy CORS. Si un emisor
   no permite CORS, la emisión no puede reproducirse en la app.
7. **Rendimiento**: no se ha ejecutado un perfilado Lighthouse formal; solo
   comprobaciones de tamaño de bundle y ausencia de fugas en cambios de canal.

## Pendientes antes de uso público

- [ ] Elegir y declarar la licencia del código.
- [ ] Revisar las condiciones de servicio del proveedor de datos.
- [ ] Decidir política de logotipos (autorización o reemplazo).
- [ ] Procedimiento de retirada a petición de un emisor.
- [ ] Auditoría de rendimiento con datos reales (Lighthouse/CrUX).
- [ ] Pruebas con flujos HLS con múltiples pistas de audio/subtítulos reales.
