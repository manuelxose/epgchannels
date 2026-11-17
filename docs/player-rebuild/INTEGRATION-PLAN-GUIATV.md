# PLAN TÉCNICO DE INTEGRACIÓN EN GUÍA TV (documental)

> **Documento exclusivamente de diseño.** Esta fase **no autoriza ni incluye**
> ningún cambio en el repositorio GuíaTV. Describe cómo se integraría el
> reproductor y el catálogo ya construidos.

---

## 1. Principio

El proyecto se ha construido para integrarse, no para fusionarse. La unidad
reutilizable no es "la aplicación", sino tres piezas independientes:

1. **Modelo + validación de catálogo/EPG** (`core/data`, `core/models`).
2. **Motor de reproducción** (`core/player` + `PlayerController`).
3. **Componentes de UI del reproductor y del catálogo** (`features/watch`,
   `features/catalogue`).

La aplicación actual es el *host de referencia* de esas piezas.

---

## 2. Opciones de integración

### Opción A — Librería interna (recomendada)

Publicar las piezas como un paquete del monorepo de GuíaTV
(p. ej. `@guiatv/player`), consumido por la app Angular existente.

- **Pros**: sin duplicación, versionado único, reutiliza los tokens de diseño.
- **Contras**: exige acordar los tokens de diseño y el modelo de datos con GuíaTV.
- **Trabajo**: extraer `core/*` a librería, sustituir los tokens de diseño por los
  de GuíaTV, adaptar los adaptadores a las fuentes reales de GuíaTV.

### Opción B — Micro-frontend

Mantener el player como aplicación desplegable y montarla en GuíaTV mediante un
elemento personalizado (Custom Element).

- **Pros**: aislamiento, despliegue independiente.
- **Contras**: comunicación entre contenedor y player, peso adicional, doble
  sistema de estilos.
- **Cuándo**: solo si GuíaTV va a integrar varios productos de terceros.

### Opción C — Servicio de datos

Reutilizar únicamente el backend/adaptadores de datos y que GuíaTV implemente su
propia UI.

- **Pros**: máximo control visual por parte de GuíaTV.
- **Contras**: se pierde el motor y las pruebas ya realizadas.

**Recomendación**: Opción A.

---

## 3. Mapa de reutilización

| Pieza actual | Destino en GuíaTV | Cambios necesarios |
| --- | --- | --- |
| `core/models/catalog.model.ts` | Tipos compartidos | Mapear a los tipos de canal de GuíaTV |
| `core/data/validators.ts` | Validación de fuentes | Ninguno; añadir los esquemas nuevos que GuíaTV consuma |
| `core/ports/remote-adapters.ts` | Adaptadores | Sostituir URLs; añadir adaptador para la BD de GuíaTV |
| `core/player/*` | Motor de vídeo | Ninguno |
| `core/state/player.controller.ts` | Controlador | Ninguno |
| `core/state/catalog.store.ts` | Store de catálogo | Puede sustituirse por el store de GuíaTV |
| `core/epg/now-next.ts` | Utilidad EPG | Posible desajuste de modelo si GuíaTV usa otro esquema |
| `features/watch/player/*` | Componente de reproductor | Sustituir tokens por los de GuíaTV |
| `features/catalogue/*` | Catálogo | Revisar si GuíaTV ya tiene catálogo propio |
| `shared/ui/icon.component.ts` | Iconografía | Sustituir por el set de GuíaTV |

---

## 4. Contratos que deben acordarse antes de integrar

1. **Modelo de canal**: ¿usa GuíaTV `epg_id`/`options`/`extra_info` o un modelo
   propio? Si es propio, se necesita un mapeador explícito y pruebas de contrato.
2. **Estrategia de medios**: ¿GuíaTV tiene backend con proxy CORS? Determina si se
   puede reproducir fuentes sin CORS (actualmente no se puede desde el cliente).
3. **Sistema de diseño**: tokens y tipografía de GuíaTV sustituyen a
   `src/app/styles/tokens.css`.
4. **Enrutado**: el player asume `/television/:channelId`. En GuíaTV podría ser
   `/canales/:id` o un modal.
5. **Licencia:** el código que se publique dentro de GuíaTV debe llevar la
   licencia que la organización decida (el proyecto está sin licencia declarada).

---

## 5. Fases propuestas (ejecución en un proyecto posterior)

| Fase | Trabajo | Criterio de cierre |
| --- | --- | --- |
| 0 | Decisión de licencia y de política de datos/logotipos | Documento firmado por el titular |
| 1 | Extraer `core/*` a librería con *build* propio | Librería compila y pasa los 50 tests unitarios |
| 2 | Sustituir adaptadores por las fuentes de GuíaTV | Pruebas de contrato verdes con datos reales de GuíaTV |
| 3 | Adaptar tokens de diseño | Revisión visual con el equipo de diseño de GuíaTV |
| 4 | Integrar el componente en la app de GuíaTV | Las pruebas E2E del player pasan dentro de GuíaTV |
| 5 | Rendimiento y accesibilidad en contexto real | Lighthouse y revisión a11y en la app integrada |

---

## 6. Riesgos

| Riesgo | Impacto | Mitigación |
| --- | --- | --- |
| Modelo de datos incompatible | Alto | Fase 2 con mapeador y pruebas de contrato |
| Sin proxy CORS en GuíaTV | Alto | Decidir en fase 0; posible backend de medios |
| Deriva de los dos catálogos | Medio | Motor de vídeo independiente de la fuente de datos |
| Doble sistema de diseño | Medio | Fase 3 con revisión del equipo de diseño |
| Temas legales (datos/logotipos) | Alto | Fase 0 obligatoria antes de publicar |

---

## 7. Qué NO se llevaría a GuíaTV

- La identidad visual "Midnight Broadcast" (es propia de este producto).
- El catálogo de demostración (es solo para pruebas).
- La lógica de navegación de esta aplicación si GuíaTV ya tiene la suya.
