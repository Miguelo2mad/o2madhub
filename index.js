// o2madhub entrypoint: Express server + daily cron that runs the invoice agent
// and emails the summary. Start with: node index.js
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
require('dotenv').config();

const { runFacturaAgent } = require('./backend/agents/factura-agent');
const { sendDailySummary } = require('./backend/api/notifications');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Run the agent, then email the summary. Shared by the cron job and the manual endpoint.
async function runDaily() {
  console.log(`[o2madhub] daily run @ ${new Date().toISOString()}`);
  const result = await runFacturaAgent();
  try {
    await sendDailySummary(result);
  } catch (e) {
    console.error('[o2madhub] summary email failed:', e.message);
  }
  return result;
}

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Manual trigger (handy for testing without waiting for 08:00).
app.post('/run', async (_req, res) => {
  try {
    const result = await runDaily();
    res.json({
      ok: true,
      processed: result.processed.length,
      skipped: result.skipped.length,
      errors: result.errors.length,
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
