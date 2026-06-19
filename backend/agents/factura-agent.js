// Daily invoice agent: read Gmail (last 24h) → extract with Claude → save to Supabase
// → upload PDF attachments to Drive (O2MAD Facturas / [Year] / [Sociedad] / [Month]).
//
// Scheduled from index.js at 08:00 Europe/Madrid. Run manually with: node backend/agents/factura-agent.js
const { supabase } = require('../lib/supabase');
const g = require('../lib/google');
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

async function runFacturaAgent() {
  const query = process.env.FACTURA_QUERY || 'newer_than:1d (factura OR invoice OR recibo)';
  console.log(`[factura-agent] Gmail query: ${query}`);

  const ids = await g.listMessages(query, 50);
  console.log(`[factura-agent] ${ids.length} candidate message(s)`);

  const processed = [];
  const skipped = [];
  const errors = [];

  for (const { id } of ids) {
    try {
      const email = await g.getMessage(id);
      const data = await extractFactura(email);

      if (!data.es_factura) {
        skipped.push({ subject: email.subject, reason: 'no es factura' });
        continue;
      }

      // Stable reference for upsert idempotency (fall back to Gmail id).
      const referencia = data.referencia || `GM-${id}`;
      const { year, month } = periodFor(data, email);

      // GUARD 1 — never overwrite an existing alert/pending invoice.
      const { data: existing } = await supabase
        .from('facturas').select('estado').eq('referencia', referencia).maybeSingle();
      if (existing && ['alerta', 'pendiente'].includes(existing.estado)) {
        skipped.push({ subject: email.subject, reason: `protegida (estado=${existing.estado})` });
        console.log(`[factura-agent] ⊘ protegida ${referencia} (estado=${existing.estado})`);
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
            skipped.push({ subject: email.subject, reason: `duplicada de ${dups[0].referencia}` });
            console.log(`[factura-agent] ⊘ duplicada ${referencia} ~ ${dups[0].referencia}`);
            continue;
          }
        }
      }

      // Upload PDF attachments to Drive: O2MAD Facturas / Year / Sociedad / Month
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
          const buf = await g.getAttachment(id, att.attachmentId);
          const up = await g.uploadFile(`${referencia} - ${att.filename}`, buf, folderId);
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
      };
      const { error } = await supabase.from('facturas').upsert(row, { onConflict: 'referencia' });
      if (error) throw new Error(`Supabase: ${error.message}`);

      processed.push({ ...row, sociedad: sociedadName, driveLinks });
      console.log(`[factura-agent] ✓ ${referencia} — ${data.proveedor} (${data.importe ?? 's/imp'})`);
    } catch (e) {
      errors.push({ id, message: e.message });
      console.error(`[factura-agent] ✗ ${id}: ${e.message}`);
    }
  }

  console.log(`[factura-agent] done: ${processed.length} saved, ${skipped.length} skipped, ${errors.length} errors`);
  return { processed, skipped, errors };
}

module.exports = { runFacturaAgent };

// Allow running directly: node backend/agents/factura-agent.js
if (require.main === module) {
  runFacturaAgent().catch(e => { console.error(e); process.exit(1); });
}
