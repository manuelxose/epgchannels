# Informe de seguridad, derechos y licencias — TDT Platform (tdt-api01)

> **AVISO (2026-11-16): las conclusiones normativas de este informe sobre licencias estan
> REEMPLAZADAS por el modo demo (D-016).** Las licencias se registran como procedencia y no bloquean
> nada; Free-TV se incluye y se puede publicar. Ver `VIGENCIA-LICENCIAS-MODO-DEMO.md`.

- **Tarea:** t4 [sec] — revisión de seguridad, derechos y licencias
- **Autor:** `legal` (equipo `tdt-api02a`)
- **Clase de ruta:** L4 (security-critical / release-sensitive) — requiere revisión independiente posterior
- **Worktree:** `C:\Users\Admin\Documents\workspace\streaming\wt\tdt02a-sec`
- **Rama:** `feat/tdt02a-sec` · **Base:** `febbec464763ffd5812f5b80bf3f6901774dde65` (`febbec4`)
- **Método:** lectura directa del código/config real (no se ejecutó el servicio). Las citas `ruta:línea` se refieren a este árbol.
- **Nota de secretos:** este documento solo referencia nombres de variables de entorno; no se reproduce ningún valor de secreto.

---

## 0. Resumen ejecutivo

La plataforma está razonablemente bien construida en su núcleo defensivo: contraseñas con `scrypt` + salt, sesiones opacas con SHA-256 en reposo, política de publicación que antepone autorización a disponibilidad, CORS/helmet/cuerpo acotado, registro estructurado con redacción, y **sin redifusión**: el backend no proxifica, transcodea ni reemite ninguna señal (el cliente reproduce la URL del emisor).

No obstante, existen **dos hallazgos altos** que deben cerrarse antes de tratar cualquier integración como "autenticada" y antes de exponer el servicio a una red de más de un operador:

1. **SSRF** — el egress no bloquea destinos privados/link-local (`169.254.169.254`, `127.0.0.1`, RFC1918, metadatos de nube) y las URLs de fuentes/guías se recuperan por el backend (bajo demanda y por job programado).
2. **Clave de servicio GuíaTV no aplicada** — `SERVICE_API_KEY_SHA256` se configura, se anuncia (`requiresApiKey`) y se redacta en logs, pero **ningún middleware la valida**; `secretMatches` solo se usa en tests.

Además, el proyecto **no declara licencia** (sin archivo `LICENSE`; `README.md` lo reconoce explícitamente), lo que bloquea cualquier redistribución/publicación.

No hay hallazgo `blocker` para el *alcance de auditoría de línea base* (nada impide que el código siga siendo auditado), pero los dos hallazgos altos y la ausencia de licencia son condiciones de bloqueo para cualquier publicación o para la 02B si ésta depende de la autenticación GuíaTV.

---

## 1. Autenticación y autorización de administración (`modules/admin/*`)

### Lo correcto (verificado en código)

- Contraseñas con `scrypt` + salt aleatorio (16 bytes), nunca en claro (`admin.auth.ts:27-31`).
- Sesiones: token opaco `randomBytes(32)` en base64url; en BD se almacena solo su `SHA-256` (`admin.auth.ts:41-44`, `admin-auth.service.ts:109-119`). Una fuga de BD no produce sesiones utilizables.
- Comparación de contraseña en tiempo constante (`timingSafeEqual`, `admin.auth.ts:33-39`).
- El alta inicial (bootstrap) solo se permite mientras no exista ningún administrador habilitado (`canBootstrap`, `admin-auth.service.ts:73-75`).
- Roles `editor`/`admin`; `requireRole('admin')` exige rol `admin` (un `editor` no pasa) (`admin-auth.service.ts:154-171`).
- `editor` cubre escrituras de catálogo; `admin` cubre ingesta de guías (`routes.ts:423-424, 716`).
- No existe API key de administración que se envíe al navegador.

### Hallazgos

