# NEXT_HANDOFF — TDT-API-02 (traspaso tras el cierre de 02FG)

Leer **antes** de empezar cualquier trabajo nuevo. Si algo contradice el repositorio, **gana el
repositorio**: actualízalo y dilo.

Última actualización: 2026-11-17, cierre de TDT-API-02FG.

---

## 0. Leer en este orden

1. `EXECUTION_CONTRACT.md` — reglas obligatorias.
2. `MILESTONE_STATUS-02FG.md` — estado real del cierre, gate medido, defectos y límites.
3. `02fg/PERF.md` — rendimiento medido antes/después.
4. `02fg/INTERFACE-CONTRACT-02FG.md` y su `-COMPLEMENT` — contratos compartidos y vocabulario de datos.
5. `DECISIONS.md` — D-016..D-023 vigentes.
6. `02e/PLAYBACK-VERIFICATION.md` — evidencia del reproductor.

## 1. Estado al entregar

`main` está en **`da06897`** (PR #7 fusionado). El producto es una demo funcional integrada:

- Catálogo canónico **412 canales publicados** (ES 294 / INT 118) sobre 768 registros.
- **EPG propia** (XMLTV + json), mapeos canónicos, DST, dedup, cobertura `fresh/stale/empty/not-mapped`.
- **API pública internacional** documentada en OpenAPI (46 rutas / 43 esquemas) y cliente regenerado.
- **Consola de administración** real (backend + UI Angular) conectada a la API.
- **Reproductor** de 02E funcionando contra la API final, con progresión real medida.
- Gate consolidado **11/11** y navegador **36/36**.

## 2. Lo más importante para quien siga

### 2.1 Lo que NO es

- **No hay derechos de difusión.** Las 81 autorizaciones son del propietario para *verificar*
  (`reviewStatus: pending-review`) y su cláusula dice que no son prueba de concesión del emisor.
- **No hay CI/CD.** `.github/` no existe: nada despliega al fusionar, pero tampoco valida un PR. El
  único gate es local (`scripts/validate-02fg.mjs`, `scripts/validate-02fg-browser.mjs`).
- **La cobertura de medios no es un censo.** Ver `02e/PLAYBACK-VERIFICATION.md` §5 (Firefox/WebKit no
  medidos, DASH ausente del catálogo).

### 2.2 Trampas confirmadas (ampliación de la lista de 02D)

- **El payload de `/admin/catalogue` NO va doblemente envuelto**: es `{data:[...], pagination}`. Un
  helper que "desenvuelva siempre `data`" pierde la paginación. Ver `core/admin/json-shape.ts`.
- **`/admin/epg/coverage` SÍ va envuelto** (`{data:{entries,totals,conflicts,asOf}}`). Los dos casos
  conviven: lee despacio antes de aplicar un patrón único.
- **Un endpoint de la consola puede responder 200 sin sesión aparente** en las pruebas si reutilizas
  un token de un run anterior: los tokens viven en `admin_sessions` y caducan.
- **Pausar un trabajo sólo funciona si el proceso lo ha registrado** (`JOBS_ENABLED=true`). Con los
  trabajos desactivados, la operación responde 404 honestamente: no es un defecto.
- **La base operativa ya tiene un administrador** (`editor@tdt.invalid`) cuya contraseña no está en el
  repositorio. Para probar administración, usa una base desechable y `ADMIN_BOOTSTRAP_TOKEN` canario.
- **`npx vitest run` debe ejecutarse con cwd = `apps/backend`**; desde la raíz recoge los specs del
  frontend y falla.
- **`npm --prefix apps/frontend run test`** es la forma correcta; `ng test --browsers=...` confunde.

### 2.3 Reglas de oro (sin cambios)

1. Un escritor por worktree; worktrees sólo vía `parallel-dev.mjs`.
2. Nunca `git reset --hard`, `git clean -fdx`, `checkout -f` ni push forzado.
3. Nunca fusionar sin ejecutar de verdad las etapas y sin comprobar CI/CD.
4. Nunca inventar resultados ni afirmar que algo funciona sin exit code real.
5. Nunca escribir valores de secretos: solo nombres de variables de entorno.
6. **Comprueba la rama en la que estás** antes de dar por fusionado algo: `git checkout` puede abortar
   y dejarte en la rama anterior (pasó en este milestone; `git rev-parse --abbrev-ref HEAD` lo detecta).
7. Si un especialista atribuye un fallo a "limitación del entorno", **reprodúcelo antes de aceptarlo**:
   en 02FG el fallo era un defecto real de lectura del payload.

## 3. Trabajo pendiente concreto (no es un milestone nuevo)

Está en `MILESTONE_STATUS-02FG.md` §9: endurecer `adminIdentityInputSchema`, re-apuntar
`/admin/epg/ingestion-runs` a `epg_sync_runs`, programar el refresco de la guía en producción, revisión
visual/contraste fino de la consola y certificación con engine-04 si su runner lo permite.

No hay que abrir otro milestone de revisión para esto: son tareas sueltas.
