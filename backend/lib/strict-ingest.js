// Strict CIF-only ingest, shared by the Drive scan and the Apper Gmail scan.
// Rules (in order, no exceptions):
//   1. read the PDF  2. find DESTINATARIO CIF  3. CIF → sociedad (B55405195=d, B57944829=s,
//   B26829291=g, B57856825=a)  4. no CIF → DON'T insert (caller emails info@o2mad.com)
//   5. never use folder/proveedor name to assign sociedad  6. dedup by referencia.
const { supabase } = require('./supabase');
const { extractStrict } = require('./claude');
require('dotenv').config();

// Process one PDF. Returns { status, ... }:
//   inserted | dup | skip (not an expense we pay) | unreadable | nocif | error
async function ingestPdf({ buf, email, source, drive_url = null, drive_folder = null, refFallback }) {
  let data;
  try { data = await extractStrict(email, buf); }
  catch (e) { if (/pdf/i.test(e.message)) return { status: 'unreadable' }; throw e; }

  // Only invoices we PAY. Sales invoices we issued (O2MAD emisor) / non-invoices are skipped.
  if (!data.es_factura || data.es_emitida_por_o2mad) return { status: 'skip' };

  const referencia = data.referencia || refFallback;
  const { data: existing } = await supabase.from('facturas').select('referencia').eq('referencia', referencia).maybeSingle();
  if (existing) return { status: 'dup', referencia };

  // RULE 4: no group CIF → do not classify, do not insert.
  if (!data.sociedad_por_cif) {
    return { status: 'nocif', info: { proveedor: data.proveedor, importe: data.importe, referencia: data.referencia, source, link: drive_url } };
  }

  const row = {
    fecha_factura: data.fecha_factura, proveedor: data.proveedor, referencia,
    concepto: data.concepto, importe: data.importe, sociedad_codigo: data.sociedad_por_cif,
    estado: 'procesada', drive_url, drive_folder, source_account: source,
  };
  const { error } = await supabase.from('facturas').upsert(row, { onConflict: 'referencia' });
  if (error) return { status: 'error', message: error.message };
  return { status: 'inserted', referencia, sociedad: data.sociedad_por_cif, proveedor: data.proveedor, importe: data.importe };
}

module.exports = { ingestPdf };
