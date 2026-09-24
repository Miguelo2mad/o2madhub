// Escandallo asistido — módulo reutilizable parametrizado por cliente,
// mismo patrón que inventario.js: cada módulo cliente (timbol.js,
// comarea.js, futuros restaurantes) llama a createEscandalloRouter({
// cliente, requireAuth, requireRole }) con SU PROPIO login/roles y lo monta
// sin prefijo — las rutas ya incluyen '/escandallo'. Toda la lógica vive en
// backend/lib/escandallo.js.
const express = require('express');
const multer = require('multer');
const escandalloLib = require('../lib/escandallo');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function createEscandalloRouter({ cliente, requireAuth, requireRole }) {
  const router = express.Router();

  // POST /escandallo/proponer — multipart: foto opcional, nombre_plato,
  // precio_carta opcional, descripcion opcional. Devuelve un borrador de
  // escandallo con IA; no guarda nada hasta que se confirme.
  router.post('/escandallo/proponer', requireAuth, requireRole('gestor', 'admin'), upload.single('foto'), async (req, res) => {
    try {
      const { nombre_plato, precio_carta, descripcion } = req.body || {};
      const foto = req.file ? { buffer: req.file.buffer, mimeType: req.file.mimetype } : null;
      const borrador = await escandalloLib.proponerEscandallo(cliente, {
        nombrePlato: nombre_plato,
        descripcion,
        precioCarta: (precio_carta !== undefined && precio_carta !== '') ? Number(precio_carta) : null,
        foto,
      });
      res.json({ ok: true, ...borrador });
    } catch (e) {
      console.error(`[escandallo:${cliente}] proponer error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createEscandalloRouter };