| ID | Severidad | Hallazgo | Evidencia | Corrección requerida |
|---|---|---|---|---|
| SEC-05 | low | Enumeración de usuarios por tiempo: si el email no existe **no se ejecuta** `verifyPassword` (cero trabajo `scrypt`), mientras que un email existente con contraseña errónea sí lo ejecuta. El comentario "comparable work" es incorrecto. | `admin-auth.service.ts:103-106` | Ejecutar un hash ficticio de costo equivalente en el camino "usuario inexistente" (o normalizar la respuesta/tiempo). |
| SEC-06 | low | El token de bootstrap se compara con `!==` (no en tiempo constante). Existe `secretMatches` (tiempo constante) pero **no se usa en producción**. | `admin-auth.service.ts:70`; `admin.auth.ts:51-56` | Comparar `bootstrapToken` con `secretMatches`/`timingSafeEqual`. |
| SEC-07 | low | `scrypt` usa los parámetros por defecto de Node (N=16384, r=8, p=1), no parametrizados; sin `pepper`. Por debajo de la recomendación OWASP (N≥2^17 o Argon2id). | `admin.auth.ts:18-31` | Parametrizar coste por configuración y/o migrar a Argon2id; añadir `pepper` opcional. |
| SEC-08 | medium | Sin throttling específico ni bloqueo de cuenta en `/auth/login` y `/auth/bootstrap`: solo aplica el rate-limit global (300 req/min por IP, 600 en `.env.example`). Ventana de fuerza bruta sobre contraseñas de 12+ caracteres. | `routes.ts:426-449`; `middleware.ts:33-77` | Rate-limit dedicado y más estricto para login/bootstrap + bloqueo temporal de cuenta/IP. |

---

## 2. Manejo de secretos (`config/config.ts`, `.env.example`)

### Lo correcto

- Toda variable con default explícito salvo `ADMIN_BOOTSTRAP_TOKEN`; configuración validada en arranque (`config.ts:122-135`).
- `ADMIN_BOOTSTRAP_TOKEN` con mínimo 32 caracteres y solo por entorno; se hashea inmediatamente (`config.ts:71-77`).
- `SERVICE_API_KEY_SHA256` exige formato hex SHA-256 de 64 (`config.ts:79-83`); nunca se almacena la clave en claro.
- `.gitignore` excluye `.env` y `.env.*` con `!.env.example` (`gitignore:18-21`). No hay `.env` poblado commiteado (verificado).
- `EGRESS_GUARD_ENABLED` se **rechaza en producción** (`config.ts:131-133`).
- `logging.ts` redacta `authorization`, `cookie`, `x-api-key`, `set-cookie` (`logging.ts:11-16, 23`).

### Hallazgos

| ID | Severidad | Hallazgo | Evidencia | Corrección requerida |
|---|---|---|---|---|
| SEC-02 | high | **La clave de servicio GuíaTV no se aplica.** `SERVICE_API_KEY_SHA256` se configura, `serviceKeyEnabled` se computa y se anuncia en el manifiesto, y `x-api-key` se redacta en logs, pero **ningún middleware valida la cabecera** en `/integration/guiatv/*`. `secretMatches` solo aparece en tests. | `config.ts:80`; `bootstrap.ts:41`; `routes.ts:317`; `logging.ts:14`; `admin.auth.ts:51` (sin uso productivo) | Implementar middleware que valide `x-api-key` contra `SERVICE_API_KEY_SHA256` (tiempo constante) en las rutas `server-to-server`; responder 401 sin él; test de integración que demuestre 401/200. |
| SEC-03 | medium | La clave de YouTube Data API se inyecta en el **navegador** (`window.TDT_YOUTUBE_API_KEY`) y se usa para firmar peticiones desde el cliente. El código afirma que es una clave "restringida" (origen + API), pero eso **no es verificable en código**: es responsabilidad del despliegue. | `youtube-runtime.ts:11-12, 120-141`; `youtube-data-api.ts:226-268` | Documentar/automatizar que la clave esté restringida (HTTP referrer del origen + solo YouTube Data API v3) y con cuota; alternativamente mover la resolución a backend. |
| SEC-12 | low | Inconsistencia documental: `.env.example` fija `RATE_LIMIT_MAX_REQUESTS=600` mientras el default de código es `300`. | `.env.example:17` vs `config.ts:69` | Unificar el valor documentado con el default. |
| SEC-13 | medium | La infraestructura de referencia arranca MongoDB y Redis **sin autenticación** (sin `--auth`/`--requirepass` ni credenciales de inicialización). Solo está mitigado por publicarse en `127.0.0.1` (loopback). Para producción no hay endurecimiento (auth/TLS). | `infra/docker-compose.yml:7-9, 43-45`; `config.ts:48-52` | Documentar/parametrizar autenticación y TLS para MongoDB/Redis en despliegues que no sean loopback; no asumir que `127.0.0.1` es suficiente fuera de desarrollo. |

