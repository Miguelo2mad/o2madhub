# Módulo Leads (GoHighLevel)

Sincroniza en Supabase los contactos de todas las subcuentas (locations) de
GoHighLevel y los muestra en dos niveles:

- `/leads` (panel de agencia): KPIs totales (hoy, semana, mes frente al
  anterior), evolución por canal de todos los clientes, ranking de clientes
  del periodo con su variación y matriz cliente × 12 meses (solo subcuentas
  activas con token). Cada fila abre el panel del cliente.
- `/leads/cliente?location_id=…` (panel de un cliente): cliente del hub, KPIs,
  evolución por canal (día/semana/mes), mapa de calor hora × día de la semana
  (Madrid) con totales por día y por franja, desglose por canal, top campañas,
  coste por lead (si tiene cuenta de Google Ads mapeada) y listado con
  exportación a CSV.
- `/leads/clientes` (admin): subcuentas, tokens y mapeos.

**Regla de negocio: en Leads solo cuentan las subcuentas "en captación"
(`clientes_ghl.activo = true`), y eso lo decide Miguel a mano.** Las
subcuentas nuevas entran siempre inactivas. Las inactivas no salen en el
panel global, ni en el ranking, la matriz, el selector de cliente, los
totales sin `location_id`, el listado global o el CSV global. Tampoco se
sincronizan, tengan o no token. El panel de una subcuenta inactiva solo se
abre por URL y muestra un aviso.

## Piezas

| Pieza | Archivo |
|---|---|
| Migraciones | `052_leads_ghl.sql` (`clientes_ghl`, `leads`, `leads_sync_log`, vista `leads_diarios`) · `053_leads_atribucion_gasto.sql` (canal `directo`, `campaign_id`/`ad_id`, `cuentas_publicidad`, vista `gasto_diario`) |
| Cliente GHL | `backend/lib/ghl.js` (HTTP, validación de tokens, reintentos, derivación de canal) |
| Sync | `backend/jobs/leads-sync.js` (`syncLeads()`) |
| API | `backend/api/leads.js`, montada en `/api/leads` |
| Páginas | `frontend/pages/leads.html` (`/leads`), `leads-cliente.html` (`/leads/cliente`), `leads-clientes.html` (`/leads/clientes`, admin); helpers, estilos y gráficas comunes en `leads-shared.js` |
| Reclasificación | `backend/scripts/leads-reclasificar.js` (canal/UTMs desde `raw`; dry run por defecto, `--apply` guarda) |
| Cron | `index.js`, cada hora en el minuto 20 (Europe/Madrid) |

## Variables de entorno (Railway)

- `GHL_AGENCY_TOKEN`: Private Integration a nivel agencia con `locations.readonly`.
  Se usa **solo** para descubrir subcuentas. No lee contactos: un Private
  Integration de agencia recibe 401 en `/oauth/locationToken` (GHL lo reserva
  a tokens OAuth de agencia), así que ese endpoint no se usa.
- `GHL_COMPANY_ID`: id de la agencia.

Los contactos se leen **solo** con el token privado de cada subcuenta
(`clientes_ghl.token_privado`): un Private Integration creado dentro de la
subcuenta, con `contacts.readonly` y `locations.readonly`.

## Cómo funciona la sync

1. `GET /locations/search?companyId=…` (paginado con `skip`/`limit`). Las
   subcuentas que no existen en `clientes_ghl` se dan de alta **inactivas**
   (fuera de captación).
   Las existentes no se tocan, así que los nombres y mapeos editados a mano se
   conservan.
2. Para cada subcuenta activa:
   - Sin `token_privado`: se apunta en `leads_sync_log` con `error = 'sin token'`
     y se salta. No cuenta como error: no sale en los logs de Railway ni en
     el contador de errores, y `GET /sync-log` sin `location_id` oculta esas filas.
   - Rango: si `ultima_sync` es null, backfill de los últimos 12 meses. Si no,
     desde `ultima_sync − 24 h`, un solape para no perder contactos.
   - El rango se trocea en ventanas de 30 días. En cada ventana se llama a
     `POST /contacts/search` con `pageLimit: 100`, filtro `dateAdded range
     {gte, lte}` y orden `dateAdded asc`. Se pagina con el cursor
     `searchAfter` del último contacto, o con `page` si GHL no lo devuelve.
     Entre páginas hay 150 ms de pausa. En 429/5xx se reintenta con backoff
     exponencial (1, 2, 4 y 8 s, o lo que diga `Retry-After`).
   - Upsert en `leads` por `ghl_contact_id`, con el contacto completo en `raw`.
   - `ultima_sync` = hora de inicio de esa subcuenta. Solo se actualiza si
     termina sin error.
   - Una fila en `leads_sync_log` por subcuenta y ejecución, con nuevos,
     actualizados y error. Un error en una subcuenta no para las demás.
