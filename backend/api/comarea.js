// Comarea invoice module: manual upload via Claude Vision + Drive archive.
// Mount in index.js with: app.use('/comarea', require('./backend/api/comarea'))
const express = require('express');
const multer  = require('multer');
const { supabase } = require('../lib/supabase');
const { client } = require('../lib/claude');
const { ensureFolderPath, uploadFile } = require('../lib/google');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// ── Auth: usuarios/contraseñas por env vars ─────────────────────────────────
// Token = base64('usuario:timestamp'). requireAuth lo decodifica y consulta COMAREA_USERS.

const COMAREA_USERS = {
  restaurante: { pass: process.env.COMAREA_PASS_RESTAURANTE || 'comarea2025', role: 'restaurante' },
  gestor:      { pass: process.env.COMAREA_PASS_GESTOR      || 'gestor2025',  role: 'gestor' },
  admin:       { pass: process.env.COMAREA_PASS_ADMIN       || 'o2mad2025',   role: 'admin' },
};

function requireAuth(req, res, next) {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (!raw) return res.status(401).json({ error: 'No autorizado' });
  try {
    const [usuario] = Buffer.from(raw, 'base64').toString().split(':');
    const u = COMAREA_USERS[usuario?.toLowerCase()];
    if (!u) return res.status(401).json({ error: 'No autorizado' });
    req.user = { email: usuario };
    req.role = u.role;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.role)) return res.status(403).json({ error: 'Acceso denegado' });
    next();
  };
}

// ── Claude Vision extraction ────────────────────────────────────────────────

const COMAREA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    proveedor:      { type: 'string' },
    numero_factura: { type: ['string', 'null'] },
    fecha_factura:  { type: ['string', 'null'], description: 'YYYY-MM-DD o null' },
    importe_total:  { type: ['number', 'null'], description: 'Importe total con IVA en EUR' },
    importe_base:   { type: ['number', 'null'], description: 'Base imponible en EUR' },
    iva_porcentaje: { type: ['number', 'null'], description: 'Porcentaje de IVA (ej: 21 para 21%)' },
    concepto:       { type: ['string', 'null'] },
    cif_proveedor:  { type: ['string', 'null'], description: 'CIF/NIF del emisor exactamente como aparece' },
  },
  required: ['proveedor', 'numero_factura', 'fecha_factura', 'importe_total',
    'importe_base', 'iva_porcentaje', 'concepto', 'cif_proveedor'],
};

async function extractComarea(buffer, mimeType) {
  const isImage = mimeType.startsWith('image/');
  const fileBlock = isImage
    ? { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } }
    : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };

  const res = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: COMAREA_SCHEMA },
    },
    messages: [{
      role: 'user',
      content: [
        fileBlock,
        { type: 'text', text: 'Extrae los datos de esta factura de proveedor. fecha_factura en YYYY-MM-DD. iva_porcentaje como número (ej: 21). Si no encuentras un campo devuelve null.' },
      ],
    }],
  });

  return {
    data:  JSON.parse(res.content.find(b => b.type === 'text')?.text || '{}'),
    usage: res.usage,
  };
}

// Precios Sonnet: input 0.000003 €/token, output 0.000015 €/token
async function trackTokens(operacion, usage, usuario) {
  const input  = usage?.input_tokens  || 0;
  const output = usage?.output_tokens || 0;
  const coste  = (input * 0.000003) + (output * 0.000015);
  const { error } = await supabase.from('comarea_token_usage').insert({ operacion, input_tokens: input, output_tokens: output, coste_euros: coste, usuario });
  if (error) console.error('[comarea] token tracking:', error.message);
}

// ── Routes ──────────────────────────────────────────────────────────────────

// POST /comarea/login
router.post('/login', (req, res) => {
  const { usuario, password } = req.body || {};
  if (!usuario || !password) return res.status(400).json({ ok: false, error: 'Usuario y contraseña requeridos' });
  const u = COMAREA_USERS[usuario.toLowerCase()];
  if (!u || u.pass !== password) return res.status(401).json({ ok: false, error: 'Credenciales incorrectas' });
  const token = Buffer.from(`${usuario}:${Date.now()}`).toString('base64');
  res.json({ ok: true, token, role: u.role, usuario });
});

