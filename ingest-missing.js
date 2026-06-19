// One-off: ingest specific invoices that the daily agent's keyword query never caught
// (they arrive inside human reply/forward threads). Targets a few Gmail searches, reads
// EVERY PDF attachment, extracts with Claude, and (with --apply) uploads to Drive + inserts
// into Supabase tagged source_account='o2mad'. Dedups by referencia; skips O2MAD sales
// invoices (es_factura=false) and anything already in the DB.
//
//   node ingest-missing.js           → DRY RUN (extract + show candidates, no writes)
//   node ingest-missing.js --apply   → upload + insert the new ones
const { supabase } = require('./backend/lib/supabase');
const g = require('./backend/lib/google');
const { extractFactura, SOCIEDADES } = require('./backend/lib/claude');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');
const ROOT_FOLDER = 'O2MAD Facturas';
const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

const QUERIES = [
  ['BSB',                'newer_than:180d has:attachment (from:bielsb@bsbadministracio.es OR from:gestio@bsbadministracio.es OR from:mail@bsbadministracio.es OR from:laboral@bsbadministracio.es)'],
  ['Sandra-sociedad',    'newer_than:180d has:attachment from:sandra@o2mad.com subject:(sociedad OR factura)'],
  ['Estilismo',          'newer_than:180d has:attachment subject:estilismo'],
  ['Assessoria Diagonal','newer_than:180d has:attachment "Assessoria Diagonal"'],
];

function periodFor(data, email) {
  const d = data.fecha_factura ? new Date(data.fecha_factura) : new Date(email.date);
  const valid = !isNaN(d.getTime()) ? d : new Date();
  return { year: String(valid.getFullYear()), month: MESES[valid.getMonth()] };
}

async function main() {
  const seenMsg = new Set();
  const candidates = [];

  for (const [label, q] of QUERIES) {
    const ids = await g.listMessages(q, 25);
    console.log(`[${label}] ${ids.length} mensajes`);
    for (const { id } of ids) {
      if (seenMsg.has(id)) continue;
      seenMsg.add(id);
      const email = await g.getMessage(id);
      if (!email.attachments.length) continue;
      // Process EVERY PDF attachment (forwarded threads can carry several invoices).
      for (const att of email.attachments) {
        try {
          const buf = await g.getAttachment(id, att.attachmentId);
          let data;
          try { data = await extractFactura(email, buf); }
          catch (e) { if (/pdf/i.test(e.message)) { console.log(`   (PDF ilegible ${att.filename})`); continue; } throw e; }
          if (!data.es_factura) continue;
          const referencia = data.referencia || `GM-${id}`;
          candidates.push({ id, label, att: att.filename, referencia, data, email });
        } catch (e) { console.log(`   ✗ ${att.filename}: ${e.message}`); }
      }
    }
  }

  // Dedup against the DB and within this batch.
  const refs = [...new Set(candidates.map(c => c.referencia))];
  const existing = new Set();
  for (let i = 0; i < refs.length; i += 100) {
    const { data } = await supabase.from('facturas').select('referencia').in('referencia', refs.slice(i, i + 100));
    (data || []).forEach(r => existing.add(r.referencia));
  }
  const seenRef = new Set();
  const toInsert = candidates.filter(c => {
    if (existing.has(c.referencia) || seenRef.has(c.referencia)) return false;
    seenRef.add(c.referencia); return true;
  });

  console.log(`\n=== NUEVAS a insertar: ${toInsert.length} (candidatas ${candidates.length}, ya en BD ${candidates.length - toInsert.length}) ===`);
  for (const c of toInsert) {
    const soc = SOCIEDADES[c.data.sociedad_codigo] || c.data.sociedad_codigo;
    console.log(`  [${c.label}] ${c.referencia} | ${c.data.proveedor} | ${soc}(${c.data.sociedad_codigo}) | ${c.data.importe ?? 's/imp'}€ | ${(c.data.concepto||'').slice(0,40)}`);
  }

  if (!APPLY) { console.log('\n(DRY RUN — nada insertado. Ejecuta con --apply.)'); return; }

  let ok = 0;
  for (const c of toInsert) {
    const { data, email, referencia } = c;
    const sociedadName = SOCIEDADES[data.sociedad_codigo] || data.sociedad_codigo;
    const { year, month } = periodFor(data, email);
    // Upload PDFs to the shared Drive archive.
    const rootId = process.env.DRIVE_ROOT_FOLDER_ID || null;
    const pathNames = rootId ? [year, sociedadName, month] : [ROOT_FOLDER, year, sociedadName, month];
    const folderId = await g.ensureFolderPath(pathNames, rootId);
    const driveLinks = [];
    for (const att of email.attachments) {
      const fname = `${referencia} - ${att.filename}`;
      const ex = await g.findFileInFolder(fname, folderId);
      if (ex) { driveLinks.push(ex.webViewLink); continue; }
      const buf = await g.getAttachment(email.id, att.attachmentId);
      const up = await g.uploadFile(fname, buf, folderId);
      driveLinks.push(up.webViewLink);
    }
    const row = {
      fecha_factura: data.fecha_factura, proveedor: data.proveedor, referencia,
      concepto: data.concepto, importe: data.importe, sociedad_codigo: data.sociedad_codigo,
      estado: 'procesada', drive_url: driveLinks[0] || null,
      drive_folder: driveLinks.length ? [ROOT_FOLDER, year, sociedadName, month].join('/') : null,
      source_account: 'o2mad',
    };
    const { error } = await supabase.from('facturas').upsert(row, { onConflict: 'referencia' });
    if (error) { console.log(`  ✗ ${referencia}: ${error.message}`); continue; }
    ok++; console.log(`  ✓ insertada ${referencia} → ${sociedadName}`);
  }
  console.log(`\nInsertadas: ${ok}/${toInsert.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