---

## 3. CORS / helmet / rate limit (`server/middleware.ts`, `server/app.ts`)

### Lo correcto

- `helmet` con cabeceras conservadoras; CSP deshabilitado (razonable para API JSON pura), `referrerPolicy: no-referrer`, `crossOriginResourcePolicy: cross-origin` (`app.ts:56-62`).
- CORS con lista explícita de orígenes; sin `Origin` (server-to-server) se permite (`app.ts:63-78`).
- Cuerpo JSON acotado a 256 KB (`middleware.ts:181`; `app.ts:80`).
- Rate limit de ventana fija con cabeceras honestas y modo `process`/`shared` explícito (`middleware.ts:33-77`).
- `x-powered-by` deshabilitado (`app.ts:52`); errores 500 sin detalles internos (`app.ts:114-155`).

### Hallazgos

| ID | Severidad | Hallazgo | Evidencia | Corrección requerida |
|---|---|---|---|---|
| SEC-09 | medium | `/metrics` se sirve **sin autenticación y sin rate-limit** (antes del router API y del limitador). Con `HOST=0.0.0.0` queda público. Expone rutas/estados/duraciones (no secretos). | `app.ts:90-95` | Proteger `/metrics` (auth o bind a interfaz de operador) y/o aplicarle rate-limit; documentar que es solo para operador. |
| SEC-10 | low | `trust proxy = 'loopback'` + rate-limit por `request.ip`: detrás de un proxy no-loopback (Docker bridge, ingress K8s) todos los clientes comparten la IP del proxy (rate-limit colapsado y `ip` de logs errónea). Es seguro frente a *spoofing* de `X-Forwarded-For`, pero no funciona como aislamiento por cliente en despliegues proxy. | `app.ts:53`; `middleware.ts:40` | Documentar la necesidad de configurar `trust proxy` por despliegue y verificar el comportamiento del rate-limit tras proxy. |

---

## 4. Egress, SSRF y TDTChannels residual (`infrastructure/egress.ts`)

### Lo correcto

- Solo se recupera `http(s)`; se rechazan otros esquemas (`egress.ts:78-80`).
- Lista de bloqueo por dominio/subdominio, comprobada **antes** de abrir socket y **después** de redirecciones (`egress.ts:81-83, 101-106`).
- Tiempo de espera y tamaño de respuesta acotados (8 MB por defecto; los adaptadores HLS/DASH limitan a 2 MB) (`egress.ts:85-127`; `providers.registry.ts:83,134`).
- En operación normal no se consulta ningún catálogo de terceros; el egress se usa solo en verificación y en ingesta de guías explícitamente habilitadas por el operador (`egress.ts:13-16`).
- Independencia de TDTChannels verificada por test a nivel de proceso (`independence.independence.spec.ts`) y sin URL de TDTChannels en el código de runtime.

### Hallazgos

