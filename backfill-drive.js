// Backfill drive_url / drive_folder for existing facturas that have none.
// For each factura without a drive_url:
//   1. Search Gmail for the invoice by referencia (with attachment).
//   2. Download the PDF attachment.
//   3. Read the PDF with Claude → real emission date + recipient sociedad.
//   4. Upload the PDF to O2MAD Facturas / Year / Sociedad / Month.
//   5. Update drive_url, drive_folder (and, for non-alert rows, fecha_factura + sociedad_codigo).
//
// Usage: node backfill-drive.js
const { supabase } = require('./backend/lib/supabase');
const g = require('./backend/lib/google');
const { extractFactura, SOCIEDADES } = require('./backend/lib/claude');
require('dotenv').config();

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const ROOT_FOLDER = 'O2MAD Facturas';

function periodFromDate(dateStr) {
  const d = dateStr ? new Date(dateStr) : null;
  const valid = d && !isNaN(d.getTime()) ? d : new Date();
  return { year: String(valid.getFullYear()), month: MESES[valid.getMonth()] };
}

async function backfill() {
  const { data: pending, error } = await supabase.from('facturas')
    .select('id,referencia,proveedor,fecha_factura,sociedad_codigo,estado,drive_url')
    .is('drive_url', null);
  if (error) throw new Error(`Supabase: ${error.message}`);
  console.log(`[backfill] ${pending.length} facturas without drive_url`);

  let populated = 0, notFound = 0, noPdf = 0, errors = 0;

  for (const f of pending) {
    try {
      // Find the invoice email by referencia (whole mailbox, must have an attachment).
      const msgs = await g.listMessages(`"${f.referencia}" has:attachment`, 5);
      let done = false;

      for (const { id } of msgs) {
        const email = await g.getMessage(id);
        const att = email.attachments[0];
        if (!att) continue; // no PDF on this message

        const buf = await g.getAttachment(id, att.attachmentId);
        // If Claude can't parse the PDF (corrupt / not really a PDF), fall back to
        // text-only extraction — the file still uploads to Drive regardless.
        let data;
        try {
          data = await extractFactura(email, buf);
        } catch (e) {
          if (/pdf|PDF/.test(e.message)) {
            console.log(`[backfill]   (PDF ilegible para ${f.referencia}, usando texto del correo)`);
            data = await extractFactura(email, null);
          } else throw e;
        }

        // Preserve curated alert/pending rows: attach the PDF but don't rewrite date/sociedad.
        const isProtected = ['alerta', 'pendiente'].includes(f.estado);
        const fecha = isProtected ? f.fecha_factura : (data.fecha_factura || f.fecha_factura);
        const soc = isProtected ? f.sociedad_codigo : (data.sociedad_codigo || f.sociedad_codigo);

        const { year, month } = periodFromDate(fecha);
        const sociedadName = SOCIEDADES[soc] || soc;
        const rootId = process.env.DRIVE_ROOT_FOLDER_ID || null;
        const pathNames = rootId ? [year, sociedadName, month] : [ROOT_FOLDER, year, sociedadName, month];
        const folderId = await g.ensureFolderPath(pathNames, rootId);

        const fname = `${f.referencia} - ${att.filename}`;
        const existing = await g.findFileInFolder(fname, folderId);
        const up = existing || await g.uploadFile(fname, buf, folderId);
        const driveFolder = [ROOT_FOLDER, year, sociedadName, month].join('/');

        const update = { drive_url: up.webViewLink, drive_folder: driveFolder };
        if (!isProtected) { update.fecha_factura = fecha; update.sociedad_codigo = soc; }

        const { error: uerr } = await supabase.from('facturas').update(update).eq('id', f.id);
        if (uerr) throw new Error(`Supabase: ${uerr.message}`);

        populated++;
        console.log(`[backfill] ✓ ${f.referencia} → ${driveFolder}${isProtected ? '  (protegida: fecha/sociedad intactas)' : `  (fecha ${fecha}, soc ${soc})`}`);
        done = true;
        break;
      }

      if (!done) {
        if (msgs.length === 0) { notFound++; console.log(`[backfill] – ${f.referencia}: no encontrada en Gmail`); }
        else { noPdf++; console.log(`[backfill] – ${f.referencia}: sin PDF en los resultados`); }
      }
    } catch (e) {
      errors++;
      console.error(`[backfill] ✗ ${f.referencia}: ${e.message}`);
    }
  }

  console.log(`\n[backfill] DONE — ${populated} populated, ${notFound} not found in Gmail, ${noPdf} found-but-no-PDF, ${errors} errors (of ${pending.length})`);
  return { populated, notFound, noPdf, errors, total: pending.length };
}

backfill().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
