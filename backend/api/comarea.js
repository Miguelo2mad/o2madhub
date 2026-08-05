// Comarea invoice module: manual upload via Claude Vision + Drive archive.
// Mount in index.js with: app.use('/comarea', require('./backend/api/comarea'))
const express = require('express');
const multer  = require('multer');
const { supabase } = require('../lib/supabase');
const { client } = require('../lib/claude');
const { ensureFolderPath, uploadFile, deleteFile } = require('../lib/google');

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
    lineas: {
      type: 'array',
      description: 'Desglose de líneas de producto de la factura. Array vacío [] si no hay una tabla de productos clara (p.ej. servicios).',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          producto:        { type: ['string', 'null'], description: 'Nombre del producto tal como aparece' },
          cantidad:        { type: ['number', 'null'] },
          unidad:          { type: ['string', 'null'], description: 'Unidad de medida en minúsculas: kg, l, ud, caja...' },
          precio_unitario: { type: ['number', 'null'], description: 'Precio por unidad, sin IVA si es posible' },
        },
        required: ['producto', 'cantidad', 'unidad', 'precio_unitario'],
      },
    },
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
        { type: 'text', text: 'Extrae los datos de esta factura de proveedor. fecha_factura en YYYY-MM-DD. iva_porcentaje como número (ej: 21). Si no encuentras un campo devuelve null. '
          + 'Además, en "lineas" desglosa cada línea de producto: producto (nombre tal cual), cantidad, unidad de medida en minúsculas (kg, l, ud, caja...) y precio_unitario. '
          + 'Si la factura no tiene una tabla de productos clara (por ejemplo es un servicio), devuelve "lineas" como array vacío []. No inventes líneas ni valores.' },
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

    // Evita duplicados (p. ej. reintentos de subida del mismo PDF): si ya existe
    // una factura con mismo proveedor+número+importe+fecha, no se vuelve a guardar.
    if (data.proveedor && data.numero_factura) {
      const { data: existing } = await supabase
        .from('comarea_facturas').select('id')
        .eq('proveedor', data.proveedor)
        .eq('numero_factura', data.numero_factura)
        .eq('importe_total', data.importe_total)
        .eq('fecha_factura', data.fecha_factura)
        .maybeSingle();
      if (existing) {
        return res.status(409).json({
          ok: false,
          error: `Ya existe esta factura (${data.numero_factura} — ${data.proveedor}), no se ha vuelto a guardar.`,
          duplicate_id: existing.id,
        });
      }
    }

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

    // Validación de cordura del desglose: la suma de líneas debe cuadrar con
    // importe_base (±2%). Solo marca un flag — nunca bloquea el guardado.
    const lineas = Array.isArray(data.lineas) ? data.lineas : [];
    const sumaLineas = lineas.reduce((s, l) =>
      s + ((l.cantidad != null && l.precio_unitario != null) ? l.cantidad * l.precio_unitario : 0), 0);
    const base = Number(data.importe_base) || 0;
    const lineasVerificadas = lineas.length > 0 && base > 0
      && Math.abs(sumaLineas - base) <= base * 0.02;

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
      lineas_verificadas: lineasVerificadas,
      comentario:     req.body.comentario || null,
    };

    const { data: saved, error: dbError } = await supabase
      .from('comarea_facturas').insert(row).select().single();
    if (dbError) throw new Error(`Supabase: ${dbError.message}`);

    // Fase 1: guardar el desglose de líneas si Claude lo extrajo. Si falla, la
    // factura ya está guardada — solo lo registramos, no bloqueamos la subida.
    const rows = lineas.map(l => ({
      factura_id:      saved.id,
      producto:        l.producto ?? null,
      cantidad:        l.cantidad ?? null,
      unidad:          l.unidad ? String(l.unidad).toLowerCase().trim() : null,
      precio_unitario: l.precio_unitario ?? null,
      importe_linea:   (l.cantidad != null && l.precio_unitario != null)
        ? Number((l.cantidad * l.precio_unitario).toFixed(2)) : null,
    }));
    if (rows.length) {
      const { error: lineasError } = await supabase.from('comarea_factura_lineas').insert(rows);
      if (lineasError) console.error('[comarea] guardar líneas:', lineasError.message);
    }

    console.log(`[comarea] ✓ ${data.numero_factura} — ${data.proveedor} (${data.importe_total ?? 's/imp'}) · ${rows.length} línea(s) · verif=${lineasVerificadas}`);
    res.json({ ok: true, factura: { ...saved, lineas: rows } });
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

