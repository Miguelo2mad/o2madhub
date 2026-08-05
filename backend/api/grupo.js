// Grupo O2MAD — subida manual de tickets/facturas de las 4 sociedades del grupo,
// con selección manual de sociedad (a diferencia del pipeline automático de Gmail/Drive,
// que solo clasifica por CIF). Escribe en la tabla `facturas` principal, así que aparece
// directamente en el dashboard de siempre (index.html) sin cambios adicionales.
// Mount in index.js with: app.use('/grupo', require('./backend/api/grupo'))
const express = require('express');
const multer  = require('multer');
const { supabase } = require('../lib/supabase');
const { client, SOCIEDADES } = require('../lib/claude');
const { ensureFolderPath, uploadFile, deleteFile } = require('../lib/google');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const ROOT_FOLDER = 'O2MAD Facturas';
const SOCIEDADES_VALIDAS = ['d', 's', 'g', 'a']; // nunca 'x': aquí el usuario siempre la conoce

// ── Auth: un único usuario, para uso personal ───────────────────────────────
// Token = base64('usuario:timestamp'). requireAuth lo decodifica y valida contra GRUPO_PASS.

function requireAuth(req, res, next) {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (!raw) return res.status(401).json({ error: 'No autorizado' });
  try {
    const [usuario] = Buffer.from(raw, 'base64').toString().split(':');
    if (usuario?.toLowerCase() !== 'admin') return res.status(401).json({ error: 'No autorizado' });
    req.user = { email: usuario };
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

// ── Claude Vision extraction ────────────────────────────────────────────────

const GRUPO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    proveedor:     { type: 'string' },
    referencia:    { type: ['string', 'null'], description: 'Número de factura o ticket tal como aparece' },
    fecha_factura: { type: ['string', 'null'], description: 'YYYY-MM-DD o null' },
    importe:       { type: ['number', 'null'], description: 'Importe total con IVA en EUR' },
    concepto:      { type: ['string', 'null'] },
  },
  required: ['proveedor', 'referencia', 'fecha_factura', 'importe', 'concepto'],
};

async function extractGrupo(buffer, mimeType) {
  const isImage = mimeType.startsWith('image/');
  const fileBlock = isImage
    ? { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } }
    : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };

  const res = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: GRUPO_SCHEMA },
    },
    messages: [{
      role: 'user',
      content: [
        fileBlock,
        { type: 'text', text: 'Extrae los datos de este ticket o factura. fecha_factura en YYYY-MM-DD. '
          + 'referencia es el número de factura/ticket tal como aparece. Si no encuentras un campo devuelve null.' },
      ],
    }],
  });

  return JSON.parse(res.content.find(b => b.type === 'text')?.text || '{}');
}

// ── Routes ──────────────────────────────────────────────────────────────────

// POST /grupo/login
router.post('/login', (req, res) => {
  const { usuario, password } = req.body || {};
  if (!usuario || !password) return res.status(400).json({ ok: false, error: 'Usuario y contraseña requeridos' });
  const pass = process.env.GRUPO_PASS || 'grupo2025';
  if (usuario.toLowerCase() !== 'admin' || password !== pass) {
    return res.status(401).json({ ok: false, error: 'Credenciales incorrectas' });
  }
  const token = Buffer.from(`${usuario}:${Date.now()}`).toString('base64');
  res.json({ ok: true, token, usuario });
});

// GET /grupo/sociedades — para poblar el selector sin hardcodear nombres en el frontend
router.get('/sociedades', requireAuth, (req, res) => {
  res.json(SOCIEDADES_VALIDAS.map(code => ({ code, nombre: SOCIEDADES[code] })));
});

