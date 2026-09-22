// Inventario estimado (Fase 2 del escandallo) — módulo reutilizable
// parametrizado por cliente, mismo patrón que tarifas.js/ventas.js: cada
// módulo cliente (timbol.js, comarea.js, futuros restaurantes) llama a
// createInventarioRouter({ cliente, requireAuth, requireRole }) con SU
// PROPIO login/roles y lo monta sin prefijo — las rutas ya incluyen
// '/inventario'. Toda la lógica vive en backend/lib/inventario.js.
const express = require('express');
const inventarioLib = require('../lib/inventario');

function createInventarioRouter({ cliente, requireAuth, requireRole }) {
  const router = express.Router();

  // GET /inventario — stock estimado por ingrediente (ver lib/inventario.js).
  router.get('/inventario', requireAuth, async (req, res) => {
    try {
      res.json(await inventarioLib.calcularInventario(cliente));
    } catch (e) {
      console.error(`[inventario:${cliente}] listar error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /inventario/ajustar  body: { ingrediente, unidad, cantidad_inicial, fecha_inicial? }
  // "El día que Roman cuenta algo a mano" — resetea el punto de partida sin
  // perder el histórico de compras/ventas anteriores a fecha_inicial.
  router.post('/inventario/ajustar', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    try {
      const ingrediente = await inventarioLib.ajustarStock(cliente, req.body || {});
      res.json({ ok: true, ingrediente });
    } catch (e) {
      console.error(`[inventario:${cliente}] ajustar error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createInventarioRouter };
