// One-off: apply the strict CIF-only rule to existing Gmail rows (o2mad + apper).
//   protected (Miguel's manual rules: Macaque, Pedro Béjar/Agesbal, Google One, POM) → keep
//   else re-read PDF from drive_url → CIF found: set sociedad by CIF · no CIF (or no PDF):
//   move to 'x' and add to the manual-classification email.
const fs = require('fs');
const { supabase } = require('./backend/lib/supabase');
const g = require('./backend/lib/google');
const { extractStrict } = require('./backend/lib/claude');
const { sendNoCifNotice } = require('./backend/api/notifications');
require('dotenv').config();

const CONCURRENCY = 5;
const esc = s => "'" + String(s).replace(/'/g, "''") + "'";
const fileId = u => { const m = /\/d\/([^/]+)/.exec(u || '') || /[?&]id=([^&]+)/.exec(u || ''); return m ? m[1] : null; };
const PROT = r => /macaque|b[eé]jar|agesbal|pom design/i.test(r.proveedor || '') || /google one/i.test(r.concepto || '');

async function dl(id) { const r = await g.drive.files.get({ fileId: id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }); return Buffer.from(r.data); }
async function mapPool(items, limit, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const idx = i++; await fn(items[idx], idx); } })); }

(async () => {
  const { data: rows } = await supabase.from('facturas')
    .select('referencia, proveedor, concepto, importe, sociedad_codigo, drive_url, source_account')
    .in('source_account', ['o2mad', 'apper']);
  const toVerify = rows.filter(r => !PROT(r));
  console.log(`Gmail: ${rows.length} | protegidas ${rows.length - toVerify.length} | a re-verificar ${toVerify.length}`);

  const toX = [];          // referencias → 'x'
  const corrections = [];  // { ref, soc } CIF-confirmed (set sociedad)
  const noCif = [];        // for the email

  await mapPool(toVerify, CONCURRENCY, async (r) => {
    if (!r.drive_url) { toX.push(r.referencia); noCif.push({ proveedor: r.proveedor, importe: r.importe, referencia: r.referencia, source: r.source_account, link: null }); return; }
    let buf;
    try { buf = await dl(fileId(r.drive_url)); }
    catch { toX.push(r.referencia); noCif.push({ proveedor: r.proveedor, importe: r.importe, referencia: r.referencia, source: r.source_account, link: r.drive_url }); return; }
    let data;
    try { data = await extractStrict({ subject: r.proveedor, bodyText: r.concepto || '' }, buf); }
    catch { toX.push(r.referencia); noCif.push({ proveedor: r.proveedor, importe: r.importe, referencia: r.referencia, source: r.source_account, link: r.drive_url, buf, filename: `${r.referencia}.pdf` }); return; }
    if (data.sociedad_por_cif) {
      if (data.sociedad_por_cif !== r.sociedad_codigo) corrections.push({ ref: r.referencia, soc: data.sociedad_por_cif });
    } else {
      toX.push(r.referencia);
      noCif.push({ proveedor: r.proveedor, importe: r.importe, referencia: r.referencia, source: r.source_account, link: r.drive_url, buf, filename: `${r.referencia}.pdf` });
    }
  });

  console.log(`\nCIF-confirmadas con corrección de sociedad: ${corrections.length}`);
  corrections.forEach(c => console.log(`  ${c.ref} → ${c.soc}`));
  console.log(`Sin CIF → 'x': ${toX.length}`);

  // migration 017
  let sql = "-- o2madhub — migration 017: strict CIF-only cleanup of Gmail rows.\n-- No CIF (or no PDF) → 'x'; CIF-confirmed corrected to the CIF sociedad. Manual rules\n-- (Macaque, Pedro Béjar/Agesbal, Google One, POM) left untouched. Safe to re-run.\n";
  if (toX.length) sql += `\nupdate public.facturas set sociedad_codigo='x' where referencia in (\n${toX.map(r => '  ' + esc(r)).join(',\n')}\n);\n`;
  const byTo = {}; corrections.forEach(c => (byTo[c.soc] = byTo[c.soc] || []).push(c.ref));
  for (const [soc, refs] of Object.entries(byTo)) sql += `\nupdate public.facturas set sociedad_codigo=${esc(soc)} where referencia in (${refs.map(esc).join(', ')});\n`;
  fs.writeFileSync('database/migrations/017_gmail_strict_cif_cleanup.sql', sql);

  // apply
  for (let i = 0; i < toX.length; i += 100) await supabase.from('facturas').update({ sociedad_codigo: 'x' }).in('referencia', toX.slice(i, i + 100));
  for (const [soc, refs] of Object.entries(byTo)) await supabase.from('facturas').update({ sociedad_codigo: soc }).in('referencia', refs);
  console.log('Aplicado + migración 017 escrita.');

  if (noCif.length) { try { await sendNoCifNotice(noCif, 'Gmail cleanup (o2mad + apper)'); } catch (e) { console.error('email falló:', e.message); } }

  const { data: all } = await supabase.from('facturas').select('sociedad_codigo, importe, source_account');
  const { SOCIEDADES } = require('./backend/lib/claude');
  const d = {}; for (const r of all) { const k = r.sociedad_codigo ?? '(null)'; d[k] = d[k] || { n: 0, s: 0 }; d[k].n++; d[k].s += Number(r.importe) || 0; }
  console.log('\n=== Distribución FINAL ===');
  for (const k of ['d', 's', 'a', 'g', 'x']) if (d[k]) console.log(`  ${k} (${SOCIEDADES[k]}): ${d[k].n} filas — ${d[k].s.toFixed(2)} €`);
  console.log(`  TOTAL: ${all.length}`);
  const src = {}; for (const r of all) { const k = r.source_account ?? '(null)'; src[k] = (src[k] || 0) + 1; }
  console.log('source_account: ' + Object.entries(src).map(([k, v]) => `${k}:${v}`).join('  '));
})().catch(e => { console.error(e); process.exit(1); });
