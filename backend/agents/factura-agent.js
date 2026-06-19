// Daily invoice agent: for EACH configured account read its mailbox (Gmail or Outlook,
// last 24h) → extract with Claude → save to Supabase → upload PDF attachments to Drive
// (O2MAD Facturas / [Year] / [Sociedad] / [Month]). Results across all accounts are
// combined and tagged with source_account for the single daily summary email.
//
// Scheduled from index.js at 08:00 Europe/Madrid. Run manually with: node backend/agents/factura-agent.js
const { supabase } = require('../lib/supabase');
const g = require('../lib/google');                       // shared Drive archive (primary account)
const { loadAccounts, createMailbox } = require('../lib/accounts');
const { extractFactura, SOCIEDADES } = require('../lib/claude');
require('dotenv').config();

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const ROOT_FOLDER = 'O2MAD Facturas';

// Decide the Year / Month folder labels from the invoice date (fallback: email date).
function periodFor(factura, email) {
  const d = factura.fecha_factura ? new Date(factura.fecha_factura) : new Date(email.date);
  const valid = !isNaN(d.getTime()) ? d : new Date();
  return { year: String(valid.getFullYear()), month: MESES[valid.getMonth()] };
}

const KEYWORDS = process.env.FACTURA_KEYWORDS || '(factura OR invoice OR recibo OR receipt OR fra)';

// Process a single account's mailbox. Returns { processed, skipped, errors }, each entry
// tagged with source_account so the combined summary keeps provenance.
async function processAccount(account, opts = {}) {
  const days = opts.days ?? null;
  const limit = days ? 500 : 50; // wider window → fetch more candidates
  const tag = `${account.id}/${account.provider}`;
  const mail = createMailbox(account);

  console.log(`[factura-agent] [${tag}] reading mailbox (days=${days || 1}, limit ${limit})`);
  const ids = await mail.listMessages({ keywords: KEYWORDS, days: days || 1 }, limit);
  console.log(`[factura-agent] [${tag}] ${ids.length} candidate message(s)`);

  const processed = [];
  const skipped = [];
  const errors = [];

  for (const { id } of ids) {
    try {
      const email = await mail.getMessage(id);
      // Download the first PDF attachment (if any) and let Claude read it — the PDF's
      // emission date / provider / amount / recipient take priority over the email.
      let pdfBuffer = null;
      if (email.attachments.length) {
        pdfBuffer = await mail.getAttachment(id, email.attachments[0].attachmentId);
      }
      // If Claude can't parse the PDF (corrupt / not really a PDF), fall back to
      // text-only extraction so the message still gets processed.
      let data;
      try {
        data = await extractFactura(email, pdfBuffer);
      } catch (e) {
        if (pdfBuffer && /pdf|PDF/.test(e.message)) {
          console.log(`[factura-agent] [${tag}]   (PDF ilegible para ${id}, usando texto del correo)`);
          data = await extractFactura(email, null);
        } else throw e;
      }

      if (!data.es_factura) {
        skipped.push({ source_account: account.id, subject: email.subject, reason: 'no es factura' });
        continue;
      }

      // Stable reference for upsert idempotency. Fall back to a mailbox id; the primary
      // account keeps its historical "GM-<id>" form, others are namespaced by account.
      const fallbackRef = account.id === 'o2mad' ? `GM-${id}` : `${account.id}:GM-${id}`;
      const referencia = data.referencia || fallbackRef;
      const { year, month } = periodFor(data, email);

      // GUARD 1 — never overwrite an existing alert/pending invoice.
      const { data: existing } = await supabase
        .from('facturas').select('estado').eq('referencia', referencia).maybeSingle();
      if (existing && ['alerta', 'pendiente'].includes(existing.estado)) {
        skipped.push({ source_account: account.id, subject: email.subject, reason: `protegida (estado=${existing.estado})` });
        console.log(`[factura-agent] [${tag}] ⊘ protegida ${referencia} (estado=${existing.estado})`);
        continue;
      }

      // GUARD 2 — dedup: same proveedor + same importe within ±7 days.
      if (data.importe != null) {
        const base = data.fecha_factura ? new Date(data.fecha_factura) : new Date(email.date);
        if (!isNaN(base.getTime())) {
          const iso = d => d.toISOString().slice(0, 10);
          const lo = new Date(base); lo.setDate(lo.getDate() - 7);
          const hi = new Date(base); hi.setDate(hi.getDate() + 7);
          const { data: dups } = await supabase
            .from('facturas').select('referencia')
            .eq('proveedor', data.proveedor)
            .eq('importe', data.importe)
            .gte('fecha_factura', iso(lo))
            .lte('fecha_factura', iso(hi))
            .neq('referencia', referencia);
          if (dups && dups.length) {
            skipped.push({ source_account: account.id, subject: email.subject, reason: `duplicada de ${dups[0].referencia}` });
            console.log(`[factura-agent] [${tag}] ⊘ duplicada ${referencia} ~ ${dups[0].referencia}`);
            continue;
          }
        }
      }

      // Upload PDF attachments to Drive: O2MAD Facturas / Year / Sociedad / Month
      // (one shared Drive archive regardless of which mailbox the invoice came from).
      const sociedadName = SOCIEDADES[data.sociedad_codigo] || data.sociedad_codigo;
      const driveFolder = [ROOT_FOLDER, year, sociedadName, month].join('/');
      const driveLinks = [];
      if (email.attachments.length) {
        // Anchor under the configured root folder id if present (set by setup-drive.js);
        // otherwise resolve/create "O2MAD Facturas" by name at the Drive root.
        const rootId = process.env.DRIVE_ROOT_FOLDER_ID || null;
        const pathNames = rootId ? [year, sociedadName, month] : [ROOT_FOLDER, year, sociedadName, month];
        const folderId = await g.ensureFolderPath(pathNames, rootId);
        for (const att of email.attachments) {
          const fname = `${referencia} - ${att.filename}`;
          // Dedup: reuse the existing file's link instead of re-uploading.
          const existingFile = await g.findFileInFolder(fname, folderId);
          if (existingFile) { driveLinks.push(existingFile.webViewLink); continue; }
          const buf = await mail.getAttachment(id, att.attachmentId);
          const up = await g.uploadFile(fname, buf, folderId);
          driveLinks.push(up.webViewLink);
        }
      }

      // Persist to Supabase (idempotent on referencia thanks to the UNIQUE constraint).
      const row = {
        fecha_factura: data.fecha_factura,
        proveedor: data.proveedor,
        referencia,
        concepto: data.concepto,
        importe: data.importe,
        sociedad_codigo: data.sociedad_codigo,
        estado: 'procesada',
        drive_url: driveLinks[0] || null,
        drive_folder: driveLinks.length ? driveFolder : null,
        source_account: account.id,
      };
      const { error } = await supabase.from('facturas').upsert(row, { onConflict: 'referencia' });
      if (error) throw new Error(`Supabase: ${error.message}`);

      processed.push({ ...row, sociedad: sociedadName, driveLinks });
      console.log(`[factura-agent] [${tag}] ✓ ${referencia} — ${data.proveedor} (${data.importe ?? 's/imp'})`);
    } catch (e) {
      errors.push({ source_account: account.id, id, message: e.message });
      console.error(`[factura-agent] [${tag}] ✗ ${id}: ${e.message}`);
    }
  }

  console.log(`[factura-agent] [${tag}] done: ${processed.length} saved, ${skipped.length} skipped, ${errors.length} errors`);
  return { processed, skipped, errors };
}

