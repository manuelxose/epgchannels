# NEXT_HANDOFF — TDT-API-02 (traspaso tras el cierre de 02FG y su ronda de acabado)

Leer **antes** de empezar cualquier trabajo nuevo. Si algo contradice el repositorio, **gana el
repositorio**: actualízalo y dilo.

Última actualización: 2026-11-17 (ronda de acabado tras 02FG).

---

## 0. Arrancar el producto (lo primero)

```bash
npm run infra:up      # MongoDB replica set + Redis (Docker)
npm install
copy .env.example .env   # y rellena ADMIN_BOOTSTRAP_PASSWORD y ADMIN_BOOTSTRAP_TOKEN
npm run demo          # API :4010 + web :4200 + administración, con proxy /api
npm run smoke:local   # 8 comprobaciones reales (debe dar 8/8)
```

Panel: <http://127.0.0.1:4200/admin> con el correo y la contraseña de `.env`. `.env` está ignorado
por git: **nunca se commitea**. Para modos recarga: `npm run dev` / `npm run stop:dev`.

## 0-bis. Leer en este orden

1. `EXECUTION_CONTRACT.md` — reglas obligatorias.
2. `MILESTONE_STATUS-02FG.md` — estado real, gate medido, defectos y límites.
3. `02fg/PERF.md` — rendimiento medido antes/después.
4. `02fg/INTERFACE-CONTRACT-02FG.md` y su `-COMPLEMENT` — contratos y vocabulario de datos.
5. `DECISIONS.md` — D-016..D-023 vigentes.
6. `02e/PLAYBACK-VERIFICATION.md` — evidencia del reproductor.

## 1. Estado al entregar

`main` incluye el milestone 02FG fusionado (PR #7 y #8) y la ronda de acabado (PR #9). Producto
funcional integrado:

- Catálogo canónico **412 canales publicados** (ES 294 / INT 118) sobre 768 registros.
- **EPG propia** (XMLTV + json), mapeos canónicos, DST, dedup, cobertura `fresh/stale/empty/not-mapped`,
  job `epg-refresh` que respeta la pausa del operador.
- **API pública internacional** documentada en OpenAPI (46 rutas / 43 esquemas) y cliente regenerado.
- **Consola de administración** real, con identidad que exige cambio efectivo (409 si no cambia).
- **Reproductor** con progresión real medida.

## 2. Lo que NO es

- **No hay derechos de difusión.** Las 81 autorizaciones son del propietario para *verificar*.
- **No hay CI/CD.** El único gate es local: `npm run validate` (11 etapas) y `npm run smoke:local`.
- **La guía del checkout es sintética.** No hay guía descargable versionada: `npm run demo` siembra
  una parrilla generada por el propio proyecto (títulos terminan en «demo», licencia `synthetic-demo`)
  solo si la base no tiene guía vigente. Para guía real: `DEMO_SEED_GUIDE=false` y `import:guide`.

## 3. Trampas confirmadas

- **El payload de `/admin/catalogue` NO va doblemente envuelto** (`{data:[...], pagination}`); el de
  `/admin/epg/coverage` **sí** (`{data:{entries,…}}`). Lee despacio antes de aplicar un patrón único.
- **Pausar un trabajo sólo funciona si el proceso lo registró** (`JOBS_ENABLED=true`). Con trabajos
  desactivados la operación responde 404 honestamente.
- **`npx vitest run` debe ejecutarse con cwd = `apps/backend`.**
- **Comprueba la rama en la que estás** antes de dar algo por fusionado: `git checkout` puede abortar
  y dejarte en la rama anterior (`git rev-parse --abbrev-ref HEAD`).
- **Si alguien atribuye un fallo a "limitación del entorno", repordúcelo**: en 02FG dos veces el
  defecto era real (lectura del payload y selector del test).
- **`npm run dev` deja procesos que no siempre aparecen en `.dev-pids.json`**: antes de `npm run demo`,
  libera 4010 y 4200 (`npm run stop:dev` o comprueba `Get-NetTCPConnection -LocalPort 4010`).

## 4. Trabajo pendiente concreto (no es un milestone nuevo)

1. Revisión visual y de contraste WCAG de la consola por una persona.
2. Certificación con engine-04 cuando su runner pueda lanzar `npm` en este host.
3. Sustituir la guía sintética por una fuente XMLTV con licencia cuando el operador la aporte.