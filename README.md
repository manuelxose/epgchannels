# TDT Platform

An owned data platform for television metadata, playback sources and programme
guides, with a versioned REST API (`/api/v1`), a shared contract package, a
TypeScript SDK and an Angular client that consumes it.

The platform is the source of truth for its catalogue: it does not read a
third-party catalogue, guide or player at runtime.

The product has three surfaces: **televisión en directo** (`/television`), la
**guía / parrilla** (`/schedule`) y la **consola de administración** (`/admin`).

## Arranque completo con un comando

```bash
docker compose -f infra/docker-compose.yml up -d   # MongoDB (replica set) + Redis
npm install
copy .env.example .env                             # y rellena las dos líneas marcadas OBLIGATORIO
npm run demo                                       # API + web + administración
```

`npm run demo` compila, aplica migraciones, crea el administrador definido en
`.env` y sirve el bundle que se entrega, con el proxy `/api` al backend:

| Superficie | URL |
| --- | --- |
| Televisión en directo | <http://127.0.0.1:4200/television> |
| Guía / parrilla | <http://127.0.0.1:4200/schedule> |
| Administración | <http://127.0.0.1:4200/admin> |
| API | <http://127.0.0.1:4010/api/v1> |
| OpenAPI | <http://127.0.0.1:4200/api/v1/openapi.json> |

Las credenciales del panel son las de `.env`
(`ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD`). **`.env` está ignorado
por git**: nunca se commitea. Para comprobar que el producto arranca de verdad:

```bash
npm run smoke:local        # 8 comprobaciones reales: catálogo, reproducción, guía y acceso al panel
```

> **Guía de demostración (contenido sintético).** Este checkout no incluye guía
> descargable: las instantáneas de `data/` no se versionan a propósito. Con
> `DEMO_SEED_GUIDE=true` (por defecto en `.env`), `npm run demo` siembra una
> parrilla generada por el propio proyecto **solo si la base no tiene guía
> vigente**; todos los títulos terminan en «demo» y la fuente se registra con
> licencia `synthetic-demo`. No son emisiones reales.

## Modo desarrollo con recarga

```bash
npm run dev          # API (4010, recarga) + servidor Angular (4200)
npm run stop:dev
```

## Documentación

| Documento | Contenido |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Componentes, ruta de una petición, política de publicación, proveedores |
| [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) | Colecciones, campos e índices |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Despliegue reproducible, configuración, comandos de verificación |
| [`docs/PROVENANCE-AND-LICENCES.md`](docs/PROVENANCE-AND-LICENCES.md) | Procedencia de cada clase de dato y qué puede hacerse con ella |
| [`docs/GUIATV-INTEGRATION.md`](docs/GUIATV-INTEGRATION.md) | Cómo consume la API GuíaTV sin duplicar identidades |
| [`docs/tdt-api02/MILESTONE_STATUS-02FG.md`](docs/tdt-api02/MILESTONE_STATUS-02FG.md) | Estado del milestone, gate medido y límites |
| [`docs/tdt-api02/NEXT_HANDOFF.md`](docs/tdt-api02/NEXT_HANDOFF.md) | Traspaso y trampas conocidas |
| [`openapi/openapi.json`](openapi/openapi.json) | Documento OpenAPI 3.1 (46 rutas) |

## Comandos

| Comando | Qué hace |
| --- | --- |
| `npm run demo` | Arranca el producto completo (API + web + administración) |
| `npm run dev` / `npm run stop:dev` | Modo desarrollo con recarga |
| `npm run smoke:local` | Comprueba el producto en marcha de punta a punta |
| `npm run build` | Compila contratos, SDK y backend |
| `npm run typecheck` | TypeScript estricto en todos los paquetes |
| `npm test` | Backend (unit, integration, independence) y SDK |
| `npm run test:frontend` | Tests unitarios del cliente |
| `npm run test:e2e` | Playwright, incluida la suite contra el backend real |
| `npm run test:load` | Presupuestos de latencia y errores |
| `npm run validate` | Gate consolidado del milestone (11 etapas, exit codes reales) |
| `npm run openapi:export` | Regenera el documento OpenAPI |
| `npm run client:generate` | Regenera los tipos del SDK |
| `npm run import:catalogue -- --file <path>` | Importa una instantánea de catálogo que aporta el operador |
| `npm run import:guide -- --file <path> --kind xmltv` | Importa una guía XMLTV |
| `npm run demo:guide` | Genera la guía **sintética** de demostración |
| `npm run audit:bootstrap` | Arranca desde una base vacía y la comprueba |
| `npm run audit:acceptance` | Auditoría de aceptación de TDT-API-01 |

- A public channel always has provenance, and third-party data always carries
  its attribution.
- A source is exposed only when a recorded permission and its conditions allow
  it; availability never overrides authorisation.
- A channel without a guide says so; no emission is ever invented.
- The API is versioned, documented, validated against shared schemas, and
  consumable server-to-server without exposing a secret to a browser.
- No runtime request is made to the third-party data provider; with every one of
  its hosts blocked, the platform keeps working.

## Licence

Not yet declared. The code is the property of its author; deciding the licence is
a precondition for publication.

