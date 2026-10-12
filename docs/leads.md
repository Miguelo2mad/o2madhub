# Módulo Leads (GoHighLevel)

Sincroniza en Supabase los contactos de todas las subcuentas (locations) de
GoHighLevel y los muestra en `/leads`: hoy, semana, mes, comparativas,
evolución por canal, matriz cliente × mes, desglose por canal/campaña y
listado exportable.

## Piezas

| Pieza | Archivo |
|---|---|
| Migración | `database/migrations/052_leads_ghl.sql` (`clientes_ghl`, `leads`, `leads_sync_log`, vista `leads_diarios`) |
| Cliente GHL | `backend/lib/ghl.js` (HTTP, validación de tokens, reintentos, derivación de canal) |
| Sync | `backend/jobs/leads-sync.js` (`syncLeads()`) |
| API | `backend/api/leads.js`, montada en `/api/leads` |
| Páginas | `frontend/pages/leads.html` (`/leads`), `frontend/pages/leads-clientes.html` (`/leads/clientes`, admin) |
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
   subcuentas que no existen en `clientes_ghl` se dan de alta **activas**.
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

### Canal

Se deriva en `derivarCanal()` (`backend/lib/ghl.js`) a partir de `source` y de
las atribuciones (`attributions[]`, `attributionSource`,
`lastAttributionSource`):

- **meta**: `fbclid`, o `utm_source`/`sessionSource`/`medium`/`source` con
  facebook, fb, instagram, ig, meta o "Paid Social".
- **google**: `gclid`/`wbraid`/`gbraid`, o google/adwords.
- **organico**: atribución sin pago (Organic Search, Direct traffic, Referral,
  Social media…).
- **manual**: sin atribución, con `source` vacío o manual/CRM/import/CSV/API/Zapier.
- **otro**: todo lo demás.

Las UTMs del lead son las del primer contacto (`isFirst`). Si faltan, se usan
las del último. Todo el detalle queda en `raw` para el cruce futuro con Meta Ads.

## Dar de alta un cliente nuevo

1. Crear la subcuenta en GoHighLevel, dentro de la agencia. En la siguiente
   sync horaria (o con **Sincronizar ahora** en `/leads/clientes`) aparece
   sola, activa y "Sin token".
2. En GHL, dentro de esa subcuenta: Settings → Private Integrations → crear
   una con los scopes `contacts.readonly` y `locations.readonly`, y copiar el
   token.
3. En `/leads/clientes`: pegar el token en su fila, mapearla al cliente del
   hub (`crm_empresas`) y **Guardar**. El token se valida contra
   `GET /locations/{locationId}`; si no vale, no se guarda y se muestra el
   motivo. Si vale, se lanza en segundo plano el backfill de 12 meses de esa
   subcuenta (`ultima_sync` vuelve a null) y la pantalla muestra el resultado
   del log cuando termina. Desde ahí entra en la sync horaria.

El token nunca se devuelve al frontend: la API solo dice si está configurado
y sus últimos 4 caracteres. Una subcuenta que no cuelga de la agencia se
inserta a mano en `clientes_ghl` (`location_id`, `nombre`) y sigue el paso 3.

Para dejar de sincronizar una subcuenta (por ejemplo, demos o cuentas
internas), basta con desmarcar **Activa**. Sus leads históricos se conservan.

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

`desde`/`hasta` son fechas `YYYY-MM-DD` en hora de Madrid, ambas inclusive.