async function runFacturaAgent(opts = {}) {
  const accounts = loadAccounts();
  if (!accounts.length) throw new Error('No accounts configured (set GOOGLE_REFRESH_TOKEN and/or the multi-account env vars)');
  console.log(`[factura-agent] ${accounts.length} account(s): ${accounts.map(a => `${a.id}(${a.provider})`).join(', ')}`);

  const processed = [];
  const skipped = [];
  const errors = [];

  // Process accounts independently — a failure in one (bad token, Graph outage) must not
  // abort the others. Results are combined into a single summary.
  for (const account of accounts) {
    try {
      const r = await processAccount(account, opts);
      processed.push(...r.processed);
      skipped.push(...r.skipped);
      errors.push(...r.errors);
    } catch (e) {
      console.error(`[factura-agent] [${account.id}] account failed: ${e.message}`);
      errors.push({ source_account: account.id, id: `account:${account.id}`, message: e.message });
    }
  }

  console.log(`[factura-agent] all accounts done: ${processed.length} saved, ${skipped.length} skipped, ${errors.length} errors`);
  return { processed, skipped, errors };
}

module.exports = { runFacturaAgent, processAccount };

// Allow running directly: node backend/agents/factura-agent.js [--days=N]
if (require.main === module) {
  const arg = process.argv.find(a => a.startsWith('--days='));
  const days = arg ? parseInt(arg.split('=')[1], 10) : null;
  runFacturaAgent({ days }).catch(e => { console.error(e); process.exit(1); });
}
