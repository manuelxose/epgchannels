# Mutation test — el probe SSRF es una puerta real, no teatro

Ejecutado por el capitán el 2026-11-17 sobre `feat/tdt-api02-d-stream-health` (`114c679`).
Objetivo: demostrar que la prueba de aceptación SSRF **falla** cuando la defensa falla. Una puerta que
no puede fallar no certifica nada.

Método: mutar el código en el árbol de integración, **recompilar** (obligatorio: `dist/` es lo que
importa el probe, y un `dist/` viejo hace la mutación vacua — trampa conocida en `NEXT_HANDOFF §4`),
ejecutar `node apps/backend/scripts/ssrf-adversarial-probe.mjs`, y restaurar con `git checkout`.

## Resultado

| Mutación | Códigos observados | Conexiones | Exit | ¿La puerta muerde? |
|---|---|---|---|---|
| Ninguna (baseline) | `host-blocked` ×9, `redirect-unsafe` ×1 | **0** todos | 0 | — (verde esperado) |
| `isPublicAddress` → siempre `true` | `host-blocked` (sin cambio) | **0** todos | 0 | **No** — la capa 1 lo cubre |
| `isReservedHostname` desactivado | `private-address` ×7, `redirect-unsafe` ×1 | **0** todos | 0 | **No** — la capa 2 lo cubre |
| **Ambas** desactivadas | `timeout`/`connection-failed`, y **1 caso `FAILED`** | **1 en cada caso** | **1** | **Sí** |

## Qué demuestra cada fila

- **Fila 2 y 3 prueban defensa en profundidad real.** Desactivar cualquiera de las dos capas no abre
  un socket: la otra capa rechaza. Los *códigos* cambian (`host-blocked` → `private-address`), lo que
  demuestra que las dos capas son distintas de verdad y no la misma comprobación duplicada. Es el
  resultado correcto para un diseño por capas.
- **Fila 4 prueba que el probe es una puerta.** Con las dos capas caídas, la conexión se establece
  (`connects=1`), `http://192.168.1.1/` **tuvo éxito** (`FAILED`) y el probe devuelve **exit 1**.
  Es decir: el probe detecta exactamente el fallo que debe detectar.

Por tanto el verde del baseline **no** es "rechaza todo por defecto": con las defensas retiradas, el
tráfico sale de verdad. Esa es la prueba de que la puerta discrimina.

## Nota sobre la fila 4 y el alcance del daño

`connects=1` en todos los casos significa que el guard dejó de abrir el socket al destino. Que un caso
contra `192.168.1.1` "tuviera éxito" no implica que un servicio contestara: el probe clasifica como
éxito la obtención de una respuesta; con la defensa caída habría intentado conectar. La conclusión
operativa es la correcta: **sin las dos capas, el guard conecta a direcciones privadas.**

## Reproducción

```powershell
# en feat/tdt-api02-d-stream-health
# 1) mutar la capa deseada (isPublicAddress y/o isReservedHostname)
# 2) recompilar SIEMPRE antes de medir
npm run build -w @tdt/backend
node apps/backend/scripts/ssrf-adversarial-probe.mjs   # exit != 0 cuando la defensa cae
# 3) restaurar
git checkout -- apps/backend/src/infrastructure/safe-egress.ts apps/backend/src/infrastructure/ip-classification.ts
npm run build -w @tdt/backend
node apps/backend/scripts/ssrf-adversarial-probe.mjs   # exit 0 de nuevo
```

Tras restaurar: `git status` limpio en esos ficheros y `exit 0` confirmado.

## Limitación declarada

Esta prueba mide **una** propiedad: que no se establece conexión hacia destinos privados. No mide
agotamiento de memoria, ni comportamiento bajo concurrencia, ni rebinding entre la validación y la
conexión (eso lo cubre la suite de 142 tests, no este probe). Las dos pruebas son complementarias; el
probe existe precisamente porque la suite inyectaba `lookup` y no ejercitaba la vía real.
