// Comarea invoice module: manual upload via Claude Vision + Drive archive.
// Mount in index.js with: app.use('/comarea', require('./backend/api/comarea'))
const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const { supabase } = require('../lib/supabase');
const { extraerFactura, clasificarTipoFactura } = require('../lib/extraccion');
const { ensureFolderPath, uploadFile, deleteFile } = require('../lib/google');
const { createFichajeRouter } = require('./fichaje');
const { createTarifasRouter } = require('./tarifas');
const tarifasLib = require('../lib/tarifas');
const { createVentasRouter } = require('./ventas');
const ventasLib = require('../lib/ventas');
const resumenLib = require('../lib/resumen-analisis');
const resumenPendientesLib = require('../lib/resumen-pendientes');
const { createInventarioRouter } = require('./inventario');
const { createBancoRouter } = require('./banco');
const { createChecklistsRouter } = require('./checklists');
const { createGastosPersonalRouter } = require('./gastos-personal');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// ── Auth: usuarios/contraseñas por env vars ─────────────────────────────────
// Token = base64('usuario:timestamp'). requireAuth lo decodifica y consulta COMAREA_USERS.
// Sin defaults: si la env var no está, pass es undefined y el login falla siempre.

const COMAREA_USERS = {
  restaurante: { pass: process.env.COMAREA_PASS_RESTAURANTE?.trim(), role: 'restaurante' },
  gestor:      { pass: process.env.COMAREA_PASS_GESTOR?.trim(),      role: 'gestor' },
  admin:       { pass: process.env.COMAREA_PASS_ADMIN?.trim(),       role: 'admin' },
};

// Diagnóstico de arranque: solo la longitud, nunca el valor. Un 0/undefined
// aquí delata al instante una env var que falta o llegó vacía en Railway.
console.log('[comarea] pass len:', {
  restaurante: COMAREA_USERS.restaurante.pass?.length ?? 0,
  gestor:      COMAREA_USERS.gestor.pass?.length ?? 0,
  admin:       COMAREA_USERS.admin.pass?.length ?? 0,
});

// Comparación en tiempo constante para evitar timing attacks sobre la contraseña.
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

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

// Fichaje de personal — módulo reutilizable (ver backend/api/fichaje.js).
// Queda montado en /comarea/fichaje/*, con el login/roles de Comarea.
router.use('/fichaje', createFichajeRouter({ cliente: 'comarea', requireAuth, requireRole }));

// Tarifas pactadas por proveedor — módulo reutilizable (ver backend/api/tarifas.js).
// Sin prefijo: las rutas ya incluyen /tarifas y /proveedores.
router.use(createTarifasRouter({ cliente: 'comarea', requireAuth, requireRole }));

// Ventas diarias — módulo reutilizable (ver backend/api/ventas.js).
// Sin prefijo: las rutas ya incluyen /ventas.
router.use(createVentasRouter({ cliente: 'comarea', requireAuth, requireRole }));

// Inventario estimado — módulo reutilizable (ver backend/api/inventario.js).
// Sin prefijo: las rutas ya incluyen /inventario.
router.use(createInventarioRouter({ cliente: 'comarea', requireAuth, requireRole }));

// Banco — módulo reutilizable (ver backend/api/banco.js).
// Sin prefijo: las rutas ya incluyen /banco y /analytics/banco-resumen.
router.use(createBancoRouter({ cliente: 'comarea', requireAuth, requireRole }));

// Checklists de turno — módulo reutilizable (ver backend/api/checklists.js).
// Sin prefijo: las rutas ya incluyen /locales, /checklists, /tareas y /asignaciones.
router.use(createChecklistsRouter({ cliente: 'comarea', requireAuth, requireRole }));

// Personal — gastos (nóminas y SS) — módulo reutilizable (ver backend/api/gastos-personal.js).
// Sin prefijo: las rutas ya incluyen /personal y /analytics/personal-mes.
router.use(createGastosPersonalRouter({ cliente: 'comarea', requireAuth, requireRole }));