// DELETE /comarea/facturas/:id — solo gestor/admin
router.delete('/facturas/:id', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
  const { id } = req.params;
  try {
    const { data: factura, error: findError } = await supabase
      .from('comarea_facturas').select('id, drive_file_id, proveedor').eq('id', id).single();
    if (findError || !factura) return res.status(404).json({ error: 'Factura no encontrada' });

    // Borra primero el archivo de Drive. Si falla (ya no existe, permisos, etc.)
    // avisamos por consola pero no bloqueamos el borrado en Supabase.
    let driveDeleted = false;
    if (factura.drive_file_id) {
      try {
        await deleteFile(factura.drive_file_id);
        driveDeleted = true;
      } catch (e) {
        console.warn(`[comarea] no se pudo borrar el archivo de Drive (${factura.drive_file_id}): ${e.message}`);
      }
    }

    const { error: delError } = await supabase.from('comarea_facturas').delete().eq('id', id);
    if (delError) throw new Error(`Supabase: ${delError.message}`);

    console.log(`[comarea] ✗ factura ${id} borrada — ${factura.proveedor} (drive_deleted=${driveDeleted})`);
    res.json({ success: true, id, drive_deleted: driveDeleted });
  } catch (e) {
    console.error('[comarea] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
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
  const byProveedorMes = {};

  for (const f of data) {
    const key = `${f.anyo}-${String(f.mes).padStart(2, '0')}`;
    if (!byMes[key]) byMes[key] = { mes: f.mes, anyo: f.anyo, total: 0, base: 0, count: 0 };
    byMes[key].total += Number(f.importe_total) || 0;
    byMes[key].base  += Number(f.importe_base)  || 0;
    byMes[key].count += 1;

    if (!byProveedor[f.proveedor]) byProveedor[f.proveedor] = { total: 0, count: 0 };
    byProveedor[f.proveedor].total += Number(f.importe_total) || 0;
    byProveedor[f.proveedor].count += 1;

    const pmKey = `${f.proveedor}||${key}`;
    byProveedorMes[pmKey] = (byProveedorMes[pmKey] || 0) + (Number(f.importe_total) || 0);
  }

  // Comparativa por proveedor: mes en curso vs mes anterior (calendario real,
  // independiente del filtro ?anyo, para que enero se compare con diciembre).
  const now = new Date();
  const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevKey = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;

  const proveedoresActivos = new Set(
    Object.keys(byProveedorMes)
      .filter(k => k.endsWith(`||${curKey}`) || k.endsWith(`||${prevKey}`))
      .map(k => k.split('||')[0])
  );

  const comparativaProveedores = [...proveedoresActivos].map(proveedor => {
    const mesActual   = byProveedorMes[`${proveedor}||${curKey}`]  || 0;
    const mesAnterior = byProveedorMes[`${proveedor}||${prevKey}`] || 0;
    const variacionEur = mesActual - mesAnterior;
    // null = proveedor nuevo este mes, sin mes anterior con el que comparar
    const variacionPct = mesAnterior > 0 ? (variacionEur / mesAnterior) * 100 : null;
    return { proveedor, mes_actual: mesActual, mes_anterior: mesAnterior, variacion_eur: variacionEur, variacion_pct: variacionPct };
  }).sort((a, b) => b.variacion_eur - a.variacion_eur);

  res.json({
    total_facturas: data.length,
    total_importe:  data.reduce((s, f) => s + (Number(f.importe_total) || 0), 0),
    por_mes: Object.values(byMes).sort((a, b) => a.anyo - b.anyo || a.mes - b.mes),
    por_proveedor: Object.entries(byProveedor)
      .map(([proveedor, v]) => ({ proveedor, ...v }))
      .sort((a, b) => b.total - a.total),
    comparativa_proveedores: comparativaProveedores,
  });
});

// GET /comarea/analytics/precios — subidas de precio por producto vs la compra
// anterior (Fase 2 del desglose de líneas: Fase 1 solo extraía y validaba).
router.get('/analytics/precios', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('comarea_factura_lineas')
    .select('producto, unidad, precio_unitario, factura:factura_id(fecha_factura, proveedor)')
    .not('precio_unitario', 'is', null)
    .not('producto', 'is', null);
  if (error) return res.status(500).json({ error: error.message });

  const norm = (s) => String(s).toLowerCase().trim().replace(/\s+/g, ' ');

  const byProducto = {};
  for (const l of data) {
    if (!l.factura) continue;
    const key = `${norm(l.producto)}||${l.unidad || ''}`;
    (byProducto[key] ||= []).push({
      producto: l.producto,
      unidad: l.unidad,
      precio: Number(l.precio_unitario),
      fecha: l.factura.fecha_factura,
      proveedor: l.factura.proveedor,
    });
  }

  const subidas = [];
  for (const compras of Object.values(byProducto)) {
    if (compras.length < 2) continue;
    compras.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
    const actual   = compras[compras.length - 1];
    const anterior = compras[compras.length - 2];
    if (!(anterior.precio > 0)) continue;
    const variacionPct = ((actual.precio - anterior.precio) / anterior.precio) * 100;
    if (variacionPct > 3) { // ignora ruido de redondeo; solo subidas relevantes
      subidas.push({
        producto: actual.producto,
        unidad: actual.unidad,
        precio_anterior: anterior.precio,
        fecha_anterior: anterior.fecha,
        proveedor_anterior: anterior.proveedor,
        precio_actual: actual.precio,
        fecha_actual: actual.fecha,
        proveedor_actual: actual.proveedor,
        variacion_pct: variacionPct,
      });
    }
  }

  subidas.sort((a, b) => b.variacion_pct - a.variacion_pct);
  res.json({ subidas });
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
