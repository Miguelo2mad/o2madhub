const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { scanClientAssets, generateWeeklyPlan } = require('../agents/content-agent');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

router.get('/clients', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('content_client_config')
      .select('*')
      .eq('activo', true)
      .order('client_name');
    if (error) throw error;
    res.json({ ok: true, clients: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/clients', async (req, res) => {
  try {
    const { client_id, client_name, drive_folder_id, prompt_maestro, tono, prohibiciones, idiomas, mix_semanal, hashtags_fijos, hora_optima_publicacion, redes } = req.body;
    if (!client_id || !client_name || !drive_folder_id || !prompt_maestro) {
      return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios' });
    }
    const { data, error } = await supabase
      .from('content_client_config')
      .upsert({ client_id, client_name, drive_folder_id, prompt_maestro, tono, prohibiciones, idiomas: idiomas || ['es'], mix_semanal: mix_semanal || { reels: 2, foto: 1, carrusel: 1, story: 3 }, hashtags_fijos: hashtags_fijos || [], hora_optima_publicacion: hora_optima_publicacion || '19:00', redes: redes || ['instagram'], updated_at: new Date().toISOString() }, { onConflict: 'client_id' })
      .select().single();
    if (error) throw error;
    res.json({ ok: true, client: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/assets/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { tags, tipo, min_score } = req.query;
    let query = supabase.from('asset_library').select('*').eq('client_id', clientId).order('score_calidad', { ascending: false });
    if (tipo) query = query.eq('file_type', tipo);
    if (min_score) query = query.gte('score_calidad', parseInt(min_score));
    if (tags) query = query.overlaps('tags', tags.split(','));
    const { data, error } = await query;
    if (error) throw error;
    res.json({ ok: true, assets: data, total: data.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/scan/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { data: config, error: configError } = await supabase
      .from('content_client_config').select('*').eq('client_id', clientId).single();
    if (configError || !config) return res.status(404).json({ ok: false, error: 'Cliente no configurado' });
    res.json({ ok: true, message: `Escaneando assets de ${config.client_name}...` });
    scanClientAssets(clientId, config.client_name, config.drive_folder_id)
      .then(r => console.log(`✅ Scan completado:`, r))
      .catch(e => console.error(`❌ Error scan:`, e.message));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/plan/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { semana } = req.query;
    let lunes;
    if (semana) {
      lunes = semana;
    } else {
      const hoy = new Date();
      const d = new Date(hoy);
      d.setDate(hoy.getDate() - ((hoy.getDay() + 6) % 7));
      lunes = d.toISOString().split('T')[0];
    }
    const { data, error } = await supabase
      .from('content_plan')
      .select('*, asset:asset_id (id, file_name, file_type, drive_url, tags, escena, score_calidad)')
      .eq('client_id', clientId)
      .gte('semana_inicio', lunes)
      .order('fecha_publicacion');
    if (error) throw error;
    res.json({ ok: true, plan: data, total: data.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/plan/generate/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { count } = await supabase
      .from('asset_library').select('*', { count: 'exact', head: true })
      .eq('client_id', clientId).gte('score_calidad', 6);
    if (!count || count === 0) return res.status(400).json({ ok: false, error: 'Sin assets analizados. Ejecuta primero el scan de Drive.' });
    const plan = await generateWeeklyPlan(clientId);
    res.json({ ok: true, plan, total: plan.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.patch('/plan/:pieceId', async (req, res) => {
  try {
    const { pieceId } = req.params;
    const allowed = ['estado', 'copy_caption', 'copy_superpuesto', 'hora_publicacion', 'fecha_publicacion', 'notas', 'asset_id', 'metricool_post_id'];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    updates.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('content_plan').update(updates).eq('id', pieceId).select().single();
    if (error) throw error;
    res.json({ ok: true, pieza: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/schedule/:pieceId', async (req, res) => {
  try {
    const { pieceId } = req.params;
    const { data: pieza, error } = await supabase
      .from('content_plan')
      .select('*, asset:asset_id (drive_url, file_name, file_type)')
      .eq('id', pieceId).single();
    if (error || !pieza) return res.status(404).json({ ok: false, error: 'Pieza no encontrada' });
    if (!['aprobado_cliente', 'aprobado_equipo'].includes(pieza.estado)) {
      return res.status(400).json({ ok: false, error: 'La pieza debe estar aprobada antes de programar' });
    }
    if (!process.env.METRICOOL_API_KEY) {
      return res.status(400).json({ ok: false, error: 'API key de Metricool no configurada' });
    }
    const metricoolRes = await fetch('https://app.metricool.com/api/v2/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.METRICOOL_API_KEY}` },
      body: JSON.stringify({
        caption: pieza.copy_caption,
        scheduledAt: `${pieza.fecha_publicacion}T${pieza.hora_publicacion || '19:00'}:00`,
        networks: [pieza.red || 'instagram'],
        mediaUrls: [pieza.asset?.drive_url].filter(Boolean)
      })
    });
    if (!metricoolRes.ok) throw new Error(`Metricool error: ${await metricoolRes.text()}`);
    const metricoolData = await metricoolRes.json();
    await supabase.from('content_plan').update({ estado: 'programado', metricool_post_id: metricoolData.id || 'scheduled', updated_at: new Date().toISOString() }).eq('id', pieceId);
    res.json({ ok: true, message: 'Programado en Metricool', metricool: metricoolData });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/stats/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const [assets, plan] = await Promise.all([
      supabase.from('asset_library').select('*', { count: 'exact' }).eq('client_id', clientId),
      supabase.from('content_plan').select('estado').eq('client_id', clientId)
    ]);
    const estados = {};
    (plan.data || []).forEach(p => { estados[p.estado] = (estados[p.estado] || 0) + 1; });
    res.json({ ok: true, stats: { total_assets: assets.count || 0, plan_semana: estados, total_piezas: plan.data?.length || 0 } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
