// Ventas diarias (cierre de caja) — módulo reutilizable parametrizado por
// cliente, mismo patrón que backend/api/fichaje.js y backend/api/tarifas.js:
// cada módulo cliente llama a createVentasRouter({ cliente, requireAuth,
// requireRole }) con SU PROPIO login/roles y lo monta sin prefijo — las
// rutas ya incluyen /ventas.
const express = require('express');
const multer  = require('multer');
const { supabase } = require('../lib/supabase');
const ventasLib = require('../lib/ventas');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 10 } });

function createVentasRouter({ cliente, requireAuth, requireRole }) {
  const router = express.Router();

  // POST /ventas/foto — una o varias imágenes/PDF del mismo cierre. VISTA
  // PREVIA, no guarda nada — cualquier rol autenticado puede subir (es lo
  // único que ve el encargado de sala).
  router.post('/ventas/foto', requireAuth, upload.array('fotos', 10), async (req, res) => {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'Se requiere al menos un archivo en el campo "fotos"' });
    }
    try {
      const archivos = req.files.map(f => ({ buffer: f.buffer, mimeType: f.mimetype }));
      const { data } = await ventasLib.extraerVentaDiaria(archivos);
      res.json({ ok: true, venta: data });
    } catch (e) {
      console.error(`[ventas:${cliente}] extraer foto error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /ventas/confirmar — guarda el cierre ya revisado (fecha y líneas
  // editables desde la vista previa).
  router.post('/ventas/confirmar', requireAuth, async (req, res) => {
    const { venta } = req.body || {};
    if (!venta || !venta.fecha) return res.status(400).json({ error: 'Se requiere fecha' });
    try {
      const saved = await ventasLib.guardarVentaDiaria(cliente, {
        ...venta,
        origen: 'foto',
        origen_ref: venta.origen_ref || null,
      });
      console.log(`[ventas:${cliente}] ✓ cierre ${venta.fecha} guardado por ${req.user.email} (${(venta.lineas || []).length} línea(s))`);
      res.json({ ok: true, venta: saved });
    } catch (e) {
      console.error(`[ventas:${cliente}] confirmar error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /ventas?desde=&hasta= — listado de días cargados, para el calendario
  router.get('/ventas', requireAuth, async (req, res) => {
    const { desde, hasta } = req.query;
    try {
      let q = supabase.from('ventas_diarias')
        .select('id, fecha, total_bruto, total_neto, num_tickets, origen, detalle_por_articulo')
        .eq('cliente', cliente).order('fecha', { ascending: false }).limit(2000);
      if (desde) q = q.gte('fecha', desde);
      if (hasta) q = q.lte('fecha', hasta);
      const { data, error } = await q;
      if (error) throw new Error(`Supabase: ${error.message}`);
      res.json(data);
    } catch (e) {
      console.error(`[ventas:${cliente}] listar error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /ventas/:fecha — detalle de un día, con sus líneas
  router.get('/ventas/:fecha', requireAuth, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('ventas_diarias').select('*, lineas:ventas_lineas(*)')
        .eq('cliente', cliente).eq('fecha', req.params.fecha).maybeSingle();
      if (error) throw new Error(`Supabase: ${error.message}`);
      if (!data) return res.status(404).json({ error: 'Sin cierre para esa fecha' });
      res.json(data);
    } catch (e) {
      console.error(`[ventas:${cliente}] detalle error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /analytics/ventas-producto?desde=&hasta= — unidades e importe por
  // producto, ordenado por importe. Vive aquí y no en timbol.js/comarea.js
  // porque ventas_lineas ya tiene columna `cliente` — no depende del
  // nombre de ninguna tabla específica de cliente.
  router.get('/analytics/ventas-producto', requireAuth, async (req, res) => {
    const { desde, hasta } = req.query;
    try {
      let qVentas = supabase.from('ventas_diarias').select('id').eq('cliente', cliente);
      if (desde) qVentas = qVentas.gte('fecha', desde);
      if (hasta) qVentas = qVentas.lte('fecha', hasta);
      const { data: ventas, error: errVentas } = await qVentas;
      if (errVentas) throw new Error(`Supabase: ${errVentas.message}`);
      if (!ventas.length) return res.json([]);

      const { data: lineas, error: errLineas } = await supabase
        .from('ventas_lineas')
        .select('producto, producto_norm, cantidad, importe')
        .in('venta_id', ventas.map(v => v.id));
      if (errLineas) throw new Error(`Supabase: ${errLineas.message}`);

      const porProducto = {};
      for (const l of lineas) {
        const key = l.producto_norm || l.producto || '(sin nombre)';
        if (!porProducto[key]) porProducto[key] = { producto: l.producto, unidades: 0, importe: 0 };
        porProducto[key].unidades += Number(l.cantidad) || 0;
        porProducto[key].importe += Number(l.importe) || 0;
      }
      res.json(Object.values(porProducto).sort((a, b) => b.importe - a.importe));
    } catch (e) {
      console.error(`[ventas:${cliente}] analytics/ventas-producto error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createVentasRouter };
