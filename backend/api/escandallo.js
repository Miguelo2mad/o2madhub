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

  // POST /escandallo/confirmar  body: { nombre, precio_carta, ingredientes:
  // [{ ingrediente, cantidad, unidad }] } — upsert del plato + reemplazo de
  // sus líneas. Mismo endpoint para "Nuevo plato con foto", la edición de
  // un plato existente y cada plato de una importación.
  router.post('/escandallo/confirmar', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    try {
      const resultado = await escandalloLib.confirmarEscandallo(cliente, req.body || {});
      res.json({ ok: true, ...resultado });
    } catch (e) {
      console.error(`[escandallo:${cliente}] confirmar error:`, e.message);
      res.status(400).json({ error: e.message });
    }
  });

  // GET /escandallo — platos con coste estimado y margen.
  router.get('/escandallo', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    try {
      res.json(await escandalloLib.listarEscandallo(cliente));
    } catch (e) {
      console.error(`[escandallo:${cliente}] listar error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // PATCH /escandallo/:platoId  body: { nombre?, precio_carta?, activo? }
  // Edición ligera de metadatos — para tocar ingredientes usa /confirmar.
  router.patch('/escandallo/:platoId', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    try {
      const plato = await escandalloLib.actualizarPlato(cliente, req.params.platoId, req.body || {});
      res.json({ ok: true, plato });
    } catch (e) {
      console.error(`[escandallo:${cliente}] actualizar error:`, e.message);
      res.status(400).json({ error: e.message });
    }
  });

  // DELETE /escandallo/:platoId
  router.delete('/escandallo/:platoId', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    try {
      await escandalloLib.borrarPlato(cliente, req.params.platoId);
      res.json({ ok: true, id: req.params.platoId });
    } catch (e) {
      console.error(`[escandallo:${cliente}] borrar error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /escandallo/importar se añade en el siguiente commit (importación).

  return router;
}

module.exports = { createEscandalloRouter };
