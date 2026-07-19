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

## Variables de entorno en Railway
```
SUPABASE_URL                ✅
SUPABASE_SERVICE_KEY        ✅
SUPABASE_ANON_KEY           ✅
ANTHROPIC_API_KEY           ✅
GOOGLE_CLIENT_ID            ✅
GOOGLE_CLIENT_SECRET        ✅
GOOGLE_REFRESH_TOKEN        ✅ (solo Gmail — NO tiene scope de Drive)
ACCT_APPER_GOOGLE_REFRESH_TOKEN ✅
DRIVE_ROOT_FOLDER_ID        ✅
GMAIL_USER                  ✅
FACTURA_QUERY               ✅
NOTIFY_TO                   ✅
NOTIFY_CC                   ✅
RAILWAY_URL                 ✅
GOOGLE_SERVICE_ACCOUNT_JSON ❌ PENDIENTE — necesario para Drive en Content Studio
METRICOOL_API_KEY           ❌ PENDIENTE — necesario para programar en Metricool
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

### 🔧 Módulo 2 — Content Studio AI (en construcción)
**Lo que está hecho:**
- Tablas Supabase creadas: `asset_library`, `content_client_config`, `content_plan`, `content_scan_status`
- Agente `content-agent.js` con scan Drive + etiquetado Claude Vision + generación plan semanal
- API completa en `backend/api/content.js` con todas las rutas
- Dashboard `frontend/pages/content.html` con navegación por cliente
- Análisis automático de web del cliente para generar prompt maestro con IA
- Barra de progreso en tiempo real con polling cada 3 segundos
- Procesamiento en lotes paralelos de 5 para mayor velocidad
- Primer cliente creado: **Roots Beach** (client_id: `roots`)

**✅ Content Creator · Carril A — creatividades foto+texto (EN PRODUCCIÓN):**
- Nuevo flujo LIGERO basado en subida (no escanea Drive → evita el problema de GB).
- Pestaña **✦ Creador** en `content.html`: sube 1-5 fotos → elige formato (post 4:5 /
  story 9:16 / cuadrado 1:1) + brief opcional → genera.
- `backend/agents/creative-agent.js`: Claude Vision lee la foto y escribe copy
  (titular, subtítulo, caption, hashtags, CTA) personalizado con la config del cliente
  (prompt_maestro, tono, hashtags_fijos).
- `backend/lib/image.js`: composición con `sharp` (titular + subtítulo + scrim + marca +
  CTA). Fuentes TTF vendorizadas en `assets/fonts/` (Anton + Poppins) registradas vía
  fontconfig (`FONTCONFIG_FILE` en runtime, antes de cargar sharp) → render correcto en
  Railway. NOTA: embeber la fuente en base64 en el SVG NO funciona en Linux (librsvg la
  ignora → texto en "tofu"); por eso se usa fontconfig.
- Ruta: `POST /api/content/creative` (multipart, 1-5 fotos) → PNG base64 + copy.
- Verificado end-to-end en producción con cliente Roots (19-jul-2026).
- **CTA por subida** (campo opcional; vacío = lo decide la IA) + **brief como énfasis**.
- **Kit de marca por cliente**: logo corporativo, fuente de titulares y de texto
  (TTF/OTF propias) y color de marca. Guardados en `content_client_config`
  (`logo`, `font_display`, `font_body`, `accent_color`).
- El texto se renderiza como TRAZADOS vectoriales con `opentype.js` (no `<text>`):
  usa la fuente exacta (default o la del cliente), elimina el problema de fuentes en
  Linux y da métricas precisas. (Se retiró el hack previo de fontconfig.)
- Columnas Supabase requeridas (ALTER TABLE):
  `logo text`, `font_display text`, `font_body text`, `accent_color text`.

**⏳ Content Creator · Carril B — vídeo/story + carrusel (PENDIENTE, decisión tomada tras investigación 19-jul-2026):**
- Objetivo: mismas fotos subidas en el Creador → (a) vídeo slideshow/story y (b) carrusel.
- **Carrusel**: casi gratis — es agrupar varias creatividades ya generadas por el Carril A
  (varias imágenes deslizables). Trivial, no necesita motor de vídeo nuevo.
- **Vídeo (MVP elegido): ffmpeg auto-alojado en Railway + Editly**
  (github.com/mifi/editly, MIT, Node.js). Cubre nativamente Ken Burns/zoom, transiciones
  (direccionales + gl-transitions), overlays de texto animado y mezcla/crossfade de audio,
  todo por una receta JSON/JSON5 declarativa — **Claude genera esa receta directamente**.
  Coste marginal (Railway Hobby $5/mes ya contratado; el plan es suscripción + overage por
  uso real, NO facturación estricta por minuto).
  - ⚠️ Riesgo técnico a validar con un spike antes de construir el flujo completo: Editly
    exige `ffmpeg`/`ffprobe` en PATH, es ESM-only, y sus transiciones usan WebGL
    (headless-gl) — en Linux/Nixpacks puede requerir dependencias de sistema extra. No
    verificado aún en un contenedor Railway real.
- **Vía premium futura (si el MVP se queda corto): Creatomate**
  (creatomate.com, SDK Node oficial, API en todos los planes). Prueba gratis 50 créditos.
  ~14 créditos/min de vídeo 720p; **carrusel = 1 crédito/imagen** (muy barato ahí también).
  Alternativa equivalente: Shotstack ($0.20-0.30/min, 10 créditos gratis).
- **Descartados**:
  - *CapCut* → NO viable. Su página "AI API" es marketing sin SDK/endpoints/auth reales;
    no existe API pública de render programático (verificado explícitamente).
  - *Remotion* (código React) → potente pero requiere licencia comercial si la agencia
    tiene 4+ empleados (mínimo $100/mes "Automators"); descartado por coste de licencia,
    no por capacidad técnica.
  - *Vídeo IA* (Runway/Veo/Kling) → $0.05–0.40/seg, demasiado caro/impredecible como motor
    principal de slideshows. Reservar solo para animar puntualmente 1-2 fotos "hero" de
    producto/ambiente si en el futuro se quiere ese efecto premium.
- ⚠️ **Riesgo legal de música (verificado)**: para música en contenido de CLIENTES (uso
  comercial/publicitario de marca) hace falta licencia de tier superior — el plan gratuito
  o "Creator" de Epidemic Sound/Artlist NO cubre publicidad de marca, solo el plan
  Pro/Business/Enterprise. Nunca usar la biblioteca musical nativa de Instagram para
  cuentas business, ni pistas "gratis" de origen dudoso (riesgo de mute/retirada del reel).
- Cosmético pendiente: la pestaña Creador se ve estrecha en viewports pequeños (revisar
  responsive de la grid de formatos y la zona de arrastre).

**Bloqueado por:** (afecta solo al scan de Drive / plan semanal, NO al Carril A)
- `GOOGLE_SERVICE_ACCOUNT_JSON` no configurada en Railway
- El `GOOGLE_REFRESH_TOKEN` existente solo tiene scope de Gmail, no de Drive
- **Solución pendiente mañana:** crear Service Account en Google Cloud Console, compartir carpeta Drive con el email de la service account, añadir JSON en Railway como `GOOGLE_SERVICE_ACCOUNT_JSON`

**Pasos exactos para mañana:**
1. Ir a console.cloud.google.com → IAM → Cuentas de servicio → Crear `o2madhub-drive`
2. Descargar JSON de credenciales
3. Copiar `client_email` del JSON
4. En Google Drive → carpeta Roots Beach → Compartir con ese email como Lector
5. En Railway → Variables → añadir `GOOGLE_SERVICE_ACCOUNT_JSON` con el contenido del JSON
6. Restaurar getDriveClient() en content-agent.js para usar Service Account (no OAuth2)
7. Lanzar scan: `POST /api/content/scan/roots`
8. Verificar progreso: `GET /api/content/scan-status/roots`

**Pendiente tras el scan:**
- Añadir `METRICOOL_API_KEY` en Railway
- Generar primer plan semanal para Roots Beach
- Probar aprobación de pieza y programación en Metricool

### 🔄 Módulo 3 — CRM (planificado)
- Inbox AI con clasificación emails y análisis sentimiento
- Contacto 360° por cliente
- Kanban proyectos con portal aprobación cliente
- Upsell Engine (triggers 90d foto/video, 12m web)
- Comunicaciones email + WhatsApp con plantillas Meta
- Presupuestos con URL única, firma digital y tracking apertura
- Tablas: contacts, deals, projects, inbox_items, wa_messages, upsell_opps, activity_log

### 🔄 Módulo 4 — Presupuestos (planificado)
- Generación por prompt texto o nota de voz (Whisper)
- URL única por cliente: hub.o2mad.com/p/:token
- Firma digital HTML5 canvas
- Tracking apertura: timestamp + dispositivo + ciudad
- Push notification a Miguel en primera apertura
- PDF con branding O2MAD personalizado por cliente

### 🔄 Módulo 5 — Prospecting (planificado)
- Scraper Google Places API por nicho + ciudad
- Análisis web automático: PageSpeed, WHOIS, pixel Meta/GA4, CMS, motor reservas
- Score oportunidad IA por lead (1-10)
- Panel llamadas kanban: Pendiente/Llamado/Callback/Demo
- Exportación CSV

### 🔄 Módulo 6 — Metricool Marketing Copilot (planificado)
- Dashboard unificado todos los clientes
- Informes automáticos con IA mensuales
- Alertas inteligentes WhatsApp/email
- PDFs premium branding O2MAD
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

## Reglas críticas del sistema
1. CIF del destinatario es el ÚNICO método válido para clasificar facturas
2. Sin CIF → código 'x' → nunca asignar sociedad por suposición
3. Google APIs corren en background — nunca bloqueando middleware
4. Supabase es la fuente única de verdad para todos los módulos
5. Todos los módulos comparten el mismo Railway deployment y login
6. content-agent.js debe usar GOOGLE_SERVICE_ACCOUNT_JSON para Drive (pendiente configurar)
7. El resto del proyecto usa OAuth2 con GOOGLE_CLIENT_ID + SECRET + REFRESH_TOKEN

## Marca O2MAD
- **Claim:** "We Sell Desire." (siempre con punto, nunca explicado)
- **Colores:** Negro #0F0E0C · Arena #C4A882 · Arena Oscura #9A7A58 · Blanco #F5F0E8
- **Tipografía:** Inter (dashboard) · Roboto Black 900 (headlines) · Roboto Light 300 (body)
- **Nunca usar:** premium, lujo, emojis, exclamaciones, sin subcontratas, resultados medibles
- **CTAs:** "cuéntanos tu proyecto" o "agenda una llamada"
- **PURO Group:** siempre "partner creativo" — nunca trofeo en portfolio

## Ecosistema de marcas (nunca mezclar)
- **O2MAD** — hostelería/lifestyle (o2mad.com)
- **Lo Prohibido** — solo gastronomía (loprohibidoagencia.com)
- **FunnelsHotel** — webs hoteleras (funnelshotel.com) — nunca en materiales O2MAD
- **O2Clinic** — clínicas (o2clinic.com)
- **Gulliver AI** — IA hostelería (gulliverhub.com)
