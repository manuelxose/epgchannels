# BEHAVIOR SPEC (contrato de comportamiento propio)

Especificación de comportamiento que **nuestra** aplicación debe cumplir. Describe
resultados observables, no implementación del original ni código de terceros.

---

## 1. Carga inicial

1. La aplicación arranca en `/` y redirige a `/television`.
2. Mientras se resuelve el catálogo se muestran **esqueletos** de 12 tiles y el
   contador en estado neutro (`Cargando canales…`).
3. Al resolverse:
   - se muestran como máximo **21 tiles**,
   - el contador anuncia `Mostrando 1–21 de <total> canales` (o `Mostrando 1–<total> de <total>` si hay menos),
   - sin canal seleccionado, la zona del reproductor muestra el estado vacío:
     título, una frase de contexto y la acción "Ver catálogo" que enfoca la barra de búsqueda.
4. Si **todas** las fuentes de catálogo fallan, se carga el catálogo de
   demostración empaquetado y se muestra un aviso `role="status"`:
   `Usando catálogo de demostración.` La aplicación nunca queda vacía.

Aceptación: contador correcto; 21 tiles visibles como máximo; aviso visible con
red bloqueada.

---

## 2. Búsqueda

1. Entrada con `aria-label="Buscar canal"` y placeholder `Buscar canal…`.
2. Filtra **en cada pulsación** sobre el nombre del canal y su categoría, sin
   distinguir mayúsculas ni acentos (`aragon` ≡ `Aragón`, `SENAL` ≡ `Señal`).
3. Normalización: se eliminan diacríticos y todo lo que no sea letra o dígito se
   colapsa a espacio. La consulta se divide en palabras y **se exige que todas
   aparezcan**, en cualquier orden (`demo 24` ≡ `24 demo`).
4. Contador con filtros activos: `1 resultado` / `N resultados`.
5. Sin resultados: estado vacío con mensaje `Ningún canal coincide con "<texto>".`,
   acción `Limpiar búsqueda`, y `role="status"` anunciando `0 resultados`.
6. La página vuelve a 1 tras cualquier cambio de filtro.

**Limitación conocida**: la búsqueda compara por **palabras**, no por subcadena
contigua. `lasexta` **no** encuentra «La Sexta», y `la1` no encuentra «La 1».
Para obtener resultados hay que escribir `la sexta` o `la 1`. Mejorar esto
(índice sin espacios) es una mejora pendiente, no cubierta hoy.

Aceptación: buscar `la 1` deja visibles los canales cuyo nombre contiene ambas
palabras; buscar `zzzz` muestra el estado vacío con su acción.

---

## 3. Categorías y favoritos

1. Selector `Filtrar por categoría` con opción inicial `Todas las categorías`.
2. Las categorías se derivan del origen de datos del ámbito, preservando su
   orden; se agrupan visualmente España / Internacional mediante `<optgroup>`.
3. Alternar favoritos filtra a la unión de canales marcados; el botón expone
   `aria-pressed` y se deshabilita si no existen favoritos.
4. Filtro favoritos vacío: `Todavía no tienes canales favoritos.` + hint
   `Pulsa el corazón de un canal para guardarlo aquí.`
5. Combinación sin coincidencias: `Ningún favorito coincide con estos filtros.`
   + acción `Limpiar filtros`.

Aceptación: marcar un canal, activar favoritos → sólo ese canal; recargar →
persiste.

---

## 4. Selección y navegación de canal

1. Un tile navega a `/television/:channelId` (enlace real; soporta clic en nueva
   pestaña y botón atrás).
2. El tile del canal activo tiene `aria-current="page"` y anillo de selección.
3. Al cambiar de canal, el panel de programa se resuelve primero desde el EPG y,
   si no está en memoria, se muestra esqueleto mientras carga.
4. El título del documento pasa a `<Canal> en directo · TDT Player`.
5. Canal inexistente: estado `Canal no encontrado` con enlace al catálogo.

Aceptación: navegación por URL directa a `/television/la-1/…` funciona; atrás
restaura el canal anterior.

---

## 5. Reproducción

Estados (`PlayerStatus`): `idle`, `loading`, `buffering`, `playing`, `paused`,
`error`, `blocked`, `unsupported`. Transiciones en `PLAYER-STATE-MACHINE.md`.

1. Elegir un canal con fuentes reproducibles crea el reproductor y llama a `play()`
   automáticamente.
2. Play/pausa alterna el elemento multimedia y actualiza el icono y `aria-label`.
3. Volumen (`input type=range`, 0–1) y mute, recordados entre canales y sesiones.
   **Cambiar el volumen o el silencio nunca recarga la emisión**: se aplica al
   motor actual sin recrearlo.
4. Pantalla completa si `requestFullscreen` existe; PiP si `requestPictureInPicture`
   existe.
5. Cambio de fuente: el selector lista una entrada por fuente **elegible**
   (`Emisión 1..N`). Al cambiar se destruye el motor anterior y se crea uno nuevo;
   la posición **no** se conserva entre fuentes distintas.
   *(El "control manual de URL" es una mejora propuesta, no implementada.)*
