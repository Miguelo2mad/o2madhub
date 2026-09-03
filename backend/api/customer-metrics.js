'use strict';
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { runCustomerMetricsJob } = require('../jobs/customer-metrics-job');

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

router.post('/recalcular', requireAuth, async (_req, res) => {
  try {
    const result = await runCustomerMetricsJob();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
