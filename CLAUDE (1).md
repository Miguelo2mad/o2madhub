# o2madhub — Contexto del proyecto

Este archivo se lee automáticamente al arrancar Claude Code en este repo. Mantenlo actualizado
según avance el proyecto: cuando se cierre un módulo o se tome una decisión de arquitectura,
añádelo aquí.

## Quién y para qué

O2MAD es una agencia de creatividad/marketing en Palma de Mallorca especializada en hostelería
(hoteles, restaurantes, beach clubs, clínicas). Miguel es el fundador. o2madhub es el sistema de
producción interno de la agencia.

## Stack

- Node.js + Express
- Supabase (proyecto `eqruoeoiqvlnlzidqxqr`) — base de datos central
- Railway — hosting, cron jobs
- Google APIs (Gmail, Drive) vía OAuth2
- Claude API — extracción de datos, clasificación, generación de copy
- GitHub: `Miguelo2mad/o2madhub`

## Arquitectura — principios fijos

- Un único proyecto Railway + una única instancia Supabase para todos los módulos del hub.
- GHL (GoHighLevel) está reservado EXCLUSIVAMENTE como capa de mensajería Meta para Gulliver AI.
  No se usa para scheduling orgánico ni para ningún otro envío del hub.
- Baileys (Node.js) es la capa de monitorización de WhatsApp: listener pasivo, no se usa para
  enviar mensajes salientes de forma proactiva salvo que se decida explícitamente lo contrario.
- Metricool es la plataforma de programación de redes elegida para clientes de O2MAD (no GHL).
- Resend es el servicio estándar de email transaccional y de campañas.
- La clasificación de facturas por sociedad se hace SIEMPRE por CIF — nunca por nombre de
  carpeta, proveedor o palabra clave. Sin CIF legible → sociedad `x` (Sin Clasificar) → aviso a
  info@o2mad.com.

## Las 4 sociedades legales (por CIF)

- `d` — O2DOSMAD Design & Strategy SL — B55405195
- `s` — O2 Marketing and Design SL — B57944829 (default)
- `g` — Gulliver Ventures SL — B26829291
- `a` — Apper Street SL — B57856825
- `x` — Sin Clasificar

## Ecosistema de marcas (siempre separadas públicamente)

- O2MAD — agencia principal hostelería/lifestyle (o2mad.com)
- Funnels Hotel — sistemas de venta directa para hoteles (funnelshotel.com), submarca de O2
  Marketing & Design SL a nivel legal, pero con identidad visual propia (logo, paleta
  teal/verde/amarillo/coral, tipografía Roboto) — nunca mezclar visualmente con O2MAD
- Lo Prohibido — vertical de gastronomía (loprohibidoagency.com)
- O2Clinic — marketing de clínicas (o2clinic.com)
- Gulliver AI — plataforma de IA para hostelería (gulliverhub.com), producto aparte, NO forma
  parte del alcance de o2madhub

## Módulos existentes

- **Módulo 1 — Facturas**: agente diario 08:00h Madrid, lee Gmail (o2mktmiguel + apperstreetapp),
  extrae con Claude API, sube a Drive ("O2MAD Facturas"), resumen a sandra@o2mad.com y
  pedro@agesbal.com (gestor, CC info@o2mad.com).
- **Comarea**: PWA de gestión de facturas para cliente externo (restaurante). Login por variables
  de entorno Railway (`COMAREA_PASS_RESTAURANTE/GESTOR/ADMIN`). Precio: 499€ setup + 49€/mes.
- **Timbol**: segundo cliente externo, duplicado de Comarea. Bug conocido: login de
  `restaurante` roto (sospecha de copia-pega en `TIMBOL_PASS_RESTAURANTE`).
- **Content Studio AI**: pipeline foto (Drive) → copy (Claude) → publicación (Metricool).
  Bloqueado por: API key de Metricool + carpeta raíz de clientes en Drive.
- **Módulo 7 — Presupuestos** (en construcción): generador de presupuestos con plantilla HTML de
  3 páginas (portada / detalle+firma digital / método de pago SEPA-Stripe), diseño en
  `/docs/presupuesto-template.html`. Primera marca: Funnels Hotel. Tabla Supabase:
  `presupuestos` (migración `024_presupuestos.sql`). Rutas: `POST /api/presupuestos` (crear),
  `GET /presupuestos/p/:slug` (ver, público), `POST /presupuestos/p/:slug/firmar` (firmar,
  público). Frontend interno: `frontend/pages/presupuestos.html`, protegido por
  `PRESUPUESTOS_PASS`. Envío al cliente: manual por WhatsApp/GHL de momento, NO automatizado.

## Convenciones de código

- Cada cliente externo con login propio usa variables de entorno Railway por ahora
  (`{CLIENTE}_PASS_{ROL}`). Al llegar un tercer cliente de facturas, migrar a tabla `users` en
  Supabase con bcrypt + `cliente_id` + roles — no seguir añadiendo env vars por cliente.
- Los totales monetarios (subtotales, IVA, descuentos) se calculan SIEMPRE en el servidor, nunca
  se confía en lo que mande el frontend.
- Fuentes: Roboto vía `npm pack @fontsource/roboto@5.0.8`, extraer de
  `package/files/roboto-latin-{weight}-normal.woff2`. Las URLs raw de GitHub para fuentes dan
  404 — no usar esa vía.
- PDFs: Puppeteer para presupuestos, WeasyPrint para informes de cliente (con SVG inline para
  gráficos, flujo normal de documento para pies de página, nunca `position: absolute`).

## Cómo trabajar conmigo (Claude Code) en este proyecto

- Miguel no es técnico: explica en el resumen final qué se hizo y qué tiene que hacer él
  (subir un archivo, poner una env var en Railway, etc.), sin dar por hecho que sabe leer un
  diff.
- Antes de escribir código para un módulo nuevo, si hay una decisión de arquitectura no resuelta
  (qué proveedor, qué canal, qué tabla reutilizar), pregunta — no asumas silenciosamente algo que
  contradiga los principios fijos de arriba.
- Actualiza este archivo cuando cierres un módulo o tomes una decisión de arquitectura nueva,
  para que la siguiente sesión (mía o de Claude en claude.ai) no empiece de cero.
