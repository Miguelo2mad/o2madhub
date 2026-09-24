// Tarifas pactadas por proveedor — módulo reutilizable parametrizado por
// cliente, mismo patrón que backend/api/fichaje.js: cada módulo cliente
// (timbol.js, comarea.js, futuros restaurantes) llama a
// createTarifasRouter({ cliente, requireAuth, requireRole }) con SU PROPIO
// login/roles y lo monta sin prefijo — las rutas ya incluyen '/tarifas' o
// '/proveedores' donde corresponde. Tablas únicas (proveedores, tarifas,
// tarifa_productos, producto_alias); el aislamiento entre clientes lo da el
// `.eq('cliente', cliente)` que mete backend/lib/tarifas.js en cada query.
const express = require('express');
const multer  = require('multer');
const { supabase } = require('../lib/supabase');
const tarifasLib = require('../lib/tarifas');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function createTarifasRouter({ cliente, requireAuth, requireRole }) {
  const router = express.Router();

  // POST /tarifas/importar — xlsx, csv, pdf, jpg o png; devuelve VISTA
  // PREVIA. No guarda nada. Respuesta en NDJSON (una línea JSON por evento)
  // en vez de un único JSON: un PDF largo se trocea en varias llamadas a
  // Claude (backend/lib/tarifas.js extraerProductosDePdf) y el frontend
  // necesita ir mostrando "Leyendo páginas X-Y de Z" mientras tanto, no
  // solo al final. Por eso los errores también van como línea NDJSON
  // ({tipo:'error'}) y no como status HTTP: la cabecera 200 ya se mandó
  // con la primera línea, antes de saber si algo falla a mitad.
  router.post('/tarifas/importar', requireAuth, requireRole('gestor', 'admin'), upload.single('archivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo en el campo "archivo"' });
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    try {
      const preview = await tarifasLib.extraerTarifasDeArchivo(
        req.file.buffer, req.file.originalname, cliente, req.file.mimetype,
        { onProgreso: (mensaje) => res.write(`${JSON.stringify({ tipo: 'progreso', mensaje })}\n`) }
      );
      console.log(`[tarifas:${cliente}] preview ${req.file.originalname}: ${preview.grupos.length} grupo(s), ${preview.dudas.length} duda(s)`);
      res.write(`${JSON.stringify({ tipo: 'resultado', ok: true, origen_archivo: req.file.originalname, ...preview })}\n`);
      res.end();
    } catch (e) {
      console.error(`[tarifas:${cliente}] importar error:`, e.message);
      res.write(`${JSON.stringify({ tipo: 'error', error: e.message })}\n`);
      res.end();
    }
  });

  // POST /tarifas/comprados  body: { nif, productos: [nombre, ...] } — qué
  // productos de la vista previa ya se le han comprado a este proveedor
  // (para marcar por defecto qué importar). No requiere que el proveedor
  // exista aún en /proveedores, solo que tenga facturas subidas.
  router.post('/tarifas/comprados', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    try {
      res.json(await tarifasLib.verificarProductosComprados(cliente, req.body || {}));
    } catch (e) {
      console.error(`[tarifas:${cliente}] comprados error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /tarifas/confirmar — guarda la vista previa ya revisada por el usuario
  // (proveedor/NIF asignado a cada grupo). Body: { origen_archivo, grupos }.
  router.post('/tarifas/confirmar', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    const { origen_archivo, grupos } = req.body || {};
    if (!Array.isArray(grupos) || !grupos.length) {
      return res.status(400).json({ error: 'Se requiere al menos un grupo de proveedor con productos' });
    }
    try {
      const resumen = await tarifasLib.confirmarTarifas(cliente, grupos, origen_archivo);
      console.log(`[tarifas:${cliente}] confirmado por ${req.user.email}:`, resumen);
      res.json({ ok: true, ...resumen });
    } catch (e) {
      console.error(`[tarifas:${cliente}] confirmar error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /tarifas — proveedores con nº de productos y vigencia de su tarifa actual
  router.get('/tarifas', requireAuth, async (req, res) => {
    try {
      res.json(await tarifasLib.listarProveedores(cliente));
    } catch (e) {
      console.error(`[tarifas:${cliente}] listar error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /tarifas/:proveedorId — detalle editable de la tarifa vigente
  router.get('/tarifas/:proveedorId', requireAuth, async (req, res) => {
    try {
      const tarifa = await tarifasLib.tarifaVigente(cliente, req.params.proveedorId, req.query.fecha);
      if (!tarifa) return res.status(404).json({ error: 'Este proveedor no tiene tarifa vigente' });
      res.json(tarifa);
    } catch (e) {
      console.error(`[tarifas:${cliente}] detalle error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // PATCH /tarifas/productos/:id — corregir un precio o unidad de la tarifa
  router.patch('/tarifas/productos/:id', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    const { precio, unidad, producto, notas } = req.body || {};
    const patch = {};
    if (precio !== undefined)    patch.precio    = Number(precio);
    if (unidad !== undefined)    patch.unidad    = tarifasLib.normalizarUnidad(unidad);
    if (producto !== undefined)  patch.producto  = String(producto).trim();
    if (notas !== undefined)     patch.notas     = notas || null;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nada que actualizar' });
    try {
      const { data, error } = await supabase
        .from('tarifa_productos').update(patch).eq('id', req.params.id).select().single();
      if (error) throw new Error(`Supabase: ${error.message}`);
      res.json({ ok: true, producto: data });
    } catch (e) {
      console.error(`[tarifas:${cliente}] corregir producto error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // PATCH /proveedores/:id — tolerancia y nombre del proveedor
  router.patch('/proveedores/:id', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    const { tolerancia_pct, nombre } = req.body || {};
    const patch = {};
    if (tolerancia_pct !== undefined) patch.tolerancia_pct = Number(tolerancia_pct);
    if (nombre !== undefined)         patch.nombre         = String(nombre).trim();
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nada que actualizar' });
    try {
      const { data, error } = await supabase
        .from('proveedores').update(patch)
        .eq('id', req.params.id).eq('cliente', cliente).select().maybeSingle();
      if (error) throw new Error(`Supabase: ${error.message}`);
      if (!data) return res.status(404).json({ error: 'Proveedor no encontrado' });
      res.json({ ok: true, proveedor: data });
    } catch (e) {
      console.error(`[tarifas:${cliente}] corregir proveedor error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createTarifasRouter };