// POST /grupo/facturas/upload
router.post('/facturas/upload', requireAuth, upload.single('factura'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo en el campo "factura"' });
  const sociedad = req.body.sociedad;
  if (!SOCIEDADES_VALIDAS.includes(sociedad)) {
    return res.status(400).json({ error: `sociedad inválida: debe ser una de ${SOCIEDADES_VALIDAS.join(', ')}` });
  }

  try {
    const { buffer, mimetype } = req.file;
    const data = await extractGrupo(buffer, mimetype);

    const referencia = data.referencia || `MANUAL-${Date.now()}`;

    // Evita duplicados: si ya existe esa referencia, no se vuelve a guardar
    // (misma referencia física puede reintentarse por error de subida).
    const { data: existing } = await supabase
      .from('facturas').select('referencia').eq('referencia', referencia).maybeSingle();
    if (existing) {
      return res.status(409).json({
        ok: false,
        error: `Ya existe una factura con referencia ${referencia}, no se ha vuelto a guardar.`,
      });
    }

    const d = data.fecha_factura ? new Date(data.fecha_factura) : new Date();
    const year = String(d.getFullYear());
    const monthIndex = isNaN(d.getTime()) ? new Date().getMonth() : d.getMonth();
    const sociedadName = SOCIEDADES[sociedad];

    // O2MAD Facturas / Year / Sociedad / Month — mismo árbol que usa el pipeline
    // automático (Gmail/Drive scan), para que todo quede junto en Drive.
    const rootId = process.env.DRIVE_ROOT_FOLDER_ID || null;
    const pathNames = rootId
      ? [year, sociedadName, MESES[monthIndex]]
      : [ROOT_FOLDER, year, sociedadName, MESES[monthIndex]];
    const folderId = await ensureFolderPath(pathNames, rootId);

    const safeName = referencia.replace(/[/\\:*?"<>|]/g, '-');
    const fileName = `${safeName} - ${data.proveedor || 'factura'}.${mimetype === 'application/pdf' ? 'pdf' : 'jpg'}`;
    const uploaded = await uploadFile(fileName, buffer, folderId, mimetype);

    const row = {
      fecha_factura:   data.fecha_factura,
      proveedor:       data.proveedor,
      referencia,
      concepto:        data.concepto,
      importe:         data.importe,
      sociedad_codigo: sociedad,
      estado:          'procesada',
      drive_url:       uploaded.webViewLink,
      drive_file_id:   uploaded.id,
      drive_folder:    pathNames.join('/'),
      source_account:  'manual-upload',
      comentario:      req.body.comentario || null,
    };

    const { data: saved, error: dbError } = await supabase
      .from('facturas').insert(row).select().single();
    if (dbError) throw new Error(`Supabase: ${dbError.message}`);

    console.log(`[grupo] ✓ ${referencia} — ${data.proveedor} (${data.importe ?? 's/imp'}) · ${sociedadName}`);
    res.json({ ok: true, factura: { ...saved, sociedad_nombre: sociedadName } });
  } catch (e) {
    console.error('[grupo] upload error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /grupo/facturas — solo las subidas manualmente desde este módulo
router.get('/facturas', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('facturas')
    .select('id, fecha_factura, created_at, proveedor, referencia, concepto, importe, sociedad_codigo, drive_url, comentario')
    .eq('source_account', 'manual-upload')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(f => ({ ...f, sociedad_nombre: SOCIEDADES[f.sociedad_codigo] || f.sociedad_codigo })));
});

// GET /grupo/analytics — KPIs, evolución mensual, ranking y comparativa por
// sociedad. Solo sobre lo subido desde este módulo (source_account=manual-upload).
router.get('/analytics', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('facturas')
    .select('fecha_factura, created_at, importe, sociedad_codigo')
    .eq('source_account', 'manual-upload');
  if (error) return res.status(500).json({ error: error.message });

  const byMes = {};
  const bySociedad = {};
  const bySociedadMes = {};

  for (const f of data) {
    const d = new Date(f.fecha_factura || f.created_at);
    if (isNaN(d.getTime())) continue;
    const mes = d.getMonth() + 1, anyo = d.getFullYear();
    const key = `${anyo}-${String(mes).padStart(2, '0')}`;
    const importe = Number(f.importe) || 0;

    if (!byMes[key]) byMes[key] = { mes, anyo, total: 0, count: 0 };
    byMes[key].total += importe;
    byMes[key].count += 1;

    const code = f.sociedad_codigo;
    if (!bySociedad[code]) bySociedad[code] = { total: 0, count: 0 };
    bySociedad[code].total += importe;
    bySociedad[code].count += 1;

    const smKey = `${code}||${key}`;
    bySociedadMes[smKey] = (bySociedadMes[smKey] || 0) + importe;
  }

  // Comparativa por sociedad: mes en curso vs mes anterior (calendario real).
  const now = new Date();
  const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevKey = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;

  const comparativaSociedades = SOCIEDADES_VALIDAS.map(code => {
    const mesActual   = bySociedadMes[`${code}||${curKey}`]  || 0;
    const mesAnterior = bySociedadMes[`${code}||${prevKey}`] || 0;
    const variacionEur = mesActual - mesAnterior;
    const variacionPct = mesAnterior > 0 ? (variacionEur / mesAnterior) * 100 : (mesActual > 0 ? null : 0);
    return { code, nombre: SOCIEDADES[code], mes_actual: mesActual, mes_anterior: mesAnterior, variacion_eur: variacionEur, variacion_pct: variacionPct };
  }).sort((a, b) => b.mes_actual - a.mes_actual);

  res.json({
    total_facturas: data.length,
    total_importe:  data.reduce((s, f) => s + (Number(f.importe) || 0), 0),
    por_mes: Object.values(byMes).sort((a, b) => a.anyo - b.anyo || a.mes - b.mes),
    por_sociedad: SOCIEDADES_VALIDAS
      .map(code => ({ code, nombre: SOCIEDADES[code], total: bySociedad[code]?.total || 0, count: bySociedad[code]?.count || 0 }))
      .sort((a, b) => b.total - a.total),
    comparativa_sociedades: comparativaSociedades,
  });
});

// DELETE /grupo/facturas/:id — deshacer una subida (Supabase + Drive)
router.delete('/facturas/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const { data: factura, error: findError } = await supabase
      .from('facturas').select('id, drive_file_id, proveedor').eq('id', id).eq('source_account', 'manual-upload').single();
    if (findError || !factura) return res.status(404).json({ error: 'Factura no encontrada' });

    let driveDeleted = false;
    if (factura.drive_file_id) {
      try { await deleteFile(factura.drive_file_id); driveDeleted = true; }
      catch (e) { console.warn(`[grupo] no se pudo borrar el archivo de Drive (${factura.drive_file_id}): ${e.message}`); }
    }

    const { error: delError } = await supabase.from('facturas').delete().eq('id', id);
    if (delError) throw new Error(`Supabase: ${delError.message}`);

    console.log(`[grupo] ✗ factura ${id} borrada — ${factura.proveedor} (drive_deleted=${driveDeleted})`);
    res.json({ success: true, id, drive_deleted: driveDeleted });
  } catch (e) {
    console.error('[grupo] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