3. Solo corre una sync a la vez. Si ya hay una en curso, `POST /sync` devuelve
   409 y el cron se salta esa hora.

Todas las fechas se guardan en UTC. Los días, semanas (de lunes a domingo) y
meses se calculan en Europe/Madrid (vista `leads_diarios` y luxon en la API).

### Qué trae GHL de cada contacto

Verificado con 526 leads reales de Capilar Mora en octubre de 2026. No llega el
array `attributions`; llegan `attributionSource` (primer contacto) y
`lastAttributionSource` (último contacto), con:

- `sessionSource`: "Paid Social", "Paid Search", "Organic Search",
  "Direct traffic", "Social media", "CRM UI".
- `medium` ("form", "facebook", "manual") y `mediumId` (formulario).
- `url`: página donde está el formulario, con la query de la visita (`gclid`,
  `gbraid`, `gad_source`, `gad_campaignid`, `utm_*`). Se lee y se añade a la
  atribución.
- `referrer`.
- En los leads de Meta: `utmSource`/`adSource` "facebook", `campaign` +
  `campaignId`, `adId` y `utmContent` (el anuncio). Ojo: `utmMedium` trae el
  nombre de la campaña.
- A veces la atribución llega como `{}` vacío.

Los formularios web llegan casi siempre como "Direct traffic", sin `gclid` ni
UTMs, aunque el cliente tenga Google Ads. El `gclid` llega a la web
(auto-tagging funciona), pero se pierde cuando el usuario navega de la landing
a la página del formulario. Se arregla en la web, no en el código: script de
seguimiento externo de GHL en todo el sitio, o la landing de Ads con el
formulario incrustado.

### Canal

Se deriva en `derivarCanal()` (`backend/lib/ghl.js`), en este orden:

1. **Click IDs**: `fbclid`/`fbc` → **meta**; `gclid`/`gbraid`/`wbraid`/`gad_source` → **google**.
2. **Atribución o `source`**: facebook, fb, instagram, ig, meta o "Paid Social"
   → **meta**; google, adwords o "Paid Search" → **google**.
3. **Etiquetas del contacto**: "meta ads"/"facebook ads" → **meta**; "google ads"/"adwords" → **google**.
4. **organico**: Organic Search, Referral, Social media…
5. **manual**: "CRM UI", medium manual, o sin atribución y con `source` vacío
   o manual/CRM/import/CSV/API/Zapier.
6. **directo**: "Direct traffic", es decir, sin origen conocido. Antes de la
   migración 053 contaba como orgánico.
7. **otro**: todo lo demás.

Las UTMs del lead son las del primer contacto; si faltan, las del último.
`utm_campaign` usa `utmCampaign` o, si no hay, `campaign`. `campaign_id` usa
`campaignId` o `gad_campaignid`. `ad_id` usa `adId`. Todo el detalle queda en
`raw`.

**Cada vez que cambie esta lógica**, hay que reclasificar lo ya importado:
`railway run node backend/scripts/leads-reclasificar.js` (dry run) y después
con `--apply`.

### Coste por lead

- `cuentas_publicidad` (fuente, cuenta_id, location_id, campana_filtro): qué
  cuenta de anuncios es de qué subcuenta. `campana_filtro` es un patrón ILIKE
  sobre el nombre de campaña, para cuentas compartidas entre varias subcuentas
  (Inner Hotels: `%Rupit%`, `%Moli%`). Se edita en `/leads/clientes`, columna
  "Google Ads".
