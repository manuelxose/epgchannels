# PLAYER STATE MACHINE

Máquina de estados del reproductor propio. Fuente de verdad:
`src/app/core/player/player-state.ts`.

## Estados

| Estado | Significado | Capa visible |
| --- | --- | --- |
| `idle` | Sin canal o sin fuente seleccionada | Estado vacío / aviso de canal |
| `loading` | Motor creado, esperando manifiesto | Spinner + `Cargando emisión…` |
| `buffering` | Reproduciendo pero sin datos suficientes | Spinner + `Almacenando en búfer…` |
| `playing` | `!paused && !buffering` | Vídeo + controles |
| `paused` | `paused === true` tras `canplay` | Vídeo congelado + botón Play |
| `error` | Fallo recuperable | `role="alert"` + `Reintentar` |
| `blocked` | El canal no se puede reproducir aquí (externo/geobloqueo/DRM) | Aviso con enlace externo |
| `unsupported` | El entorno no soporta el formato | Aviso + enlace externo |

## Transiciones

```
idle ──selectSource──▶ loading ──manifestparsed/canplay──▶ playing
  ▲                       │                                  │ ▲
  │                   load-error                          pause│ │play
  │                       ▼                                  ▼ │
  │                     error ◀──media-error── playing/paused ─┘
  │                       │                        │
  │                  retry│                        │waiting
  │                       ▼                        ▼
  └──clear/vacío───── loading ◀────────────── buffering
                                   playing ◀─── canplay/playing
blocked ◀── selectSource (fuente no elegible / DRM)   [terminal por fuente]
unsupported ◀── create() (sin hls.js y sin HLS nativo) [terminal]
```

## Reglas de transición

1. `selectSource()` desde `idle | paused | playing | buffering | error` ⇒
   `loading`; conserva `channelId` y `sourceId` objetivo.
2. `error` nunca pasa directamente a `playing`: requiere `retry()` o
   `selectSource()`.
3. `blocked` y `unsupported` sólo salen por `selectSource()` de una fuente válida
   o por `clear()`.
4. `clear()` cancela cargas pendientes, destruye el motor y vuelve a `idle`. Debe
   ser idempotente.
5. Cambio de canal: siempre `clear()` y luego `selectSource()` de la nueva fuente.
   Nunca se reutiliza un motor entre canales con `sourceId` distinto.

## Eventos del motor normalizados (`PlayerEngineEvent`)

| Evento | Origen típico | Efecto |
| --- | --- | --- |
| `manifest-parsed` | hls.js `MANIFEST_PARSED` | registra niveles de calidad |
| `level-switched` | hls.js `LEVEL_SWITCHED` | actualiza calidad actual |
| `tracks` | hls.js `AUDIO_TRACKS_UPDATED`/`SUBTITLE_TRACKS_UPDATED` | pistas de audio/subtítulos |
| `can-play` | `canplay` | `loading → playing/paused` |
| `waiting` | `waiting` / hls `BUFFER_STALLED_ERROR` | `playing → buffering` |
| `playing` | `playing` | `buffering → playing` |
| `pause` | `pause` | `playing → paused` |
| `ended` | `ended` | `playing → paused` |
| `error` | hls `ERROR` fatal / `video.error` | `→ error` (o `blocked` si es de red excluida) |
| `unsupported` | `MediaSource` ausente | `→ unsupported` |

## Recuperación

- **Reintentos acotados**: máximo 2 reintentos automáticos para errores de red
  del motor (`NETWORK_ERROR`, `TIMEOUT`) con espera progresiva (1 s, 3 s). Tras
  eso ⇒ `error`.
- **Sin reintento automático** para errores de medio (`MEDIA_ERROR` fatal) ni de
  decodificación: se pasa a `error` para evitar bucles.
- **Reintento manual**: `retry()` reutiliza la misma fuente, recreando el motor;
  conserva el contador de reintentos hasta que haya éxito o cambio de fuente.
- **Recuperación de directo**: si `currentTime < hls.liveSyncPosition - 20`, se
  busca el borde del directo.
- **Limpieza**: `destroy()` ⇒ `hls.destroy()`, `pause()`, `removeAttribute('src')`,
  `load()`, eliminación de listeners y `URL.revokeObjectURL` si aplica. Se
  invoca en `ngOnDestroy`, al cambiar de canal y al cambiar de fuente.

## Métricas para pruebas

El componente expone `data-testid="player-state"` con el estado actual y
`[data-engine]` con el motor (`hls` | `native` | `none`), para que las pruebas
E2E verifiquen la máquina sin leer internals.
