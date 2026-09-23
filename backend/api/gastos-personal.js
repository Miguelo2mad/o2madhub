// Personal — gastos (nóminas y Seguridad Social) — módulo reutilizable
// parametrizado por cliente, mismo patrón que banco.js: cada módulo
// cliente (timbol.js, comarea.js, futuros restaurantes) llama a
// createGastosPersonalRouter({ cliente, requireAuth, requireRole }) con SU
// PROPIO login/roles y lo monta sin prefijo — las rutas ya incluyen
// '/personal' o '/analytics'. Toda la lógica vive en
// backend/lib/gastos-personal.js.
const express = require('express');
const multer = require('multer');
const gastosLib = require('../lib/gastos-personal');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function createGastosPersonalRouter({ cliente, requireAuth, requireRole }) {
  const router = express.Router();

  // POST /personal/gastos/importar — pdf/imagen, una o varias (cada una un
  // documento independiente). Devuelve VISTA PREVIA. No guarda nada.
  router.post('/personal/gastos/importar', requireAuth, requireRole('gestor', 'admin'), upload.array('archivos', 20), async (req, res) => {
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'Se requiere al menos un archivo en el campo "archivos"' });
    try {
      const archivos = req.files.map(f => ({ buffer: f.buffer, mimeType: f.mimetype, nombre: f.originalname }));
      const preview = await gastosLib.construirPreview(cliente, archivos);
      console.log(`[personal:${cliente}] preview ${req.files.length} archivo(s), ${preview.filter(p => p.requiere_revision).length} para revisar`);
      res.json({ ok: true, items: preview });
    } catch (e) {
      console.error(`[personal:${cliente}] importar error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /personal/gastos/confirmar — guarda la vista previa ya revisada y
  // sube cada documento a Drive. Body: { items: [...] } (mismo shape que
  // devuelve /importar, con las correcciones del usuario).
  router.post('/personal/gastos/confirmar', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    const { items } = req.body || {};
    try {
      const resumen = await gastosLib.confirmarGastos(cliente, items);
      console.log(`[personal:${cliente}] confirmado por ${req.user.email}:`, resumen.guardados, 'guardado(s),', resumen.errores.length, 'error(es)');
      res.json({ ok: true, ...resumen });
    } catch (e) {
      console.error(`[personal:${cliente}] confirmar error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /personal/gastos — alta manual sin documento (la gestoría solo
  // pasa el número). Body: { tipo, periodo, empleado_id, importe }.
  router.post('/personal/gastos', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    try {
      const gasto = await gastosLib.altaManual(cliente, req.body || {});
      res.json({ ok: true, gasto });
    } catch (e) {
      console.error(`[personal:${cliente}] alta manual error:`, e.message);
      res.status(400).json({ error: e.message });
    }
  });

  // GET /personal/gastos?mes=YYYY-MM
  router.get('/personal/gastos', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    try {
      res.json(await gastosLib.listarGastos(cliente, req.query));
    } catch (e) {
      console.error(`[personal:${cliente}] listar error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /personal/gastos/:id
  router.delete('/personal/gastos/:id', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    try {
      const { driveDeleted } = await gastosLib.borrarGasto(cliente, req.params.id);
      res.json({ ok: true, id: req.params.id, drive_deleted: driveDeleted });
    } catch (e) {
      console.error(`[personal:${cliente}] borrar error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /analytics/personal-mes se añade en el siguiente commit (analytics).

  return router;
}

module.exports = { createGastosPersonalRouter };
