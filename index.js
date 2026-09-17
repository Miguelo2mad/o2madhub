// o2madhub entrypoint: Express server + daily cron that runs the invoice agent
// and emails the summary. Start with: node index.js
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
require('dotenv').config();

const { runFacturaAgent } = require('./backend/agents/factura-agent');
const { sendDailySummary } = require('./backend/api/notifications');
const comareaRouter      = require('./backend/api/comarea');
const timbolRouter       = require('./backend/api/timbol');
const grupoRouter        = require('./backend/api/grupo');
const contentRoutes      = require('./backend/api/content');
const presupuestosRouter = require('./backend/api/presupuestos');
const campanasRouter        = require('./backend/api/campanas');
const customerMetricsRouter       = require('./backend/api/customer-metrics');
const crmRouter                   = require('./backend/api/crm');
const serviceClassificationRouter = require('./backend/api/service-classification');
const { syncGoogleAds }              = require('./backend/jobs/google-ads-sync');
const { syncFacturaDirecta }         = require('./backend/jobs/facturadirecta-sync');
const { runCustomerMetricsJob }      = require('./backend/jobs/customer-metrics-job');
const { importarContactosFD }        = require('./backend/jobs/crm-import-fd');
const { runServiceClassification }   = require('./backend/jobs/service-classification-job');
const { runVentasPosSync }           = require('./backend/jobs/ventas-pos-sync');

const app = express();
app.use(cors());
// Límite amplio: el kit de marca por cliente embebe logo y fuentes (TTF/OTF) como
// data URI en el JSON, que superan de largo el 100kb por defecto de express.json.
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'frontend', 'pages')));

const PORT = process.env.PORT || 8080;

// Fail loud at boot if required config is missing (visible in Railway deploy logs).
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GMAIL_USER', 'ANTHROPIC_API_KEY'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) console.error(`[o2madhub] ⚠ MISSING env vars: ${missing.join(', ')}`);
else console.log('[o2madhub] ✓ all required env vars present');
['DRIVE_ROOT_FOLDER_ID', 'NOTIFY_TO', 'NOTIFY_CC', 'RAILWAY_URL']
  .forEach(k => { if (!process.env[k]) console.warn(`[o2madhub] (optional) ${k} not set`); });

// Run the agent, then (optionally) email the summary. Shared by cron and the manual endpoint.
async function runDaily({ notify = true } = {}) {
  console.log(`[o2madhub] daily run @ ${new Date().toISOString()} (notify=${notify})`);
  const result = await runFacturaAgent();
  if (notify) {
    try {
      await sendDailySummary(result);
    } catch (e) {
      console.error('[o2madhub] summary email failed:', e.message);
    }
  }
  return result;
}

app.use('/comarea', comareaRouter);
app.use('/timbol', timbolRouter);
app.use('/grupo', grupoRouter);
app.use('/api/content', contentRoutes);
app.use('/presupuestos', presupuestosRouter);
app.use('/api/presupuestos', presupuestosRouter);
app.use('/api/campanas', campanasRouter);
app.use('/api/customer-metrics', customerMetricsRouter);
app.use('/api/crm', crmRouter);
app.use('/api/service-classification', serviceClassificationRouter);

// Hub dashboard (Supabase Auth + realtime). Served at / and /hub.
const HUB_PAGE = path.join(__dirname, 'frontend', 'pages', 'index.html');
app.get(['/', '/hub'], (_req, res) => res.sendFile(HUB_PAGE));
app.get('/content', (_req, res) => res.sendFile(path.join(__dirname, 'frontend', 'pages', 'content.html')));
app.get('/timbol-app',       (_req, res) => res.sendFile(path.join(__dirname, 'frontend', 'pages', 'timbol.html')));
// Pantalla pública de fichaje: una sola plantilla para cualquier cliente
// (Timbol, Comarea, futuros restaurantes). El cliente y el token van en la
// URL; el shell los lee de location.pathname. No colisiona con la API
// JSON — esa vive en /<cliente>/fichaje/<token>/estado (con sufijo).
app.get('/:cliente/fichaje/:token', (_req, res) => res.sendFile(path.join(__dirname, 'frontend', 'pages', 'fichaje.html')));
app.get('/grupo-app',        (_req, res) => res.sendFile(path.join(__dirname, 'frontend', 'pages', 'grupo.html')));
app.get('/presupuestos-app', (_req, res) => res.sendFile(path.join(__dirname, 'frontend', 'pages', 'presupuestos.html')));
app.get('/campanas', (_req, res) => res.sendFile(path.join(__dirname, 'frontend', 'pages', 'campanas.html')));
app.get('/crm', (_req, res) => res.sendFile(path.join(__dirname, 'frontend', 'pages', 'crm.html')));

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Manual trigger (handy for testing without waiting for 08:00).
app.post('/run', async (req, res) => {
  try {
    // ?notify=false → run the agent but skip the summary email (for debugging).
    const notify = req.query.notify !== 'false';
    const result = await runDaily({ notify });
    res.json({
      ok: true,
      processed: result.processed.length,
      skipped: result.skipped.length,
      errors: result.errors.length,
      errorDetails: result.errors, // [{ id, message }] — for debugging without log access
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Daily at 08:00 Spain time.
cron.schedule('0 8 * * *', () => {
  runDaily().catch(e => console.error('[o2madhub] cron run failed:', e.message));
}, { timezone: 'Europe/Madrid' });

// FacturaDirecta sync — daily at 06:00 Madrid.
cron.schedule('0 6 * * *', () => {
  syncFacturaDirecta().catch(e => console.error('[fd-sync] cron failed:', e.message));
}, { timezone: 'Europe/Madrid' });

// Service classification — daily at 06:10 Madrid (after FD sync, before customer metrics).
cron.schedule('10 6 * * *', () => {
  runServiceClassification().catch(e => console.error('[service-classification] cron failed:', e.message));
}, { timezone: 'Europe/Madrid' });

// Customer Intelligence metrics — daily at 06:30 Madrid.
cron.schedule('30 6 * * *', () => {
  runCustomerMetricsJob().catch(e => console.error('[customer-metrics] cron failed:', e.message));
}, { timezone: 'Europe/Madrid' });

// CRM import — daily at 06:45 Madrid (after customer-metrics at 06:30).
cron.schedule('45 6 * * *', () => {
  importarContactosFD().catch(e => console.error('[crm-import] cron failed:', e.message));
}, { timezone: 'Europe/Madrid' });

// Campañas Google Ads sync — daily at 07:00 Madrid.
cron.schedule('0 7 * * *', () => {
  syncGoogleAds().catch(e => console.error('[campanas] cron failed:', e.message));
}, { timezone: 'Europe/Madrid' });

// Ventas TPV sync — daily at 02:00 Madrid. Sin ruido si ningún cliente
// tiene un adaptador de TPV activo (ver runVentasPosSync).
cron.schedule('0 2 * * *', () => {
  runVentasPosSync().catch(e => console.error('[ventas-pos-sync] cron failed:', e.message));
}, { timezone: 'Europe/Madrid' });

app.listen(PORT, () => {
  console.log(`[o2madhub] listening on :${PORT} — invoice agent scheduled daily at 08:00 Europe/Madrid`);
});
