// One-off reclassification: for every factura with a Drive PDF, read the PDF, extract the
// DESTINATARIO (recipient) CIF, and set sociedad_codigo from the CIF. Context (proveedor/
// concepto) is only a fallback when no CIF is found — and even then we only IMPROVE an
// unclassified 'x' row, never downgrade an already-classified one.
//
// Two phases (so the expensive Claude pass runs once):
//   node reclassify-sociedad.js           → DRY RUN: extract, compute proposals, save them,
//                                            print the diff. No DB writes.
//   node reclassify-sociedad.js --apply    → read saved proposals and apply them to Supabase,
//                                            then print the final distribution.
const fs = require('fs');
const { supabase } = require('./backend/lib/supabase');
const g = require('./backend/lib/google');
const { client, SOCIEDADES, SOCIEDADES_INFO } = require('./backend/lib/claude');
require('dotenv').config();

const PROPOSALS = '/tmp/reclassify-proposals.json';
const CONCURRENCY = 5;

// CIF (normalized) -> sociedad code, from the source of truth in claude.js.
const CIF_TO_CODE = {};
for (const [code, info] of Object.entries(SOCIEDADES_INFO)) {
  if (info.cif) CIF_TO_CODE[info.cif.replace(/[\s.\-]/g, '').toUpperCase()] = code;
}

const SYS = `Identifica la SOCIEDAD DESTINATARIA (a quién va dirigida y quién PAGA la factura) de
una factura de proveedor del grupo O2MAD. Extrae el CIF/NIF del DESTINATARIO tal como aparece
en el PDF (datos de "Cliente" / "Facturar a" / "Destinatario"), NUNCA el del emisor/proveedor.

Sociedades del grupo y su CIF:
  d = O2DOSMAD Design & Strategy SL — CIF B55405195
  s = O2 Marketing and Design SL — CIF B57944829
  g = Gulliver Ventures SL — CIF B26829291
  a = Apper Street SL — CIF B57856825

Devuelve:
- destinatario_cif: el CIF del destinatario exactamente como aparece, o null si no se ve.
- destinatario_nombre: la razón social del destinatario, o null.
- sociedad_codigo_contexto: tu mejor estimación del código (d/s/g/a) por el nombre/contexto
  SOLO para usar si no hay CIF; 'x' si no está claro.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    destinatario_cif: { type: ['string', 'null'] },
    destinatario_nombre: { type: ['string', 'null'] },
    sociedad_codigo_contexto: { type: 'string', enum: ['d', 's', 'g', 'a', 'x'] },
  },
  required: ['destinatario_cif', 'destinatario_nombre', 'sociedad_codigo_contexto'],
};

function fileIdFromUrl(url) {
  const m = /\/d\/([^/]+)/.exec(url || '') || /[?&]id=([^&]+)/.exec(url || '');
  return m ? m[1] : null;
}

async function downloadPdf(fileId) {
  const res = await g.drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

async function extractDest(pdfBuffer, proveedor, concepto) {
  const content = [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
    { type: 'text', text: `${SYS}\n\n---\nProveedor (emisor): ${proveedor}\nConcepto: ${concepto}` },
  ];
  const res = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 512,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  return JSON.parse(res.content.find(b => b.type === 'text')?.text || '{}');
}

// Decide the new code. Returns { newCode, method, cif, nombre }.
function decide(current, ext) {
  const rawCif = ext.destinatario_cif;
  const normCif = rawCif ? rawCif.replace(/[\s.\-]/g, '').toUpperCase() : null;
  const ctx = ext.sociedad_codigo_contexto || 'x';

  if (normCif && CIF_TO_CODE[normCif]) {
    return { newCode: CIF_TO_CODE[normCif], method: 'CIF', cif: rawCif, nombre: ext.destinatario_nombre };
  }
  if (normCif) {
    // A CIF was read but it's not one of the group's — don't trust context to override.
    return { newCode: current, method: `CIF-externo(${rawCif})`, cif: rawCif, nombre: ext.destinatario_nombre };
  }
  // No CIF: only IMPROVE an unclassified row; never downgrade a classified one.
  if (current === 'x' && ctx !== 'x') {
    return { newCode: ctx, method: 'contexto (era x)', cif: null, nombre: ext.destinatario_nombre };
  }
  return { newCode: current, method: 'sin CIF (mantiene)', cif: null, nombre: ext.destinatario_nombre };
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0, done = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
      if (++done % 20 === 0) console.log(`  …${done}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function printDistribution(rows) {
  const dist = {};
  for (const r of rows) { const k = r.sociedad_codigo ?? '(null)'; dist[k] = (dist[k] || 0) + 1; }
  console.log('Distribución por sociedad_codigo:');
  for (const k of ['d', 's', 'g', 'a', 'x']) if (dist[k]) console.log(`  ${k} (${SOCIEDADES[k]}): ${dist[k]} filas`);
  console.log(`  TOTAL: ${rows.length}`);
}

