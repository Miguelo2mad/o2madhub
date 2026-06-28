# O2MAD Hub — Contexto del Proyecto

## Stack técnico
- **Backend:** Node.js + Express
- **Base de datos:** Supabase (PostgreSQL)
- **Hosting:** Railway (o2madhub-production.up.railway.app)
- **Repo:** github.com/Miguelo2mad/o2madhub
- **IA:** Claude API (claude-sonnet-4-6)
- **Email:** Resend
- **WhatsApp:** Baileys
- **Autenticación:** Supabase Auth

## URLs del Hub
- **Home / Selector módulos:** /
- **Content Studio:** /content
- **Facturas:** /facturas
- **CRM:** /crm (pendiente)
- **Presupuestos:** /presupuestos (pendiente)
- **Prospecting:** /prospecting (pendiente)

## Estructura del proyecto
```
o2madhub/
├── index.js                          # Entry point + rutas principales
├── CONTEXT.md                        # Este archivo
├── backend/
│   ├── agents/
│   │   ├── factura-agent.js          # Agente Gmail → facturas → Drive → Supabase
│   │   ├── drive-scan-agent.js       # Scan Drive genérico
│   │   ├── content-agent.js          # Content Studio — scan assets + plan semanal
│   │   └── apper-scan-agent.js       # Apper Street scan
│   ├── api/
│   │   ├── content.js                # Rutas API Content Studio
│   │   ├── comarea.js                # Rutas API Comarea (cliente externo)
│   │   └── notifications.js          # Notificaciones
│   └── lib/
│       ├── claude.js                 # Cliente Claude API
│       ├── google.js                 # Google Drive + Gmail OAuth2
│       ├── supabase.js               # Cliente Supabase
│       ├── accounts.js               # Gestión cuentas Gmail
│       ├── outlook.js                # Microsoft 365
│       └── strict-ingest.js          # Ingestión estricta facturas
├── frontend/
│   └── pages/
│       ├── index.html                # Home — selector de módulos + login
│       ├── content.html              # Content Studio dashboard
│       └── comarea.html              # Portal cliente Comarea
└── database/                         # Schemas y migraciones SQL
```

## Módulos activos

### ✅ Módulo 1 — Facturas
- Agente diario 08:00h Madrid
- Lee Gmail (o2mktmiguel@gmail.com + apperstreetapp@gmail.com)
- Extrae datos via Claude API
- Sube PDFs a Drive organizado por Año/Sociedad/Mes
- Clasifica por CIF del destinatario (ÚNICO método válido)
- Sin CIF → código 'x' → email a info@o2mad.com
- Resumen diario a sandra@o2mad.com + pedro@agesbal.com
- ~412 facturas procesadas

### ✅ Módulo 2 — Content Studio AI (en construcción)
- Scan carpetas Drive por cliente → etiquetado Claude Vision
- Prompt maestro por cliente en Supabase
- Generación plan semanal con IA (reel/foto/carrusel/story)
- Aprobación por equipo → programación directa en Metricool API
- Pendiente: API key Metricool + configurar primer cliente
- Tablas Supabase: `asset_library`, `content_client_config`, `content_plan`

### 🔄 Módulo 3 — CRM (planificado julio 2026)
- Inbox AI con clasificación de emails y análisis de sentimiento
- Contacto 360° por cliente
- Kanban de proyectos con portal de aprobación cliente
- Upsell Engine (triggers 90d foto/video, 12m web)
- Comunicaciones email + WhatsApp con plantillas Meta
- Presupuestos con URL única, firma digital y tracking apertura
- Tablas: `contacts`, `deals`, `projects`, `inbox_items`, `wa_messages`, `upsell_opps`, `activity_log`

### 🔄 Módulo 4 — Presupuestos (planificado julio 2026)
- Generación por prompt de texto o nota de voz (Whisper)
- URL única por cliente: hub.o2mad.com/p/:token
- Firma digital HTML5 canvas
- Tracking de apertura: timestamp + dispositivo + ciudad
- Push notification a Miguel en primera apertura
- PDF descargable con branding O2MAD personalizado por cliente

### 🔄 Módulo 5 — Prospecting (planificado)
- Scraper Google Places API por nicho + ciudad
- Análisis web automático: PageSpeed, WHOIS, pixel Meta/GA4, CMS, motor reservas
- Score de oportunidad IA por lead (1-10)
- Panel de llamadas kanban: Pendiente/Llamado/Callback/Demo
- Exportación CSV

### 🔄 Módulo 6 — Metricool Marketing Copilot (planificado)
- Dashboard unificado todos los clientes
- Informes automáticos con IA mensuales
- Alertas inteligentes WhatsApp/email
- PDFs premium con branding O2MAD
- Scoring de clientes
- Integrado en ficha CRM

## Clientes activos O2MAD
PURO Group, Zafiro Hotels, Universal Hotels, Palacio Can Marqués,
Purobeach, Arume Sake Bar, Clínica Nadal, Roscam, Clínica Capilar Mora,
Krishna, Canyamel Classic

## Sociedades y códigos
- O2DOSMAD Design & Strategy SL — CIF B55405195 — código `'d'`
- O2 Marketing and Design SL — CIF B57944829 — código `'s'`
- Gulliver Ventures SL — CIF B26829291 — código `'g'`
- Apper Street SL — CIF B57856825 — código `'a'`
- Sin clasificar — código `'x'`

## Variables de entorno necesarias (Railway)
```
SUPABASE_URL
SUPABASE_KEY
ANTHROPIC_API_KEY
GOOGLE_SERVICE_ACCOUNT_JSON
GMAIL_CLIENT_ID
GMAIL_CLIENT_SECRET
RESEND_API_KEY
METRICOOL_API_KEY          ← pendiente añadir
```

## Reglas críticas del sistema
- CIF del destinatario es el ÚNICO método válido para clasificar facturas
- Sin CIF → código 'x' → nunca asignar sociedad por suposición
- Google APIs corren en background — nunca bloqueando middleware
- Supabase es la fuente única de verdad para todos los módulos
- Todos los módulos comparten el mismo Railway deployment y login

## Próximos pasos inmediatos
- [ ] Configurar primer cliente en Content Studio (carpeta Drive lista)
- [ ] Añadir METRICOOL_API_KEY en Railway variables
- [ ] Lanzar primer scan de Drive y generar plan semanal
- [ ] Construir módulo CRM — Inbox AI primero
- [ ] Módulo Presupuestos con firma digital
- [ ] Módulo Prospecting

## Marca O2MAD
- **Claim:** "We Sell Desire." (siempre con punto, nunca explicado)
- **Colores:** Negro #0F0E0C · Arena #C4A882 · Arena Oscura #9A7A58 · Blanco #F5F0E8
- **Tipografía:** Inter (dashboard) · Roboto Black 900 (headlines) · Roboto Light 300 (body)
- **Nunca usar:** premium, lujo, emojis, exclamaciones, "sin subcontratas", "resultados medibles"
- **CTAs:** "cuéntanos tu proyecto" o "agenda una llamada"
- **PURO Group:** siempre "partner creativo" — nunca trofeo en portfolio

## Ecosistema de marcas (nunca mezclar)
- **O2MAD** — hostelería/lifestyle (o2mad.com)
- **Lo Prohibido** — solo gastronomía (loprohibidoagencia.com)
- **FunnelsHotel** — webs hoteleras (funnelshotel.com) — nunca en materiales O2MAD
- **O2Clinic** — clínicas (o2clinic.com)
- **Gulliver AI** — IA hostelería (gulliverhub.com)