| ID | Severidad | Hallazgo | Evidencia | Corrección requerida |
|---|---|---|---|---|
| SEC-01 | high | **SSRF.** `fetchWithPolicy` no distingue destinos privados/link-local: acepta `http://169.254.169.254`, `http://127.0.0.1:*`, RFC1918, `localhost` o DNS que resuelva a IP privada. La URL proviene de la BD (creada por un editor vía `z.string().url()`) y se recupera desde el backend, tanto bajo demanda (`/admin/sources/:id/verify`) como por el job programado `source-verification` y la ingesta EPG. Un token de editor filtrado (o una fuente importada maliciosa) permite sondear la red interna/metadatos de nube. | `egress.ts:71-141` (sin filtro de IP); `bootstrap.ts:37-40`; `routes.ts:626-633`; `scheduler.ts:28-51`; `contracts/admin.ts:197` | Añadir guarda anti-SSRF: resolver DNS y bloquear IP loopback/privadas/link-local/ULA/metadata (169.254.169.254), con re-check tras redirección y ante re-resolución; permitir solo `http(s)` a hosts públicos; tests específicos. |
| SEC-04 | medium | El job backend `youtube-channel-resolver` hace *scraping* de la página pública de YouTube (`/channel/<id>/live`) para extraer el `canonical`, con User-Agent de navegador. Es un riesgo de términos de servicio de YouTube, **contradice** la decisión documentada en el frontend ("a server-side scraper is not part of this app"), y no pasa por `fetchWithPolicy` (objetivo fijo, por lo que no hay SSRF, pero tampoco hay gobernanza de egress). | `youtube-channel-resolver.ts:89-130`; contradicción en `youtube-runtime.ts:162-164` | Sustituir por la Data API documentada (como ya hace el frontend) o, si se mantiene el scraping, documentar la decisión legal/de ToS y unificar la política de egress. |
| SEC-11 | low | Ternario muerto: `blockedHosts: config.EGRESS_GUARD_ENABLED ? config.BLOCKED_EGRESS_HOSTS : config.BLOCKED_EGRESS_HOSTS` — ambas ramas idénticas. `EGRESS_GUARD_ENABLED` no condiciona la lista de bloqueo (solo la rechaza en producción). El código no expresa la intención declarada. | `bootstrap.ts:38` | O bien aplicar de verdad el guard (bloquear solo cuando esté habilitado) o eliminar el flag redundante y documentar que `BLOCKED_EGRESS_HOSTS` siempre aplica. |
| SEC-14 | low | Herramienta de diagnóstico `tools/probe-guides.mjs` aún consulta `tdtchannels.com` e `iptv-org` directamente (sin política de egress). No es runtime, pero es superficie de egress residual que contradice la narrativa de independencia si se ejecuta en entornos de operación. | `tools/probe-guides.mjs:2-6` | Eliminar o marcar como solo-desarrollo y excluir de despliegues; asegurar que el test de independencia la excluya explícitamente si procede. |

---

## 5. Exposición de datos y logs

### Lo correcto

- Registro estructurado (pino) **sin cuerpos de petición ni secretos**; redacción de cabeceras sensibles (`logging.ts:11-16, 23`).
- Errores 500 genéricos; los `AppError` 4xx devuelven un envelope taxonomizado sin detalles internos (`app.ts:114-155`, `errors.ts`).
- La respuesta pública de canal nunca expone la URL de una fuente no publicada ni campos de credenciales; `toChannel`/`buildDescriptor` filtran por política de publicación (`channels.service.ts:55-110`, `playback.service.ts:150-268`).
- Tests cubren: "no se filtra un campo de credencial privado" y "métricas no contienen slugs secretos" (`public-api.integration.spec.ts:231-243, 353`).

### Hallazgos

| ID | Severidad | Hallazgo | Evidencia | Corrección requerida |
|---|---|---|---|---|
| SEC-15 | low | `/health` devuelve `error.message` crudo de MongoDB/Redis en `dependencies[].message`, lo que puede exponer nombres de host, puertos o fragmentos del error de conexión. | `routes.ts:124-157` | Sanear el mensaje de dependencias en `/health` (estado + código, sin `message` crudo). |
| SEC-16 | low | El endpoint `admin/jobs` devuelve `details` del run sin restricción; y `admin/epg-sources` y `admin/channels/:id` devuelven `url` de fuentes a cualquier rol `editor`. No filtra secretos, pero amplía la superficie informativa a todo editor. | `routes.ts:663-712, 508-517` | Revisar qué campos se exponen a `editor` vs `admin`; asegurar que `details`/`url` nunca contengan material sensible. |

