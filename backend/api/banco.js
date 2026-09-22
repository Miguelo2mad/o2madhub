// Extractos bancarios — módulo reutilizable parametrizado por cliente,
// mismo patrón que tarifas.js/ventas.js/inventario.js: cada módulo cliente
// (timbol.js, comarea.js, futuros restaurantes) llama a
// createBancoRouter({ cliente, requireAuth, requireRole }) con SU PROPIO
// login/roles y lo monta sin prefijo — las rutas ya incluyen '/banco' o
// '/analytics'. Toda la lógica vive en backend/lib/banco.js.
const express = require('express');
const multer = require('multer');
const bancoLib = require('../lib/banco');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function createBancoRouter({ cliente, requireAuth, requireRole }) {
  const router = express.Router();

  // POST /banco/importar — sube xlsx/csv, devuelve VISTA PREVIA. No guarda nada.
  router.post('/banco/importar', requireAuth, requireRole('gestor', 'admin'), upload.single('archivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo en el campo "archivo"' });
    try {
      const preview = await bancoLib.extraerMovimientosDeArchivo(req.file.buffer, req.file.originalname);
      console.log(`[banco:${cliente}] preview ${req.file.originalname}: ${preview.movimientos.length} movimiento(s), ${preview.dudas.length} duda(s)`);
      res.json({ ok: true, origen_archivo: req.file.originalname, ...preview });
    } catch (e) {
      console.error(`[banco:${cliente}] importar error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /banco/confirmar — guarda la vista previa ya revisada. Body: { origen_archivo, movimientos }.
  router.post('/banco/confirmar', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    const { origen_archivo, movimientos } = req.body || {};
    try {
      const resumen = await bancoLib.confirmarImportacion(cliente, movimientos, origen_archivo);
      console.log(`[banco:${cliente}] confirmado por ${req.user.email}:`, resumen);
      res.json({ ok: true, ...resumen });
    } catch (e) {
      console.error(`[banco:${cliente}] confirmar error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /banco?desde=&hasta=&estado=(todos|conciliados|sin_conciliar)
  router.get('/banco', requireAuth, async (req, res) => {
    try {
      res.json(await bancoLib.listarMovimientos(cliente, req.query));
    } catch (e) {
      console.error(`[banco:${cliente}] listar error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // PATCH /banco/:id/conciliar  body: { tipo_conciliacion, referencia_id }
  router.patch('/banco/:id/conciliar', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    try {
      const movimiento = await bancoLib.conciliarManual(cliente, req.params.id, req.body || {});
      res.json({ ok: true, movimiento });
    } catch (e) {
      console.error(`[banco:${cliente}] conciliar error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // PATCH /banco/:id/desconciliar
  router.patch('/banco/:id/desconciliar', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    try {
      const movimiento = await bancoLib.desconciliar(cliente, req.params.id);
      res.json({ ok: true, movimiento });
    } catch (e) {
      console.error(`[banco:${cliente}] desconciliar error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /analytics/banco-resumen?mes=YYYY-MM
  router.get('/analytics/banco-resumen', requireAuth, async (req, res) => {
    try {
      res.json(await bancoLib.calcularResumen(cliente, req.query.mes));
    } catch (e) {
      console.error(`[banco:${cliente}] resumen error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createBancoRouter };
