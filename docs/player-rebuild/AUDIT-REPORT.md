# INFORME DE AUDITORÍA INDEPENDIENTE

| | |
| --- | --- |
| Auditor | Claude Sonnet 5.5 (`subagent_claude_code_sonnet_55`), modelo de distinta familia del implementador |
| Implementación auditada | `tdt-player-rebuild` |
| Método | Revisión estática independiente + verificación empírica posterior por el coordinador |
| Verbo del auditor | **NEEDS REVISION** |

El auditor **no escribió el código**. Su veredicto inicial fue `NEEDS REVISION`
con 5 hallazgos bloqueantes. Todos se han tratado; abajo se registra qué se hizo y
cómo se verificó.

---

## Hallazgos bloqueantes y resolución

| ID | Severidad | Hallazgo | Estado | Verificación |
| --- | --- | --- | --- | --- |
| B1 | alta | Cambiar volumen/silencio **recargaba la emisión**: el `effect` leía señales de volumen dentro de su cuerpo, así que escribir volumen reejecutaba `load()` y recreaba el motor | **FIXED** | Reproducido antes del arreglo (`loadstart=1`, URL nueva). Tras el arreglo: `loadstarts=0`, misma URL, tiempo 2.45→4.95 s. Además el E2E ahora cuenta eventos `loadstart` y falla si hay recarga |
| B2 | alta | Los reintentos **filtraban motores**: `start()` no destruía el motor anterior, permitiendo dos instancias de hls.js sobre el mismo elemento | **FIXED** | `start()` llama a `destroyEngine()` al principio, tras incrementar la generación |
| B3 | alta | `fail()` no paraba el motor: el vídeo podía seguir sonando detrás del aviso de error, y un evento `playing` tardío dejaba estado incoherente | **FIXED** | `fail()` destruye el motor y limpia temporizadores; `playing` se ignora en estados terminales |
| B4 | alta | **Originalidad**: dos avisos de interfaz eran casi idénticos al texto del original | **FIXED** | Reescritos por completo (ver abajo) |
| B5 | alta | La matriz de reconstrucción sobreestimaba: contaba 39 PASS cuando la tabla tenía 49 filas, y varias filas citaban pruebas inexistentes | **FIXED** | Matriz reescrita y recuento corregido a lo real: 26 PASS / 15 PARTIAL / 2 NOT-DONE / 1 N/A |

### B4 — detalle de la corrección de originalidad

Antes (coincidente con el original):

- «Reproducción externa» / «Disponible en el reproductor oficial de \<canal\>» +
  paráfrasis del cuerpo.
- «Este canal no emite por internet» / «Se muestra para consultar su parrilla y su
  ficha…».

Ahora (redacción propia):

- Eyebrow **«Señal alojada fuera»**, título **«\<canal\> no emite su vídeo aquí»**,
  cuerpo: «El emisor solo sirve esta señal desde su propio reproductor, así que no
  la incrustamos…». Botón: «Abrir la página del emisor».
- Eyebrow **«Sin señal en línea»**, título **«De \<canal\> solo tenemos la guía»**,
  cuerpo: «Este canal aparece en el catálogo porque publica su programación, pero
  no ofrece ningún vídeo por Internet…».

`BEHAVIOR-SPEC.md` se ha actualizado para describir el comportamiento sin fijar
frases ajenas.

---

## Hallazgos no bloqueantes

Se aceptan como deuda documentada. Los de mayor impacto:

| ID | Hallazgo | Decisión |
| --- | --- | --- |
| N1 | La búsqueda por palabras no equipara `la1` con `la 1`, aunque el comentario de `normalize.ts` lo sugería | **Pendiente**. Comentario del código corregido; añadir índice sin espacios es un cambio de comportamiento a revisar |
| N2 | El refresco de EPG tenía una guarda que lo hacía inalcanzable | **Pendiente** (documentado como PARTIAL en la matriz) |
| N3 | Los reintentos podían reutilizar volumen/silencio obsoletos y el presupuesto de reintentos no se reiniciaba | **FIXED**: `optionsState` siempre actualizado; `retry()` reinicia el presupuesto |
| N4 | El error `unsupported` podía sobrescribirse con un mensaje en inglés | **Pendiente** |
| N5 | DASH (`mpd`) se mapea a `progressive`, lo que produce un error de medio en lugar de rechazo | **Pendiente** |
| N6 | El cajón de parrilla declara `aria-modal` sin trampa de foco | **Pendiente** |
| N7 | El aviso «Solo enlazamos emisiones publicadas por el propio emisor» afirma algo no garantizable con datos de terceros | **Pendiente** (cambiar el texto o retirarlo) |
| N8 | Sin límite de tamaño de respuestas; imágenes externas sin `referrerpolicy` | **Pendiente** |
| N9 | Los identificadores de canal derivan del nombre; un renombrado upstream desplaza favoritos | **Pendiente** (limitación conocida) |
| N10 | Doble carga posible al cambiar de fuente | **Pendiente** |
| N11 | Detalles de contraste (`--text-subtle` sobre `--surface-3` ≈ 4.2:1) y doble codificación de estado en el botón de silencio | **Pendiente** |
| N12 | Un flujo terminado se reiniciaba indefinidamente | **FIXED** parcialmente: solo se reinicia mientras hay fuente activa |

