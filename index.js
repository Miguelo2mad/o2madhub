// o2madhub entrypoint: Express server + daily cron that runs the invoice agent
// and emails the summary. Start with: node index.js
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
require('dotenv').config();

const { runFacturaAgent } = require('./backend/agents/factura-agent');
const { sendDailySummary } = require('./backend/api/notifications');
const comareaRouter = require('./backend/api/comarea');

const app = express();
app.use(cors());
app.use(express.json());

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

// Hub dashboard (Supabase Auth + realtime). Served at / and /hub.
const HUB_PAGE = path.join(__dirname, 'frontend', 'pages', 'index.html');
app.get(['/', '/hub'], (_req, res) => res.sendFile(HUB_PAGE));

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

app.listen(PORT, () => {
  console.log(`[o2madhub] listening on :${PORT} — invoice agent scheduled daily at 08:00 Europe/Madrid`);
});