// ── Claude Vision extraction ────────────────────────────────────────────────
// La extracción y su esquema viven en backend/lib/extraccion.js, compartidos
// con Timbol — ver extraerFactura().

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
  if (!u || !u.pass || !safeCompare(u.pass, password.trim())) return res.status(401).json({ ok: false, error: 'Credenciales incorrectas' });
  const token = Buffer.from(`${usuario}:${Date.now()}`).toString('base64');
  res.json({ ok: true, token, role: u.role, usuario });
});

// POST /comarea/facturas/upload
router.post('/facturas/upload', requireAuth, upload.array('facturas', 10), async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Se requiere al menos un archivo en el campo "facturas"' });

  try {
    // Una o varias páginas, en el orden en que se capturaron — nunca se
    // reordenan, ni aquí ni en extraerFactura.
    const archivos = req.files.map(f => ({ buffer: f.buffer, mimeType: f.mimetype }));

    const { data, usage } = await extraerFactura(archivos, { cliente: 'comarea' });
    trackTokens('upload_factura', usage, req.user.email);

    // Duplicado EXACTO: mismo cif_proveedor + importe + fecha (o ambas sin
    // fecha) + número (o ambas sin número). Se bloquea, no se guarda.
    if (data.cif_proveedor && data.importe_total != null) {
      let qDup = supabase.from('comarea_facturas').select('id')
        .eq('cif_proveedor', data.cif_proveedor)
        .eq('importe_total', data.importe_total);
      qDup = data.fecha_factura ? qDup.eq('fecha_factura', data.fecha_factura) : qDup.is('fecha_factura', null);
      qDup = data.numero_factura ? qDup.eq('numero_factura', data.numero_factura) : qDup.is('numero_factura', null);
      const { data: existing } = await qDup.maybeSingle();
      if (existing) {
        return res.status(409).json({
          ok: false,
          error: 'Esta factura ya está subida.',
          duplicate_id: existing.id,
        });
      }
    }

    // Posible duplicado (no bloquea): mismo proveedor e importe, pero
    // fecha o número distintos — se guarda, pero marcada para revisar.
    let posibleDuplicado = false;
    if (data.proveedor && data.importe_total != null) {
      const { data: posibles } = await supabase
        .from('comarea_facturas').select('fecha_factura, numero_factura')
        .eq('proveedor', data.proveedor)
        .eq('importe_total', data.importe_total)
        .limit(5);
      posibleDuplicado = !!(posibles && posibles.some(p =>
        p.fecha_factura !== data.fecha_factura || p.numero_factura !== data.numero_factura));
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

    // Cada página se sube a Drive por separado (nombradas "pág N" si hay
    // varias) — drive_file_id/drive_url de la factura apuntan a la primera,
    // el resto quedan archivadas en la misma carpeta sin enlace propio en
    // la app.
    const safeName = (data.numero_factura || String(Date.now())).replace(/[/\\:*?"<>|]/g, '-');
    const multiPagina = req.files.length > 1;
    const paginasSubidas = [];
    for (let i = 0; i < req.files.length; i++) {
      const pagina = req.files[i];
      const ext = pagina.mimetype === 'application/pdf' ? 'pdf' : 'jpg';
      const sufijo = multiPagina ? ` - pág ${i + 1}` : '';
      const fileName = `${safeName} - ${data.proveedor || 'factura'}${sufijo}.${ext}`;
      paginasSubidas.push(await uploadFile(fileName, pagina.buffer, folderId, pagina.mimetype));
    }
    const uploaded = paginasSubidas[0];

    // Validación de cordura del desglose: la suma de líneas debe cuadrar con
    // importe_base (±2%). Solo marca un flag — nunca bloquea el guardado.
    const lineas = Array.isArray(data.lineas) ? data.lineas : [];
    const sumaLineas = lineas.reduce((s, l) =>
      s + ((l.cantidad != null && l.precio_unitario != null) ? l.cantidad * l.precio_unitario : 0), 0);
    const base = Number(data.importe_base) || 0;
    const lineasVerificadas = lineas.length > 0 && base > 0
      && Math.abs(sumaLineas - base) <= base * 0.02;

    // Clasificación determinista (ver backend/lib/extraccion.js): no nos fiamos
    // solo de lo que diga el modelo en "tipo".
    const tipo = clasificarTipoFactura({
      tipoModelo:     data.tipo,
      tipoConfianza:  data.tipo_confianza,
      importeBase:    data.importe_base,
      ivaPorcentaje:  data.iva_porcentaje,
    });

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
      tipo,
      tipo_evidencia:   data.tipo_evidencia || null,
      tipo_confianza:   data.tipo_confianza || null,
      numero_albaranes: Array.isArray(data.numero_albaranes) ? data.numero_albaranes : [],
      total_sobreprecio_eur: data.total_sobreprecio_eur || 0,
      posible_duplicado: posibleDuplicado,
      pagina_parcial: !!data.pagina_parcial,
      pagina_actual:  data.pagina_actual ?? null,
      pagina_total:   data.pagina_total ?? null,
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
      producto_tarifa: l.producto_tarifa ?? null,
      precio_pactado:  l.precio_pactado ?? null,
      desviacion_eur:  l.desviacion_eur ?? null,
      desviacion_pct:  l.desviacion_pct ?? null,
      estado_precio:   l.estado_precio ?? null,
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
// Incrusta las líneas (con su comparación de tarifa ya calculada en la subida)
// para que el frontend las muestre sin una petición extra por factura.
router.get('/facturas', requireAuth, async (req, res) => {
  const { mes, anyo, proveedor } = req.query;
  let q = supabase.from('comarea_facturas').select('*, lineas:comarea_factura_lineas(*)').order('fecha_factura', { ascending: false }).limit(10000);
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

const TIPOS_VALIDOS = ['factura', 'albaran', 'ticket', 'revisar'];

// PATCH /comarea/facturas/:id/tipo — corrección manual del tipo, solo gestor/admin
router.patch('/facturas/:id/tipo', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
  const { id } = req.params;
  const { tipo } = req.body || {};
  if (!TIPOS_VALIDOS.includes(tipo)) {
    return res.status(400).json({ error: `tipo debe ser uno de: ${TIPOS_VALIDOS.join(', ')}` });
  }
  try {
    const { data: saved, error } = await supabase
      .from('comarea_facturas')
      .update({ tipo, tipo_confianza: 'alta', tipo_evidencia: `Corregido manualmente por ${req.user.email}` })
      .eq('id', id).select().single();
    if (error) throw new Error(`Supabase: ${error.message}`);
    if (!saved) return res.status(404).json({ error: 'Factura no encontrada' });
    console.log(`[comarea] tipo corregido manualmente: factura ${id} → ${tipo} (${req.user.email})`);
    res.json({ ok: true, factura: saved });
  } catch (e) {
    console.error('[comarea] corregir tipo error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /comarea/facturas/:id — edición en línea de fecha/número desde el
// listado (documentos incompletos). Solo gestor/admin.
router.patch('/facturas/:id', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
  const { id } = req.params;
  const { fecha_factura, numero_factura } = req.body || {};
  const patch = {};
  if (fecha_factura !== undefined) patch.fecha_factura = fecha_factura || null;
  if (numero_factura !== undefined) patch.numero_factura = numero_factura || null;
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nada que actualizar' });
  try {
    const { data: saved, error } = await supabase
      .from('comarea_facturas').update(patch).eq('id', id).select().single();
    if (error) throw new Error(`Supabase: ${error.message}`);
    if (!saved) return res.status(404).json({ error: 'Factura no encontrada' });
    console.log(`[comarea] campo corregido manualmente: factura ${id} (${req.user.email})`);
    res.json({ ok: true, factura: saved });
  } catch (e) {
    console.error('[comarea] corregir campo error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /comarea/facturas/:id/lineas/:lineaId/emparejar — corrección manual
// del emparejamiento con la tarifa. Recalcula el estado de la línea contra
// la tarifa vigente en la fecha de la factura y confirma el alias para que
// futuras facturas casen solas. Solo gestor/admin.
router.patch('/facturas/:id/lineas/:lineaId/emparejar', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
  const { id, lineaId } = req.params;
  const { producto_tarifa } = req.body || {};
  if (!producto_tarifa) return res.status(400).json({ error: 'Se requiere producto_tarifa' });
  try {
    const { data: factura, error: errFactura } = await supabase
      .from('comarea_facturas').select('id, cif_proveedor, fecha_factura').eq('id', id).single();
    if (errFactura || !factura) return res.status(404).json({ error: 'Factura no encontrada' });

    const { data: linea, error: errLinea } = await supabase
      .from('comarea_factura_lineas').select('*').eq('id', lineaId).eq('factura_id', id).single();
    if (errLinea || !linea) return res.status(404).json({ error: 'Línea no encontrada' });

    const patch = await tarifasLib.corregirEmparejamiento({
      cliente: 'comarea',
      cifProveedor: factura.cif_proveedor,
      fechaFactura: factura.fecha_factura,
      linea,
      productoTarifa: producto_tarifa,
    });

    const { data: actualizada, error: errUpdate } = await supabase
      .from('comarea_factura_lineas').update(patch).eq('id', lineaId).select().single();
    if (errUpdate) throw new Error(`Supabase: ${errUpdate.message}`);

    // Recalcula el total de sobreprecio de la factura tras la corrección.
    const { data: todasLineas } = await supabase
      .from('comarea_factura_lineas').select('desviacion_eur, estado_precio').eq('factura_id', id);
    const totalSobreprecio = (todasLineas || [])
      .filter(l => l.estado_precio === 'sobreprecio' && l.desviacion_eur > 0)
      .reduce((s, l) => s + Number(l.desviacion_eur), 0);
    await supabase.from('comarea_facturas')
      .update({ total_sobreprecio_eur: Number(totalSobreprecio.toFixed(2)) }).eq('id', id);

    console.log(`[comarea] emparejamiento corregido: línea ${lineaId} → ${producto_tarifa} (${req.user.email})`);
    res.json({ ok: true, linea: actualizada });
  } catch (e) {
    console.error('[comarea] corregir emparejamiento error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /comarea/analytics
// Los albaranes quedan fuera del cálculo de costes: solo suman tipo factura y ticket.
router.get('/analytics', requireAuth, async (req, res) => {
  const { anyo } = req.query;
  // Sin filtro de tipo en la query: hace falta el dato completo (incluidos
  // albaranes y revisar) para el desglose por proveedor. Los totales en
  // euros siguen sumando solo factura/ticket — ver el filtro de `data` a
  // `facturaTicket` justo abajo.
  let q = supabase.from('comarea_facturas').select('mes, anyo, importe_total, importe_base, proveedor, tipo, fecha_factura').limit(10000);
  if (anyo) q = q.eq('anyo', Number(anyo));
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const facturaTicket = data.filter(f => f.tipo === 'factura' || f.tipo === 'ticket');

  const byMes = {};
  const byProveedor = {};
  const byProveedorMes = {};

  for (const f of facturaTicket) {
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

  // Desglose por tipo de TODOS los documentos del proveedor (no solo
  // factura/ticket) — para que el ranking muestre también los albaranes
  // excluidos del gasto y los que quedan por revisar.
  const byProveedorTipo = {};
  for (const f of data) {
    if (!byProveedorTipo[f.proveedor]) byProveedorTipo[f.proveedor] = { factura: 0, ticket: 0, albaran: 0, revisar: 0 };
    const tipo = f.tipo || 'factura';
    if (byProveedorTipo[f.proveedor][tipo] !== undefined) byProveedorTipo[f.proveedor][tipo]++;
  }

  // Rango de fechas cubierto por el resumen (todos los documentos
  // devueltos, cualquier tipo — depende de si se filtró por ?anyo o no).
  const fechasConDato = data.map(f => f.fecha_factura).filter(Boolean).sort();
  const rangoFechas = fechasConDato.length
    ? { desde: fechasConDato[0], hasta: fechasConDato[fechasConDato.length - 1] } : null;

  // Documentos sin fecha_factura: no entran en por_mes/rango_fechas ni en
  // ningún cálculo por fecha — se avisa en el frontend en vez de dejarlos
  // desaparecer en silencio.
  const documentosSinFecha = data.filter(f => !f.fecha_factura).length;

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
    total_facturas: facturaTicket.length,
    total_importe:  facturaTicket.reduce((s, f) => s + (Number(f.importe_total) || 0), 0),
    por_mes: Object.values(byMes).sort((a, b) => a.anyo - b.anyo || a.mes - b.mes),
    por_proveedor: Object.entries(byProveedor)
      .map(([proveedor, v]) => ({ proveedor, ...v, tipos: byProveedorTipo[proveedor] || { factura: 0, ticket: 0, albaran: 0, revisar: 0 } }))
      .sort((a, b) => b.total - a.total),
    comparativa_proveedores: comparativaProveedores,
    rango_fechas: rangoFechas,
    documentos_sin_fecha: documentosSinFecha,
  });
});

// GET /comarea/resumen-pendientes — badge del botón "Más" del nav (ver
// frontend/pages/nav-mas-shared.js): agrega en una llamada lo que ya
// calcula cada pestaña por separado. Ver backend/lib/resumen-pendientes.js.
router.get('/resumen-pendientes', requireAuth, async (req, res) => {
  try {
    res.json(await resumenPendientesLib.calcularPendientes('comarea'));
  } catch (e) {
    console.error('[comarea] resumen-pendientes error:', e.message);
    res.status(500).json({ error: e.message });
  }
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
    if (Math.abs(variacionPct) > 3) { // ignora ruido de redondeo; solo variaciones relevantes (subida o bajada)
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

// GET /comarea/analytics/precios/historial?producto=&unidad=&proveedor= —
// todo el histórico de compras de ese producto a ese proveedor, para el
// desplegable de "Subidas de precio detectadas". El emparejamiento usa
// normalizarTextoProducto() (igual que /analytics/precios de arriba): dos
// facturas pueden escribir el mismo producto con matices de mayúsculas o
// espacios y deben contar como el mismo.
router.get('/analytics/precios/historial', requireAuth, async (req, res) => {
  const { producto, unidad, proveedor } = req.query;
  if (!producto || !proveedor) return res.status(400).json({ error: 'Se requiere producto y proveedor' });
  try {
    const { data: facturasProveedor, error: errF } = await supabase
      .from('comarea_facturas').select('id, fecha_factura, numero_factura, cif_proveedor')
      .eq('proveedor', proveedor);
    if (errF) throw new Error(`Supabase: ${errF.message}`);
    if (!facturasProveedor.length) return res.json({ producto, unidad: unidad || null, proveedor, historial: [], precio_pactado: null });

    const facturaPorId = new Map(facturasProveedor.map(f => [f.id, f]));
    const { data: lineas, error: errL } = await supabase
      .from('comarea_factura_lineas')
      .select('factura_id, producto, unidad, cantidad, precio_unitario')
      .in('factura_id', facturasProveedor.map(f => f.id))
      .not('precio_unitario', 'is', null)
      .not('producto', 'is', null);
    if (errL) throw new Error(`Supabase: ${errL.message}`);

    const normObjetivo = tarifasLib.normalizarTextoProducto(producto);
    const historial = lineas
      .filter(l => tarifasLib.normalizarTextoProducto(l.producto) === normObjetivo && (!unidad || (l.unidad || '') === unidad))
      .map(l => {
        const f = facturaPorId.get(l.factura_id);
        return {
          factura_id:      l.factura_id,
          fecha_factura:   f?.fecha_factura || null,
          numero_factura:  f?.numero_factura || null,
          precio_unitario: Number(l.precio_unitario),
          cantidad:        l.cantidad != null ? Number(l.cantidad) : null,
        };
      })
      .filter(h => h.fecha_factura)
      .sort((a, b) => new Date(a.fecha_factura) - new Date(b.fecha_factura));

    for (let i = 0; i < historial.length; i++) {
      historial[i].variacion_pct = (i > 0 && historial[i - 1].precio_unitario > 0)
        ? Number((((historial[i].precio_unitario - historial[i - 1].precio_unitario) / historial[i - 1].precio_unitario) * 100).toFixed(2))
        : null;
    }

    // Precio pactado: proveedor (por cif) -> tarifa vigente -> producto
    // emparejado por nombre normalizado. null si no hay tarifa o no casa.
    let precioPactado = null;
    const cifProveedor = facturasProveedor.find(f => f.cif_proveedor)?.cif_proveedor;
    if (cifProveedor) {
      const nifNorm = tarifasLib.normalizarNif(cifProveedor);
      const { data: prov } = await supabase
        .from('proveedores').select('id').eq('cliente', 'comarea').eq('nif', nifNorm).maybeSingle();
      if (prov) {
        const tarifa = await tarifasLib.tarifaVigente('comarea', prov.id);
        const productoTarifa = tarifa?.tarifa_productos?.find(
          p => tarifasLib.normalizarTextoProducto(p.producto) === normObjetivo);
        if (productoTarifa) precioPactado = Number(productoTarifa.precio);
      }
    }

    res.json({ producto, unidad: unidad || null, proveedor, historial, precio_pactado: precioPactado });
  } catch (e) {
    console.error('[comarea] analytics/precios/historial error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /comarea/analytics/sobreprecios?mes=YYYY-MM — total y desglose de
// sobreprecio vs tarifa pactada, para el bloque "Sobreprecio del mes".
router.get('/analytics/sobreprecios', requireAuth, async (req, res) => {
  try {
    let q = supabase.from('comarea_facturas')
      .select('id, proveedor, fecha_factura, total_sobreprecio_eur')
      .gt('total_sobreprecio_eur', 0);
    const mes = req.query.mes;
    if (/^\d{4}-\d{2}$/.test(mes || '')) {
      const fin = tarifasLib.primerDiaSiguienteMes(mes);
      q = q.gte('fecha_factura', `${mes}-01`).lt('fecha_factura', fin);
    }
    const { data: facturas, error } = await q;
    if (error) throw new Error(`Supabase: ${error.message}`);

    const facturaIds = facturas.map(f => f.id);
    let lineas = [];
    if (facturaIds.length) {
      const { data, error: errL } = await supabase
        .from('comarea_factura_lineas')
        .select('factura_id, producto_tarifa, desviacion_eur')
        .eq('estado_precio', 'sobreprecio')
        .in('factura_id', facturaIds);
      if (errL) throw new Error(`Supabase: ${errL.message}`);
      lineas = data;
    }

    const porProveedor = {};
    for (const f of facturas) porProveedor[f.proveedor] = (porProveedor[f.proveedor] || 0) + (Number(f.total_sobreprecio_eur) || 0);
    const porProducto = {};
    for (const l of lineas) {
      const key = l.producto_tarifa || '(sin producto)';
      porProducto[key] = (porProducto[key] || 0) + (Number(l.desviacion_eur) || 0);
    }

    res.json({
      total_sobreprecio_eur: facturas.reduce((s, f) => s + (Number(f.total_sobreprecio_eur) || 0), 0),
      facturas_afectadas: facturas.map(f => ({ id: f.id, proveedor: f.proveedor, fecha_factura: f.fecha_factura, total_sobreprecio_eur: f.total_sobreprecio_eur })),
      por_proveedor: Object.entries(porProveedor).map(([proveedor, total]) => ({ proveedor, total })).sort((a, b) => b.total - a.total),
      por_producto: Object.entries(porProducto).map(([producto, total]) => ({ producto, total })).sort((a, b) => b.total - a.total),
    });
  } catch (e) {
    console.error('[comarea] analytics/sobreprecios error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /comarea/analytics/foodcost?desde=&hasta= — compras (factura+ticket,
// sin albaranes) / ventas netas, por día y acumulado, con media móvil de 7 días.
router.get('/analytics/foodcost', requireAuth, async (req, res) => {
  const { desde, hasta } = req.query;
  if (!desde || !hasta) return res.status(400).json({ error: 'Se requiere desde y hasta (YYYY-MM-DD)' });
  try {
    const { data: facturas, error: errF } = await supabase
      .from('comarea_facturas').select('fecha_factura, importe_total')
      .in('tipo', ['factura', 'ticket'])
      .gte('fecha_factura', desde).lte('fecha_factura', hasta);
    if (errF) throw new Error(`Supabase: ${errF.message}`);

    const { data: ventas, error: errV } = await supabase
      .from('ventas_diarias').select('fecha, total_neto')
      .eq('cliente', 'comarea').gte('fecha', desde).lte('fecha', hasta);
    if (errV) throw new Error(`Supabase: ${errV.message}`);

    const comprasPorFecha = new Map();
    for (const f of facturas) {
      if (!f.fecha_factura) continue;
      const k = f.fecha_factura.slice(0, 10);
      comprasPorFecha.set(k, (comprasPorFecha.get(k) || 0) + (Number(f.importe_total) || 0));
    }
    const ventasPorFecha = new Map();
    for (const v of ventas) ventasPorFecha.set(v.fecha, Number(v.total_neto) || 0);

    const fechas = [];
    const cursor = new Date(`${desde}T00:00:00Z`);
    const fin = new Date(`${hasta}T00:00:00Z`);
    while (cursor <= fin) {
      fechas.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    res.json(ventasLib.calcularFoodcost(comprasPorFecha, ventasPorFecha, fechas));
  } catch (e) {
    console.error('[comarea] analytics/foodcost error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /comarea/analytics/preguntar  body: { pregunta, periodo, desde?, hasta? }
// "Pregúntale a tu restaurante": genera el resumen del periodo elegido y el
// del periodo anterior equivalente (misma duración), y le pasa ambos como
// contexto a Claude para que responda solo con esos datos.
router.post('/analytics/preguntar', requireAuth, async (req, res) => {
  const { pregunta, periodo, desde, hasta } = req.body || {};
  if (!pregunta || typeof pregunta !== 'string' || !pregunta.trim()) {
    return res.status(400).json({ error: 'Falta la pregunta' });
  }
  try {
    const rango = resumenLib.resolverPeriodo(periodo, desde, hasta);
    const rangoAnterior = resumenLib.periodoAnterior(rango.desde, rango.hasta);

    const [actual, anterior] = await Promise.all([
      resumenLib.generarResumen({ cliente: 'comarea', ...rango }),
      resumenLib.generarResumen({ cliente: 'comarea', ...rangoAnterior }),
    ]);

    const respuesta = await resumenLib.preguntarSobreResumen({ pregunta: pregunta.trim(), actual, anterior });

    res.json({
      respuesta,
      periodo_usado: { desde: actual.desde, hasta: actual.hasta },
      dias_con_datos: actual.dias_totales - actual.ventas.dias_sin_cierre,
      dias_totales: actual.dias_totales,
    });
  } catch (e) {
    console.error('[comarea] analytics/preguntar error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /comarea/tokens — solo admin
router.get('/tokens', requireAuth, requireRole('admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('comarea_token_usage').select('input_tokens, output_tokens, coste_euros, created_at').limit(10000);
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
  let q = supabase.from('comarea_facturas').select('mes, anyo, drive_url').not('drive_url', 'is', null).limit(10000);
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