- Vista `gasto_diario` (fuente, location_id, fecha, gasto, impresiones,
  clics): hoy sale de `google_ads_stats_diarias`, que el sync de Campañas
  rellena con una ventana móvil de 30 días. **Para Meta Ads** solo hay que
  añadir sus estadísticas diarias y un `UNION ALL` en la vista con
  `fuente = 'meta'`. `GET /coste?fuente=meta` y el panel ya lo soportan.
- CPL = gasto ÷ leads del mismo canal (google o meta). Si la web pierde el
  `gclid`, los leads de Google salen como "directo" y el CPL sale inflado.

## Dar de alta un cliente nuevo

1. Crear la subcuenta en GoHighLevel, dentro de la agencia. En la siguiente
   sync horaria (o con **Sincronizar ahora** en `/leads/clientes`) aparece
   sola, fuera de captación y "Sin token". Se ve con el filtro "Todas".
2. En GHL, dentro de esa subcuenta: Settings → Private Integrations → crear
   una con los scopes `contacts.readonly` y `locations.readonly`, y copiar el
   token.
3. En `/leads/clientes`: pegar el token en su fila, marcar **En captación**,
   mapearla al cliente del hub (`crm_empresas`) y **Guardar**. El token se valida contra
   `GET /locations/{locationId}`; si no vale, no se guarda y se muestra el
   motivo. Si vale, se lanza en segundo plano el backfill de 12 meses de esa
   subcuenta (`ultima_sync` vuelve a null) y la pantalla muestra el resultado
   del log cuando termina. Desde ahí entra en la sync horaria.

El token nunca se devuelve al frontend: la API solo dice si está configurado
y sus últimos 4 caracteres. Una subcuenta que no cuelga de la agencia se
inserta a mano en `clientes_ghl` (`location_id`, `nombre`) y sigue el paso 3.

Para sacar una subcuenta de Leads, basta con desmarcar **En captación**. Sus
leads históricos se conservan, pero dejan de contar en el panel global. Si se
vuelve a marcar y tiene token, se sincroniza en segundo plano al guardar.

## API (`/api/leads`, auth Supabase; admin = `profiles.role = 'admin'`)

| Método | Ruta | Notas |
|---|---|---|
| GET | `/clientes` | subcuentas + `leads_mes` |
| PATCH | `/clientes/:location_id` | admin. `nombre`, `cliente_id`, `activo`, `token_privado` (se valida; si vale, backfill en segundo plano; `null` = borrar) |
| GET | `/empresas` | admin. Clientes del hub para el mapeo |
| GET | `/resumen?location_id=` | hoy, semana, mes, mes anterior (completo y al mismo día), mismo mes del año anterior, variaciones % |
| GET | `/serie?location_id=&granularidad=dia\|semana\|mes&desde=&hasta=` | buckets con total y desglose por canal |
| GET | `/matriz` | cliente × últimos 12 meses + totales |
| GET | `/desglose?location_id=&desde=&hasta=` | por canal y por `utm_campaign` |
| GET | `/?location_id=&desde=&hasta=&canal=&q=&page=` | listado (50 por página) |
| GET | `/export.csv` | mismos filtros que el listado; CSV con `;` y BOM |
| POST | `/sync?location_id=` | admin. Sync manual; espera a que termine |
| GET | `/sync-log?limite=&location_id=&desde=` | últimas ejecuciones (sin `location_id` oculta las filas "sin token") |
| GET | `/ranking?desde=&hasta=` | subcuentas activas con token por leads del periodo + periodo anterior comparable y variación |
| GET | `/heatmap?location_id=&desde=&hasta=` | matriz 7×24 (lunes = 0, hora de Madrid) + totales por día, hora y franja |
| GET | `/coste?location_id=&granularidad=&desde=&hasta=&fuente=google` | gasto, clics, leads del canal y CPL por periodo + totales y comparativa con el periodo anterior |
| GET | `/cuentas-ads` | admin. Cuentas de Google Ads de Campañas |
| PUT | `/clientes/:location_id/cuentas-ads` | admin. Reemplaza los mapeos: `{ cuentas: [{ fuente, cuenta_id, campana_filtro }] }` |

`desde`/`hasta` son fechas `YYYY-MM-DD` en hora de Madrid, ambas inclusive.
El "periodo anterior" de `/ranking` y `/coste`: si el rango va del día 1 dentro
de un mismo mes, son los mismos días del mes anterior; si no, el mismo número
de días justo antes.
