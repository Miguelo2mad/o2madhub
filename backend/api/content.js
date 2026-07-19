const express = require('express');
const multer = require('multer');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { scanClientAssets, generateWeeklyPlan } = require('../agents/content-agent');
const { generateCreativeCopy } = require('../agents/creative-agent');
const { composeCreative } = require('../lib/image');

const uploadImgs = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 6 },
});

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

const IMG_MIME = { 'image/jpeg': 1, 'image/jpg': 1, 'image/png': 1, 'image/webp': 1 };

router.get('/clients', async (req, res) => {
  try {
    const { data, error } = await getSupabase()
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
    const { client_id, client_name, drive_folder_id, prompt_maestro, tono, prohibiciones, idiomas, mix_semanal, hashtags_fijos, hora_optima_publicacion, redes, logo } = req.body;
    if (!client_id || !client_name || !drive_folder_id || !prompt_maestro) {
      return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios' });
    }
    const row = { client_id, client_name, drive_folder_id, prompt_maestro, tono, prohibiciones, idiomas: idiomas || ['es'], mix_semanal: mix_semanal || { reels: 2, foto: 1, carrusel: 1, story: 3 }, hashtags_fijos: hashtags_fijos || [], hora_optima_publicacion: hora_optima_publicacion || '19:00', redes: redes || ['instagram'], updated_at: new Date().toISOString() };
    if (logo !== undefined) row.logo = logo || null; // data URI del logo (o null para quitarlo)
    let { data, error } = await getSupabase()
      .from('content_client_config')
      .upsert(row, { onConflict: 'client_id' })
      .select().single();
    // Resiliente: si la columna `logo` todavía no existe en Supabase, guarda sin ella.
    if (error && /logo/i.test(error.message) && 'logo' in row) {
      delete row.logo;
      ({ data, error } = await getSupabase()
        .from('content_client_config')
        .upsert(row, { onConflict: 'client_id' })
        .select().single());
      if (!error) console.warn('[content] columna `logo` ausente — cliente guardado sin logo. Ejecuta el ALTER TABLE.');
    }
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
    let query = getSupabase().from('asset_library').select('*').eq('client_id', clientId).order('score_calidad', { ascending: false });
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
    const { data: config, error: configError } = await getSupabase()
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
    const { data, error } = await getSupabase()
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
    const { count } = await getSupabase()
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
    const { data, error } = await getSupabase().from('content_plan').update(updates).eq('id', pieceId).select().single();
    if (error) throw error;
    res.json({ ok: true, pieza: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/schedule/:pieceId', async (req, res) => {
  try {
    const { pieceId } = req.params;
    const { data: pieza, error } = await getSupabase()
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
    await getSupabase().from('content_plan').update({ estado: 'programado', metricool_post_id: metricoolData.id || 'scheduled', updated_at: new Date().toISOString() }).eq('id', pieceId);
    res.json({ ok: true, message: 'Programado en Metricool', metricool: metricoolData });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/stats/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const [assets, plan] = await Promise.all([
      getSupabase().from('asset_library').select('*', { count: 'exact' }).eq('client_id', clientId),
      getSupabase().from('content_plan').select('estado').eq('client_id', clientId)
    ]);
    const estados = {};
    (plan.data || []).forEach(p => { estados[p.estado] = (estados[p.estado] || 0) + 1; });
    res.json({ ok: true, stats: { total_assets: assets.count || 0, plan_semana: estados, total_piezas: plan.data?.length || 0 } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/scan-status/:clientId', async (req, res) => {
  try {
    const { data, error } = await getSupabase()
      .from('content_scan_status')
      .select('*')
      .eq('client_id', req.params.clientId)
      .single();
    if (error) return res.json({ ok: true, status: null });
    res.json({ ok: true, status: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/analyze-web', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ ok: false, error: 'URL requerida' });

    const axios = require('axios');
    let webContent = '';
    try {
      const webRes = await axios.get(url, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; O2MAD-Bot/1.0)' }
      });
      webContent = webRes.data
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 3000);
    } catch (e) {
      return res.status(400).json({ ok: false, error: `No se pudo acceder a la web: ${e.message}` });
    }

    const anthropic = new (require('@anthropic-ai/sdk'))({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Eres el director creativo de O2MAD, agencia premium de marketing para hostelería en Mallorca.

Analiza el siguiente contenido extraído de la web de un cliente y genera la configuración para su Content Studio.

URL analizada: ${url}

CONTENIDO DE LA WEB:
${webContent}

Devuelve SOLO un JSON válido con este formato exacto:
{
  "prompt_maestro": "Descripción del negocio en 3-4 frases: qué es, dónde está, qué ofrece, público objetivo, propuesta de valor única. Tono y personalidad de la marca.",
  "tono": "2-3 palabras que describan el tono: ej: Cálido, aspiracional, familiar",
  "prohibiciones": "Lista de cosas a evitar en el contenido de este cliente específico",
  "hashtags": "#hashtag1 #hashtag2 #hashtag3 #hashtag4 #hashtag5",
  "nombre_negocio": "Nombre del negocio tal como aparece en la web",
  "tipo_negocio": "hotel|restaurante|beach_club|clinica|otro"
}`
      }]
    });

    const rawText = response?.content?.[0]?.text;

    if (!rawText || rawText.trim() === '' || rawText.trim() === 'undefined') {
      return res.status(500).json({ ok: false, error: 'La IA no devolvió respuesta válida' });
    }

    let result;
    try {
      const clean = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
      try {
        result = JSON.parse(clean);
      } catch (e) {
        const match = clean.match(/\{[\s\S]*\}/);
        if (match) result = JSON.parse(match[0]);
        else return res.status(500).json({ ok: false, error: 'No se pudo extraer JSON de la respuesta' });
      }
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'Error parseando respuesta de IA: ' + err.message });
    }

    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Content Creator · Carril A — creatividades foto + texto ──────────────────
// Sube 1-5 fotos (+ brief opcional + cliente opcional). Por cada foto: Claude Vision
// escribe el copy y sharp incrusta el texto/branding. Devuelve el PNG en base64
// (data URL) listo para previsualizar/descargar, más el caption y hashtags.
router.post('/creative', uploadImgs.array('photos', 6), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok: false, error: 'Sube al menos una foto' });

    const brief = (req.body.brief || '').toString().slice(0, 1000);
    const format = ['post', 'story', 'square'].includes(req.body.format) ? req.body.format : 'post';
    const clientId = req.body.clientId || null;
    const accent = /^#[0-9a-fA-F]{6}$/.test(req.body.accent || '') ? req.body.accent : undefined;
    // CTA que fija el usuario en esta subida; si viene vacío, lo decide Claude por foto.
    const ctaOverride = (req.body.cta || '').toString().trim().slice(0, 40) || null;

    // Config de cliente (opcional) para personalizar el copy y el branding.
    let clientConfig = null;
    if (clientId) {
      const { data } = await getSupabase()
        .from('content_client_config').select('*').eq('client_id', clientId).maybeSingle();
      clientConfig = data || null;
    }
    const brand = req.body.brand || clientConfig?.client_name || 'O2MAD';

    // Procesa las fotos en paralelo (cada una: copy Claude + composición).
    const results = await Promise.all(files.map(async (file) => {
      const mediaType = IMG_MIME[file.mimetype] ? (file.mimetype === 'image/jpg' ? 'image/jpeg' : file.mimetype) : 'image/jpeg';
      try {
        const copy = await generateCreativeCopy({
          imageBase64: file.buffer.toString('base64'),
          mediaType,
          brief,
          clientConfig,
        });
        if (ctaOverride) copy.cta = ctaOverride; // el CTA manual manda sobre el de Claude
        const out = await composeCreative(file.buffer, copy, {
          format, brand, accent, logo: clientConfig?.logo || null,
        });
        return {
          filename: file.originalname,
          copy,
          format: out.format,
          image: `data:image/png;base64,${out.buffer.toString('base64')}`,
        };
      } catch (e) {
        return { filename: file.originalname, error: e.message };
      }
    }));

    res.json({ ok: true, format, brand, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
