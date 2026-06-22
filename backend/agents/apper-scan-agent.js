// Apper Gmail strict scan: read the apperstreetapp@gmail.com mailbox (last N days),
// classify each PDF SOLELY by recipient CIF, insert with source_account='apper'.
//   CIF found → insert · no CIF / unreadable → email info@o2mad.com · dedup by referencia.
//
//   node backend/agents/apper-scan-agent.js [--days=180] [--apply]
const { createGmailClient } = require('../lib/google');
const { ingestPdf } = require('../lib/strict-ingest');
const { sendNoCifNotice } = require('../api/notifications');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');
const daysArg = process.argv.find(a => a.startsWith('--days='));
const DAYS = daysArg ? parseInt(daysArg.split('=')[1], 10) : 180;
const KEYWORDS = process.env.FACTURA_KEYWORDS || '(factura OR invoice OR recibo OR receipt OR fra)';

async function main() {
  const token = process.env.ACCT_APPER_GOOGLE_REFRESH_TOKEN;
  if (!token) throw new Error('Missing ACCT_APPER_GOOGLE_REFRESH_TOKEN');
  const mail = createGmailClient(token);

  const ids = await mail.listMessages({ keywords: KEYWORDS, days: DAYS }, 500);
  console.log(`[apper-scan] ${ids.length} mensaje(s) candidatos (últimos ${DAYS}d)`);
  if (!APPLY) { console.log('(DRY RUN — sin Claude ni escritura.)'); return; }

  let inserted = 0, dup = 0, skip = 0;
  const noCif = [];
  for (const { id } of ids) {
    let email;
    try { email = await mail.getMessage(id); } catch (e) { console.log(`  ✗ getMessage ${id}: ${e.message}`); continue; }
    for (const att of email.attachments) {
      try {
        const buf = await mail.getAttachment(id, att.attachmentId);
        const r = await ingestPdf({ buf, email, source: 'apper', refFallback: `apper:GM-${id}` });
        if (r.status === 'inserted') { inserted++; console.log(`  ✓ ${r.referencia} → ${r.sociedad} | ${r.proveedor} | ${r.importe ?? 's/imp'}€`); }
        else if (r.status === 'dup') dup++;
        else if (r.status === 'skip') skip++;
        else if (r.status === 'nocif') noCif.push({ ...r.info, buf, filename: att.filename });
        else if (r.status === 'unreadable') noCif.push({ proveedor: '(PDF ilegible)', referencia: null, importe: null, source: 'apper', link: null, buf, filename: att.filename });
        else if (r.status === 'error') console.log(`  ✗ ${att.filename}: ${r.message}`);
      } catch (e) { console.log(`  ✗ ${att.filename}: ${e.message}`); }
    }
  }

  console.log(`\n[apper-scan] insertadas ${inserted} · dup ${dup} · no-gasto ${skip} · sin-CIF→email ${noCif.length}`);
  if (noCif.length) { try { await sendNoCifNotice(noCif, 'Gmail Apper'); } catch (e) { console.error('[apper-scan] email sin-CIF falló:', e.message); } }
}

main().catch(e => { console.error(e); process.exit(1); });