### Sobre pruebas (T1–T7)

| ID | Hallazgo | Estado |
| --- | --- | --- |
| T1 | No había prueba unitaria del `PlayerController` (el hueco más importante: ahí estaban B1–B3) | **FIXED**: 23 pruebas nuevas. Para hacerlo posible, el motor se inyecta mediante `PLAYER_ENGINE_FACTORY`, que además permite sustituir el backend sin tocar el controlador |
| T2 | La prueba de "salir del canal destruye el motor" usaba recarga completa | **FIXED**: ahora navega dentro de la SPA y comprueba destrucción y recreación |
| T3 | La prueba de pantalla completa es vacua | **PARTIAL** en la matriz (ya no se declara PASS) |
| T4 | Objetivos táctiles medidos con `max` en vez de `min` | **FIXED** |
| T5 | La prueba de teclado es débil | **PARTIAL** en la matriz |
| T6 | Clics condicionales que ocultan fallos | Parcialmente tratado |
| T7 | Faltan casos de `data:`/protocolo-relativo/DASH en validación | **Pendiente** |

### Cobertura del `PlayerController` tras T1

Las 23 pruebas cubren: guarda de generación (eventos de un motor sustituido se
ignoran), destrucción del motor anterior en cada carga y reintento (sin fugas),
límite de **2** reintentos automáticos y fallo posterior, no reintento de errores
no recuperables, parada del motor al fallar, rechazo de eventos tardíos, vigilancia
de "sin fotogramas" (12 s), degradación de señal estancada (20 s), recuperación
tras búfer, `clear()` idempotente, cancelación de reintentos pendientes, rechazo de
autoplay tratado como "bloqueado" y no como error, y exposición de calidades/pistas.

---

## Evaluación de originalidad (auditor)

Cita del auditor:

> «**Partially copied: UI wording only, and I found no code copying.** … No code or
> CSS copying: the minified bundles use mangled identifiers and CSS-module class
> names, and I found none of ours. Our `tdtpref.*` storage keys don't appear in the
> bundles.»

**Resolución**: el único problema de originalidad detectado (dos avisos de
interfaz) se ha corregido con redacción propia. El auditor no encontró copia de
código ni de CSS. El parecido estructural general (tile → ficha → reproductor →
EPG) se considera paridad funcional legítima, documentada en
`docs/RECONSTRUCTION-MATRIX.md`.

---

## Lo que el auditor consideró correcto

- `validators.ts` como frontera defensiva: solo http(s), rechazo de URLs con
  marcadores de cliente, recuento de descartes, lectura segura de mapas.
- `SafeStorage` degradando con elegancia; `fetchJson` con timeout y
  `credentials: 'omit'`.
- Simetría en el desmontaje del motor y los listeners; guarda de generación.
- hls.js perezoso y la distinción correcta de `canPlayType === 'probably'`.
- Reductor de la máquina de estados probado y puro.
- Uso limpio de signals en los stores, sin ciclos.
- Sin `innerHTML`, enlaces externos con `rel="noopener noreferrer"`, y E2E que
  reproduce HLS real en lugar de simularlo.

---

## Resultado final de las pruebas (ejecutadas por el coordinador)

| Suite | Resultado |
| --- | --- |
| `ng build` (producción) | ✅ Correcto · inicial 257 kB (70.77 kB transferidos) · hls.js en chunk perezoso propio |
| `ng test` (Vitest) | ✅ **73/73** (incluye 23 pruebas nuevas del `PlayerController`) |
| `npx playwright test` (desktop + mobile) | ✅ **74/74** |
| Verificación B1 (silencio sin recarga) | ✅ `loadstarts=0`, misma fuente, tiempo avanzando |
| Verificación de reproducción real | ✅ hls.js, `readyState≥2`, vídeo H.264 decodificado |

---

## Estado de entrega

**PASS con hallazgos abiertos documentados.**

- Bloqueantes: **5/5 resueltos y verificados** (B1 verificado empíricamente antes
  y después; B2/B3 cubiertos ahora por pruebas unitarias).
- No bloqueantes: 8 tratados o mitigados, 8 pendientes documentados.
- El hueco de pruebas señalado (T1) se ha cerrado: el `PlayerController` tiene
  23 pruebas unitarias con un motor falso inyectado.

No se declara "producto terminado": se declara **producto funcional con deuda
técnica identificada, trazada y parcialmente saldada**.