---

## 6. Riesgo de redifusión

**No hay redifusión (rebroadcast) por parte del servidor.** Verificado en código:

- El backend **nunca** proxifica, transcodea, graba ni modifica la señal. El descriptor de reproducción entrega la **URL del emisor**; el navegador reproduce directamente contra el emisor/YouTube/embed oficial (`playback.service.ts:97-109, 213-227`).
- `proxyAllowed` se registra como condición pero **no existe** ninguna implementación de proxy/relay (`grep` de `proxy/relay/pipe/http.request` sin resultados de reenvío de medios).
- `PROVENANCE-AND-LICENCES.md` lo declara explícitamente: "We never proxy, record, transcode or modify a signal" (`docs/PROVENANCE-AND-LICENCES.md:34-35`).
- El cliente reproduce: `hls`/`dash` contra la URL del emisor; `youtube`/`official-embed` contra el reproductor oficial; `external` es un enlace a la página del emisor (`publication-policy.ts:103-137`).

**Conclusión de redifusión:** riesgo **bajo por diseño** mientras no se implemente un proxy de medios. **Invariante para 02B:** si en 02B se añade cualquier reenvío de segmentos, deberá pasar por un control de `proxyAllowed` + autorización + registro y no exponerse sin permiso.

---

## 7. Licencias del proyecto frente a iptv-org, Free-TV y TDTChannels

### 7.1 Proyecto propio

| ID | Severidad | Hallazgo | Evidencia | Corrección requerida |
|---|---|---|---|---|
| LIC-01 | high | **No hay licencia declarada.** No existe archivo `LICENSE` en el repositorio (verificado por glob). `README.md` lo reconoce: "Not yet declared… deciding the licence is a precondition for publication." Esto bloquea cualquier redistribución, fork legal o publicación, y deja sin definir los derechos de los consumidores del propio código. | `README.md:66-69`; sin `LICENSE*` en el árbol | Decidir y añadir una `LICENSE` (p. ej. AGPL-3.0, MIT o propietaria explícita) con cabecera en `README.md`; registrar la decisión en el milestone. |

### 7.2 TDTChannels (dependencia de referencia)

- El catálogo de referencia proviene de una **instantánea suministrada por el operador** de TDTChannels (Apache-2.0), tratada como datos de referencia y con atribución obligatoria (`docs/PROVENANCE-AND-LICENCES.md:21`; `channels.service.ts:16-18`; `migration-executor.ts:147-159`).
- La atribución requerida "Datos de referencia: proyecto TDTChannels (Apache-2.0)" se emite en `/channels` y `/channels/:slug` (`attributionFor`, `channels.service.ts:20-36`) y está cubierta por tests.
- **TDTChannels ya no es dependencia de runtime**: aparece solo como origen de la instantánea y en los tests de independencia (`independence.independence.spec.ts`); ningún host de TDTChannels se contacta en operación normal.

**Cumplimiento Apache-2.0 (TDTChannels):** conforme en lo verificado (atribución presente, sin dependencia de runtime). Nota: Apache-2.0 sobre la instantánea no transfiere ningún derecho sobre las *señales* de los emisores, que se rigen por sus propios permisos (correctamente modelado por `permission`/`conditions`).

### 7.3 iptv-org y Free-TV

- **No son dependencias de runtime ni de datos del backend.** No hay referencia en código de producción; solo aparece `iptv-org` en la herramienta de diagnóstico `tools/probe-guides.mjs` (sondeo de guías EPG públicas) (`tools/probe-guides.mjs:3-4`).
- La compatibilidad con `iptv-org`/`Free-TV` es materia del análisis de catálogo/M3U (otro entregable de este milestone), no de este informe.

