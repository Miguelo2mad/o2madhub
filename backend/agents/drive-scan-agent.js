// Drive scan agent (STRICT CIF-only): recursively walk the 2026 folder of each sociedad
// in Sandra's invoice Drive, read every PDF, and classify SOLELY by the recipient CIF.
//   CIF found     → insert (sociedad from CIF), source_account='drive-sandra'
//   no CIF / unreadable → NOT inserted; emailed to info@o2mad.com for manual classification
//   never use folder name or proveedor name; dedup by referencia.
//
//   node backend/agents/drive-scan-agent.js          → DRY RUN: count PDFs
//   node backend/agents/drive-scan-agent.js --apply   → classify + insert/email
const g = require('../lib/google');
const { ingestPdf } = require('../lib/strict-ingest');
const { sendNoCifNotice } = require('../api/notifications');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');
const CONCURRENCY = 5;

// Folders to scan (only the 2026 subtree of each). soc is NOT used for classification.
const FOLDERS = [
  { name: 'O2 Design',   folderId: '1oJutDAVLERJH262qyG5eiNvWKPAzkzF4' },
  { name: 'O2 Strategy', folderId: '1RQATFR6RAux7pSuMuKqBbwLIrBO3DO0n' },
  { name: 'Gulliver',    folderId: '1_4heriJ7SDlJjEkwHxL1j1ofmO9QfCjd' },
  { name: 'Apperstreet', folderId: '1nqeopPyT3DoEn-RlMmQ9iOo9f7UutOVD' },
];

async function listChildren(folderId) {
  const out = [];
  let pageToken;
  do {
    const res = await g.drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType,webViewLink)',
      pageSize: 1000, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    (res.data.files || []).forEach(f => out.push(f));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function collectPdfs(folderId, path, acc) {
  for (const c of await listChildren(folderId)) {
    if (c.mimeType === 'application/vnd.google-apps.folder') await collectPdfs(c.id, [...path, c.name], acc);
    else if (c.mimeType === 'application/pdf' || /\.pdf$/i.test(c.name || '')) acc.push({ id: c.id, name: c.name, webViewLink: c.webViewLink, path: path.join(' / ') });
  }
  return acc;
}

// Resolve the 2026 scan root (some IDs are the "2026" folder, others the sociedad root).
async function resolve2026(sf) {
  const meta = await g.drive.files.get({ fileId: sf.folderId, fields: 'name', supportsAllDrives: true });
  if (/^2026$/.test((meta.data.name || '').trim())) return sf.folderId;
  const child = (await listChildren(sf.folderId)).find(c => c.mimeType === 'application/vnd.google-apps.folder' && /^2026$/.test((c.name || '').trim()));
  return child ? child.id : sf.folderId;
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
  const pdfs = [];
  for (const sf of FOLDERS) {
    const before = pdfs.length;
    await collectPdfs(await resolve2026(sf), [sf.name, '2026'], pdfs);
    console.log(`[drive-scan] ${sf.name} 2026: ${pdfs.length - before} PDF(s)`);
  }
  console.log(`[drive-scan] TOTAL: ${pdfs.length} PDF(s)`);
  if (!APPLY) { console.log('\n(DRY RUN — sin Claude ni escritura.)'); return; }

  let inserted = 0, dup = 0, skip = 0;
  const noCif = [];
  await mapPool(pdfs, CONCURRENCY, async (f) => {
    let buf;
    try { buf = await downloadPdf(f.id); }
    catch (e) { console.log(`  ✗ descarga ${f.path}/${f.name}: ${e.message}`); return; }
    const email = { subject: f.name, bodyText: `Carpeta: ${f.path}` };
    const r = await ingestPdf({ buf, email, source: 'drive-sandra', drive_url: f.webViewLink, drive_folder: f.path, refFallback: `DRV-${f.id}` });
    if (r.status === 'inserted') { inserted++; console.log(`  ✓ ${r.referencia} → ${r.sociedad} | ${r.proveedor} | ${r.importe ?? 's/imp'}€`); }
    else if (r.status === 'dup') dup++;
    else if (r.status === 'skip') skip++;
    else if (r.status === 'nocif') noCif.push({ ...r.info, buf, filename: f.name });
    else if (r.status === 'unreadable') noCif.push({ proveedor: '(PDF ilegible)', referencia: null, importe: null, source: 'drive-sandra', link: f.webViewLink, buf, filename: f.name });
    else if (r.status === 'error') console.log(`  ✗ ${f.name}: ${r.message}`);
  });

  console.log(`\n[drive-scan] insertadas ${inserted} · dup ${dup} · no-gasto ${skip} · sin-CIF→email ${noCif.length}`);
  if (noCif.length) { try { await sendNoCifNotice(noCif, 'Drive 2026'); } catch (e) { console.error('[drive-scan] email sin-CIF falló:', e.message); } }
}

main().catch(e => { console.error(e); process.exit(1); });
