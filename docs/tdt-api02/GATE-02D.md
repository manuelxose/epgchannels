# GATE-02D — resultado del gate sobre el árbol entregado

Este fichero existe porque el registro `engine-04` **no pudo ejecutar** las etapas en este entorno, y
la revisión independiente lo detectó (hallazgo F2). Se registra aquí lo medido, con los exit codes
reales, sobre el árbol exacto señalado. **Ninguna afirmación de este fichero vale sin su exit code.**

## Identidad del árbol medido

| Dato | Valor |
|---|---|
| Rama | `feat/tdt-api02-d-stream-health` |
| Commit | `54e90c1e2440d1244772a249647c3cf22c5d8a82` |
| Tree object id | `ffe56d9fc3a7382409de5ddfb1a2c5347ec94bd6` |
| `git status` | limpio (`dirty: false`) |
| Artefactos en el snapshot | 1 406, `gaps: []` |
| Snapshot engine-04 | `audits/02d-snapshot.json` (`kind: snapshot`) |

## Etapas — ejecutadas de verdad, driver directo

| Etapa | Comando | Exit | Resultado |
|---|---|---|---|
| `build` | `npm run build` | **0** | OK |
| `typecheck` | `npm run typecheck` | **0** | OK |
| `unit` | `npm run test:unit` | **0** | 549 tests |
| `integration` | `npm run test:integration` | **0** | 181 tests |
| `ingestion` | `node apps/backend/scripts/ingestion-scenario.mjs` | **0** | 9/9 (migration-rollback incluido) |
| `independence` | `npm run test:independence` | **0** | 15 tests |
| `client` | `npm run test -w @tdt/api-client` | **0** | 14 tests |

## Por qué el gate automático NO certifica esto (limitación declarada)

`node $DSH_HOME/engine-04/tools/qa-evidence.mjs verify` **no puede ejecutar** las etapas en este host:

```
windows-acl-run: CreateProcessAsUserW failed (Win32 2): command: npm
```

Cada etapa basada en `npm` devuelve **exit 127**; `ingestion` falla en `migration-rollback` con
`spawn EPERM`. Es una **limitación del entorno** (el runner con ACL de Windows no puede crear el
proceso), **no un fallo del código**: ejecutando cada comando directamente, las siete etapas salen 0,
como muestra la tabla.

Consecuencia para la calificación del milestone, sin adornos:

- **MEDIDO DIRECTAMENTE**: sí, las siete etapas, con los exit codes de arriba.
- **CERTIFICADO por engine-04**: **no**. El `gate` no puede otorgar PASS aquí.
- Por tanto este milestone **no** puede declararse PASS en el sentido de `ENGINE-04 §8.6`; el estado
  honesto es **PARTIAL** en el eje de certificación, aunque todos los criterios funcionales se hayan
  medido. La revisión independiente emitió `pass` con 4 hallazgos (1 medium de contrato, 1 medium de
  evidencia no ligada al árbol, 2 low), y el presente fichero cierra F2 ligando un snapshot al árbol
  final.

## Registros

- `audits/02d-snapshot.json` — snapshot de engine-04 ligado a `54e90c1` / `ffe56d9`.
- `audits/02d-verify.json` — la ejecución fallida por ACL, **conservada tal cual**: enseña el modo de
  fallo en vez de esconderlo.
