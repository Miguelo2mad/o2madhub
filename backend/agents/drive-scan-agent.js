// Drive scan agent: walk Sandra's invoice Drive folder — ONLY the 2026 folders of each
// sociedad — read every PDF with Claude, assign sociedad by CIF (same rules as
// factura-agent via lib/claude; falls back to the sociedad folder when the CIF can't be
// determined), and upsert into Supabase tagged source_account='drive-sandra'. Dedups by
// referencia: invoices already in the table are skipped.
//
//   node backend/agents/drive-scan-agent.js          → DRY RUN: count PDFs per sociedad
//   node backend/agents/drive-scan-agent.js --apply   → extract + upsert new ones
const { supabase } = require('../lib/supabase');
const g = require('../lib/google');
const { extractFactura, SOCIEDADES } = require('../lib/claude');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');
const CONCURRENCY = 5;

// The 2026 folder of each sociedad (under root DRIVE_INVOICES_FOLDER_ID). The folder's
// sociedad is the fallback when the PDF's CIF doesn't resolve to a group company.
const SOCIEDAD_FOLDERS = [
  { soc: 'd', name: 'O2 Design',   folderId: '1oJutDAVLERJH262qyG5eiNvWKPAzkzF4' },
  { soc: 's', name: 'O2 Strategy', folderId: '1RQATFR6RAux7pSuMuKqBbwLIrBO3DO0n' },
  { soc: 'g', name: 'Gulliver',    folderId: '1_4heriJ7SDlJjEkwHxL1j1ofmO9QfCjd' },
  { soc: 'a', name: 'Apperstreet', folderId: '1nqeopPyT3DoEn-RlMmQ9iOo9f7UutOVD' },
];

async function listChildren(folderId) {
  const out = [];
  let pageToken;
  do {
    const res = await g.drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType,webViewLink)',
      pageSize: 1000, pageToken,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    (res.data.files || []).forEach(f => out.push(f));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

// Recursively collect every PDF under a folder, tagging it with the sociedad + path.
async function collectPdfs(folderId, soc, path, acc) {
  for (const c of await listChildren(folderId)) {
    if (c.mimeType === 'application/vnd.google-apps.folder') {
      await collectPdfs(c.id, soc, [...path, c.name], acc);
    } else if (c.mimeType === 'application/pdf' || /\.pdf$/i.test(c.name || '')) {
      acc.push({ id: c.id, name: c.name, webViewLink: c.webViewLink, soc, path: path.join(' / ') });
    }
  }
  return acc;
}

async function downloadPdf(fileId) {
  const res = await g.drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

async function mapPool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

async function main() {
  if (!process.env.DRIVE_INVOICES_FOLDER_ID) console.warn('[drive-scan] (aviso) DRIVE_INVOICES_FOLDER_ID no está en .env');

  // Collect PDFs per sociedad 2026 folder.
  const all = [];
  for (const sf of SOCIEDAD_FOLDERS) {
    const before = all.length;
    await collectPdfs(sf.folderId, sf.soc, [sf.name, '2026'], all);
    console.log(`[drive-scan] ${sf.name} (2026 → ${sf.soc}): ${all.length - before} PDF(s)`);
  }
  console.log(`[drive-scan] TOTAL: ${all.length} PDF(s)`);

  if (!APPLY) { console.log('\n(DRY RUN — sin Claude ni escritura. Ejecuta con --apply.)'); return; }

  let inserted = 0, dup = 0, skipped = 0, errors = 0;
  await mapPool(all, CONCURRENCY, async (f) => {
    try {
      const buf = await downloadPdf(f.id);
      const email = { id: f.id, subject: f.name, from: '', date: '', bodyText: `Carpeta: ${f.path}`, attachments: [] };
      let data;
      try { data = await extractFactura(email, buf); }
      catch (e) { if (/pdf/i.test(e.message)) { errors++; console.log(`  ✗ PDF ilegible: ${f.path}/${f.name}`); return; } throw e; }
      if (!data.es_factura) { skipped++; return; }

      const referencia = data.referencia || `DRV-${f.id}`;
      const { data: existing } = await supabase.from('facturas').select('referencia').eq('referencia', referencia).maybeSingle();
      if (existing) { dup++; return; }

      // CIF (via the prompt) decides sociedad; fall back to the folder's sociedad if unclear.
      const soc = (data.sociedad_codigo && data.sociedad_codigo !== 'x') ? data.sociedad_codigo : f.soc;

      const row = {
        fecha_factura: data.fecha_factura, proveedor: data.proveedor, referencia,
        concepto: data.concepto, importe: data.importe, sociedad_codigo: soc,
        estado: 'procesada', drive_url: f.webViewLink || null, drive_folder: f.path,
        source_account: 'drive-sandra',
      };
      const { error } = await supabase.from('facturas').upsert(row, { onConflict: 'referencia' });
      if (error) { errors++; console.log(`  ✗ ${referencia}: ${error.message}`); return; }
      inserted++;
      console.log(`  ✓ ${referencia} | ${SOCIEDADES[soc] || soc} | ${data.proveedor} | ${data.importe ?? 's/imp'}€`);
    } catch (e) { errors++; console.log(`  ✗ ${f.path}/${f.name}: ${e.message}`); }
  });

  console.log(`\n[drive-scan] hecho: ${inserted} insertadas, ${dup} ya existían, ${skipped} no-factura, ${errors} errores`);
}

main().catch(e => { console.error(e); process.exit(1); });