// POST /comarea/facturas/upload
router.post('/facturas/upload', requireAuth, upload.single('factura'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo en el campo "factura"' });

  try {
    const { buffer, originalname, mimetype } = req.file;

    const { data, usage } = await extractComarea(buffer, mimetype);
    trackTokens('upload_factura', usage, req.user.email);

    const d = data.fecha_factura ? new Date(data.fecha_factura) : new Date();
    const year = String(d.getFullYear());
    const monthIndex = d.getMonth();
    const monthFolder = `${String(monthIndex + 1).padStart(2, '0')}-${MESES[monthIndex]}`;

    // O2MAD Facturas / Clientes Externos / Comarea / YYYY / MM-NombreMes
    const rootId = process.env.DRIVE_ROOT_FOLDER_ID || null;
    const pathNames = rootId
      ? ['Clientes Externos', 'Comarea', year, monthFolder]
      : ['O2MAD Facturas', 'Clientes Externos', 'Comarea', year, monthFolder];
    const folderId = await ensureFolderPath(pathNames, rootId);

    const safeName = (data.numero_factura || String(Date.now())).replace(/[/\\:*?"<>|]/g, '-');
    const fileName = `${safeName} - ${data.proveedor || 'factura'}.${mimetype === 'application/pdf' ? 'pdf' : 'jpg'}`;
    const uploaded = await uploadFile(fileName, buffer, folderId, mimetype);

    const row = {
      proveedor:      data.proveedor,
      numero_factura: data.numero_factura,
      fecha_factura:  data.fecha_factura,
      importe_total:  data.importe_total,
      importe_base:   data.importe_base,
      iva_porcentaje: data.iva_porcentaje,
      concepto:       data.concepto,
      cif_proveedor:  data.cif_proveedor,
      drive_file_id:  uploaded.id,
      drive_url:      uploaded.webViewLink,
      mes:            monthIndex + 1,
      anyo:           Number(year),
      subido_por:     req.user.email,
    };

    const { data: saved, error: dbError } = await supabase
      .from('comarea_facturas').insert(row).select().single();
    if (dbError) throw new Error(`Supabase: ${dbError.message}`);

    console.log(`[comarea] ✓ ${data.numero_factura} — ${data.proveedor} (${data.importe_total ?? 's/imp'})`);
    res.json({ ok: true, factura: saved });
  } catch (e) {
    console.error('[comarea] upload error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /comarea/facturas
router.get('/facturas', requireAuth, async (req, res) => {
  const { mes, anyo, proveedor } = req.query;
  let q = supabase.from('comarea_facturas').select('*').order('fecha_factura', { ascending: false });
  if (mes)       q = q.eq('mes', Number(mes));
  if (anyo)      q = q.eq('anyo', Number(anyo));
  if (proveedor) q = q.ilike('proveedor', `%${proveedor}%`);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /comarea/analytics
router.get('/analytics', requireAuth, async (req, res) => {
  const { anyo } = req.query;
  let q = supabase.from('comarea_facturas').select('mes, anyo, importe_total, importe_base, proveedor');
  if (anyo) q = q.eq('anyo', Number(anyo));
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const byMes = {};
  const byProveedor = {};

  for (const f of data) {
    const key = `${f.anyo}-${String(f.mes).padStart(2, '0')}`;
    if (!byMes[key]) byMes[key] = { mes: f.mes, anyo: f.anyo, total: 0, base: 0, count: 0 };
    byMes[key].total += Number(f.importe_total) || 0;
    byMes[key].base  += Number(f.importe_base)  || 0;
    byMes[key].count += 1;

    if (!byProveedor[f.proveedor]) byProveedor[f.proveedor] = { total: 0, count: 0 };
    byProveedor[f.proveedor].total += Number(f.importe_total) || 0;
    byProveedor[f.proveedor].count += 1;
  }

  res.json({
    total_facturas: data.length,
    total_importe:  data.reduce((s, f) => s + (Number(f.importe_total) || 0), 0),
    por_mes: Object.values(byMes).sort((a, b) => a.anyo - b.anyo || a.mes - b.mes),
    por_proveedor: Object.entries(byProveedor)
      .map(([proveedor, v]) => ({ proveedor, ...v }))
      .sort((a, b) => b.total - a.total),
  });
});

// GET /comarea/tokens — solo admin
router.get('/tokens', requireAuth, requireRole('admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('comarea_token_usage').select('input_tokens, output_tokens, coste_euros, created_at');
  if (error) return res.status(500).json({ error: error.message });

  const now = new Date();
  const mesData = data.filter(r => {
    const d = new Date(r.created_at);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });

  const { data: facturas } = await supabase
    .from('comarea_facturas').select('id', { count: 'exact', head: true });

  res.json({
    total_input_tokens:  data.reduce((s, r) => s + (r.input_tokens  || 0), 0),
    total_output_tokens: data.reduce((s, r) => s + (r.output_tokens || 0), 0),
    coste_total_euros:   data.reduce((s, r) => s + Number(r.coste_euros || 0), 0),
    coste_mes_actual:    mesData.reduce((s, r) => s + Number(r.coste_euros || 0), 0),
    llamadas_total:      data.length,
  });
});

// GET /comarea/drive/meses — solo gestor/admin
router.get('/drive/meses', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
  const { anyo } = req.query;
  let q = supabase.from('comarea_facturas').select('mes, anyo, drive_url').not('drive_url', 'is', null);
  if (anyo) q = q.eq('anyo', Number(anyo));
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const meses = {};
  for (const f of data) {
    const key = `${f.anyo}-${String(f.mes).padStart(2, '0')}`;
    if (!meses[key]) {
      meses[key] = {
        mes:      f.mes,
        anyo:     f.anyo,
        label:    `${String(f.mes).padStart(2, '0')}-${MESES[f.mes - 1]}`,
        facturas: 0,
      };
    }
    meses[key].facturas += 1;
  }

  res.json(Object.values(meses).sort((a, b) => a.anyo - b.anyo || a.mes - b.mes));
});

module.exports = router;