**No verificable (y se declara explícitamente):** los términos de licencia exactos de los repositorios/guías de `iptv-org` (código bajo The Unlicense/MIT según qué artefacto, y las guías EPG con su propia procedencia) y de `Free-TV` **no fueron inspeccionados en esta revisión** (no hay copia local ni se contactó el upstream). Cualquier ingesta de sus guías/catálogos en 02B exigirá verificar y registrar su licencia y atribución por fuente, del mismo modo que ya se hace con TDTChannels.

---

## 8. Invariantes de seguridad obligatorios para 02B

1. **Sin SSRF:** todo fetch saliente del backend resuelve DNS y rechaza IP loopback/privada/link-local/ULA/metadata (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`, `fe80::/10`, `169.254.169.254`), con re-chequeo tras redirección y re-resolución.
2. **Autenticación server-to-server efectiva:** si `SERVICE_API_KEY_SHA256` está configurada, las rutas `server-to-server` (`/integration/guiatv/*`) exigen `x-api-key` validada en tiempo constante; sin configurar, las rutas quedan cerradas o se deshabilitan explícitamente (nunca "anunciadas pero abiertas").
3. **Sin claves en el navegador sin restricción:** cualquier clave que se envíe al frontend (p. ej. YouTube) debe ser de propósito restringido (origen + API) y documentada; las claves de servidor nunca se envían al cliente.
4. **Auth hardening:** login/bootstrap con rate-limit dedicado y bloqueo de cuenta; comparación de bootstrap en tiempo constante; coste de hash parametrizable (Argon2id o scrypt N≥2^17) + pepper opcional.
5. **No redifusión sin autorización:** el backend no proxifica/reemite señales; si 02B añade reenvío de medios, debe exigir `proxyAllowed`, registrar y auditar, y nunca exponer señales sin permiso.
6. **Atribución por fuente:** toda ingesta de terceros (TDTChannels, iptv-org, Free-TV, guías EPG) registra licencia + atribución por fuente y la emite en las respuestas; ninguna fuente `unlicensed`/`requiresForgedHeader`/`emitterAppOnly` se publica jamás.
7. **Licencia del proyecto definida antes de publicar:** `LICENSE` presente y coherente con `README.md`.
8. **Superficie de operador cerrada:** `/metrics`, `/health` y endpoints de administración no exponen detalles internos ni mensajes crudos; el rate-limit por IP funciona correctamente detrás del proxy elegido.
9. **Secretos solo por nombre de variable:** ninguna herramienta, log, informe o commit reproduce valores de secretos; redacción cubre las nuevas cabeceras/credenciales que 02B añada.

---

## 9. Lo no verificable (declaración explícita)

- **Restricción real de la clave de YouTube en el frontend:** el código no puede probar que `TDT_YOUTUBE_API_KEY` esté restringida por origen/API; es responsabilidad del despliegue.
- **Licencias exactas de iptv-org y Free-TV** (y de sus guías/catálogos): no inspeccionadas en esta revisión (sin copia local ni consulta al upstream).
- **Configuración/secretos de producción:** solo se revisó el `.env.example` y el `docker-compose.yml` de referencia; los despliegues reales (claves, redes, reverse-proxy, auth de MongoDB/Redis en producción) son externos a este árbol.
- **Comportamiento en runtime:** este informe es una revisión estática; no se ejecutó el servicio ni se realizaron pruebas dinámicas (los tests citados pertenecen al repositorio y no se re-ejecutaron aquí).
- **Política de contraseñas de administrador** más allá del mínimo de 12 caracteres (no hay verificación de complejidad/composición).

---

## 10. Veredicto

**PASS condicionado para la auditoría de línea base (work); sin hallazgo `blocker` para seguir auditando.**

Condiciones que impiden publicación o una 02B que dependa de la autenticación GuíaTV, y que deben cerrarse antes:

1. `SEC-01` (SSRF) — high.
2. `SEC-02` (clave de servicio GuíaTV no aplicada) — high.
3. `LIC-01` (sin licencia de proyecto) — high para publicación.

Hallazgos `medium` (SEC-03, SEC-04, SEC-08, SEC-09, SEC-13) y `low` restantes quedan registrados con su corrección requerida en la tabla de hallazgos.