6. Calidad/audio/subtítulos sólo se muestran si el motor informa niveles o pistas.
7. `unsupported`: si no hay hls.js ni HLS nativo, se muestra
   `Tu navegador no puede reproducir esta emisión.` con enlace externo.
8. Errores:
   - `error` muestra el motivo, la fuente fallida y `Reintentar`,
   - los fallos recuperables se reintentan automáticamente **como máximo 2 veces**
     (esperas de 1 s y 3 s); después se muestra el error,
   - entrar en `error` **detiene y destruye el motor**, para que no siga sonando
     nada detrás del aviso,
   - `blocked` está definido en el modelo pero **aún no se emite**: las
     restricciones del emisor se resuelven como `error` con enlace externo.
9. Vigilancias: sin fotograma en 12 s, o estancado en búfer 20 s ⇒ `error` con
   acción de reintento.
10. Al desmontar o cambiar de canal se llama a `destroy()` del motor, se vacía
    `src` y se quitan los listeners.

Aceptación: cambio repetido de canal no incrementa el número de `<video>` vivos ni
conserva listeners (ver `e2e/a11y-responsive.spec.ts` y
`src/app/core/state/player.controller.spec.ts`).

---

## 6. Enrutado de estados de canal

Cada canal se clasifica en un **estado de reproducción** determinista:

| Condición del canal | Estado | UI |
| --- | --- | --- |
| Existe ≥1 fuente elegible de formato soportado | `playable` | Reproductor real |
| Sin fuentes elegibles y `EXTA`/`EXTB`/`EMB` presente | `external` | Aviso «Señal alojada fuera» + enlace al emisor + EPG |
| Sin fuentes y `NOEM` presente | `no-emission` | Aviso «De \<canal\> solo tenemos la guía» + EPG |
| Sin fuentes, sin flags conocidos | `unavailable` | Aviso genérico + EPG |
| Soporte de motor ausente | `unsupported` | Aviso + enlace externo |

La parrilla EPG y la ficha se muestran en **todos** los estados salvo `error`.

---

## 7. EPG

1. Se muestra en la ficha: **Ahora**, **Siguiente**, **Después**.
2. Los horarios se formatean en la zona horaria del navegador, con `Intl.DateTimeFormat`,
   y se muestran en el rango `HH:mm – HH:mm`.
3. Un evento es "actual" si `hi <= now < hf`. La barra de progreso = `(now-hi)/(hf-hi)`.
4. **Refresco**: la guía se solicita al cargar y cada vez que la ficha de canal
   vuelve a consultarla; hay un intervalo de 30 minutos que también actualiza el
   reloj. *(Un refresco programado independiente del ciclo de 30 min de espera no
   está verificado por prueba: ver `RECONSTRUCTION-MATRIX.md › EPG-08`.)*
5. Canal sin EPG: `Programación no disponible para este canal.` (no es un error).
6. EPG no conforme: los eventos con `hf <= hi` o sin título se **descartan** y se
   conservan los válidos. El número de descartes queda en `EpgSnapshot.rejected`
   (se registra al depurar; no hay mensaje de consola dedicado).
7. La parrilla abre un cajón con todo el día publicado del canal, marcando el
   evento actual.

Aceptación: en E2E, con una guía fija, la ficha muestra el programa en emisión y
los dos siguientes, y la parrilla lista el día completo.

---

## 8. Preferencias persistentes

| Clave | Tipo | Efecto |
| --- | --- | --- |
| `tdtpref.theme` | `'dark' \| 'light' \| 'system'` | Tema; **por defecto `dark`** |
| `tdtpref.favorites` | `string[]` | Identificadores de canales favoritos |
| `tdtpref.volume` | `number` 0–1 | Volumen recordado |
| `tdtpref.lastChannels` | `string[]` ≤ 8 | Recientes |
| `tdtpref.sourceIndex` | `Record<string,number>` | Última fuente usada por canal |

Toda lectura tolera JSON inválido (se descarta y se restablece). Si el
almacenamiento lanza (modo privado), la app sigue funcionando en memoria.

## 9. Accesibilidad

- Navegación completa por teclado con los controles nativos (enlaces, botones,
  `select`, `input`), orden lógico y foco visible.
- Las regiones de estado usan `role="status"` `aria-live="polite"`.
- Los errores del reproductor usan `role="alert"`.
- `Escape` cierra el cajón de programación.
- `prefers-reduced-motion` desactiva animaciones no esenciales.
- *(Atajos de teclado tipo `k`/`m`/`f`/`/`: **no implementados**. Serían una
  mejora futura.)*

## 10. Responsive

- `< 720px`: el reproductor va **primero** y el catálogo debajo; la navegación se
  colapsa en un menú.
- `720–1023px`: una columna, catálogo en rejilla más ancha bajo el reproductor.
- `≥ 1024px`: barra lateral del catálogo + escenario + panel de información.
- Sin desplazamiento horizontal en 320–1920 px (verificado por prueba).
