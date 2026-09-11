'use strict';
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { runServiceClassification } = require('../jobs/service-classification-job');

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  const token = auth.slice(7);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
  req.user = data.user;
  next();
}

// POST /api/service-classification/ejecutar
// Body (optional): { reclassify: true }  — reclassify all lines, not just unclassified
router.post('/ejecutar', requireAuth, async (req, res) => {
  try {
    const reclassify = req.body?.reclassify === true;
    const result = await runServiceClassification({ reclassify });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