async function dryRun() {
  const { data: rows, error } = await supabase
    .from('facturas')
    .select('referencia, proveedor, concepto, sociedad_codigo, drive_url')
    .not('drive_url', 'is', null);
  if (error) throw new Error(error.message);
  console.log(`[reclassify] ${rows.length} facturas con drive_url\n`);

  const results = await mapPool(rows, CONCURRENCY, async (r) => {
    try {
      const fileId = fileIdFromUrl(r.drive_url);
      if (!fileId) return { ...r, error: 'no fileId en drive_url', newCode: r.sociedad_codigo, method: 'error' };
      const pdf = await downloadPdf(fileId);
      const ext = await extractDest(pdf, r.proveedor, r.concepto);
      const d = decide(r.sociedad_codigo, ext);
      return { ...r, ...d };
    } catch (e) {
      return { ...r, error: e.message, newCode: r.sociedad_codigo, method: 'error' };
    }
  });

  const changes = results.filter(r => r.newCode !== r.sociedad_codigo);
  const errors = results.filter(r => r.method === 'error');
  fs.writeFileSync(PROPOSALS, JSON.stringify(results, null, 2));

  console.log(`\n=== CAMBIOS PROPUESTOS: ${changes.length} (de ${results.length}) ===`);
  for (const c of changes) {
    console.log(`  ${c.referencia} | ${c.sociedad_codigo} → ${c.newCode} | ${c.method} | ${c.proveedor} | ${(c.concepto || '').slice(0, 45)}`);
  }
  console.log(`\nMétodo: CIF=${results.filter(r => r.method === 'CIF').length}, ` +
    `contexto(era x)=${results.filter(r => r.method === 'contexto (era x)').length}, ` +
    `CIF-externo=${results.filter(r => r.method.startsWith('CIF-externo')).length}, ` +
    `sin cambio=${results.filter(r => r.method.startsWith('sin CIF')).length}, errores=${errors.length}`);
  if (errors.length) { console.log('Errores:'); errors.forEach(e => console.log(`  ${e.referencia}: ${e.error}`)); }
  console.log(`\nPropuestas guardadas en ${PROPOSALS}. Aplica con: node reclassify-sociedad.js --apply`);
}

async function apply() {
  const results = JSON.parse(fs.readFileSync(PROPOSALS, 'utf8'));
  const changes = results.filter(r => r.newCode !== r.sociedad_codigo);
  console.log(`[reclassify --apply] aplicando ${changes.length} cambios…`);
  let ok = 0, fail = 0;
  await mapPool(changes, CONCURRENCY, async (c) => {
    const { error } = await supabase.from('facturas').update({ sociedad_codigo: c.newCode }).eq('referencia', c.referencia);
    if (error) { fail++; console.error(`  ✗ ${c.referencia}: ${error.message}`); } else ok++;
  });
  console.log(`Aplicados: ${ok}, fallos: ${fail}\n`);

  const { data: all } = await supabase.from('facturas').select('sociedad_codigo');
  printDistribution(all);
}

(async () => {
  if (process.argv.includes('--apply')) await apply();
  else await dryRun();
})().catch(e => { console.error(e); process.exit(1); });
