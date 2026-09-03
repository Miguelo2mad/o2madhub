const express = require('express');
const router = express.Router();
const { GoogleAdsApi } = require('google-ads-api');
const { supabase } = require('../lib/supabase');
const { client: claudeClient } = require('../lib/claude');
const { syncGoogleAds } = require('../jobs/google-ads-sync');

function getGadsCustomer(customerId) {
  const adcJson = process.env.GOOGLE_ADS_ADC_JSON;
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!adcJson || !developerToken) throw new Error('Credenciales de Google Ads no configuradas');
  const adc = JSON.parse(adcJson);
  const { client_id, client_secret, refresh_token } = adc;
  const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || undefined;
  const gadsClient = new GoogleAdsApi({ client_id, client_secret, developer_token: developerToken });
  return gadsClient.Customer({
    customer_id: customerId,
    refresh_token,
    ...(loginCustomerId ? { login_customer_id: loginCustomerId } : {}),
  });
}

function extractGadsError(err) {
  if (err.errors && err.errors.length > 0) return err.errors[0].message;
  return err.message || 'Error desconocido de Google Ads';
}

async function logAccion(customerId, tipoAccion, opts = {}) {
  const { campana_id, valor_anterior, valor_nuevo, origen = 'manual' } = opts;
  await supabase.from('google_ads_acciones_log').insert({
    customer_id: customerId,
    campana_id: campana_id || null,
    tipo_accion: tipoAccion,
    valor_anterior: valor_anterior || null,
    valor_nuevo: valor_nuevo || null,
    origen,
  });
}

const CAMPANAS_SYSTEM = `Eres un experto en campañas de Google Ads para agencias de marketing digital.
Analiza las métricas de los últimos 30 días de un cliente y genera recomendaciones accionables y priorizadas.

Considera:
- Rendimiento por campaña (CPL, ROAS, CTR, CPC)
- Comparación con objetivos del cliente (CPL objetivo, ROAS objetivo)
- Tendencias en el periodo analizado
- Oportunidades de optimización: presupuestos, pujas, segmentaciones, creatividades

Formato de respuesta:
1. Resumen ejecutivo (2-3 frases)
2. Top 3 recomendaciones priorizadas (con impacto esperado)
3. Alertas o riesgos detectados

Sé concreto: menciona nombres de campaña, cifras y acciones específicas.`;

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

// GET /clientes
router.get('/clientes', requireAuth, async (_req, res) => {
  const { data, error } = await supabase
    .from('google_ads_clientes')
    .select('*')
    .order('nombre_cliente');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /clientes
router.post('/clientes', requireAuth, async (req, res) => {
  const { nombre_cliente, customer_id, objetivo_cpl, objetivo_roas } = req.body;
  if (!nombre_cliente || !customer_id) {
    return res.status(400).json({ error: 'nombre_cliente y customer_id son obligatorios' });
  }
  const { data, error } = await supabase
    .from('google_ads_clientes')
    .insert({ nombre_cliente, customer_id, objetivo_cpl, objetivo_roas })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// GET /:customerId/stats?dias=30
router.get('/:customerId/stats', requireAuth, async (req, res) => {
  const { customerId } = req.params;
  const dias = Math.min(parseInt(req.query.dias) || 30, 90);
  const desde = new Date();
  desde.setDate(desde.getDate() - dias);
  const fechaDesde = desde.toISOString().slice(0, 10);

  const { data: rows, error } = await supabase
    .from('google_ads_stats_diarias')
    .select('*')
    .eq('customer_id', customerId)
    .gte('fecha', fechaDesde)
    .order('fecha', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  // Totales globales
  const totales = rows.reduce((acc, r) => {
    acc.impresiones += r.impresiones;
    acc.clics += r.clics;
    acc.coste += Number(r.coste);
    acc.conversiones += Number(r.conversiones);
    acc.valor_conversiones += Number(r.valor_conversiones);
    return acc;
  }, { impresiones: 0, clics: 0, coste: 0, conversiones: 0, valor_conversiones: 0 });

  totales.ctr = totales.impresiones > 0 ? totales.clics / totales.impresiones : 0;
  totales.cpc = totales.clics > 0 ? totales.coste / totales.clics : 0;
  totales.cpl = totales.conversiones > 0 ? totales.coste / totales.conversiones : 0;
  totales.roas = totales.coste > 0 ? totales.valor_conversiones / totales.coste : 0;

  // Por campaña
  const byCampana = {};
  for (const r of rows) {
    if (!byCampana[r.campana_id]) {
      byCampana[r.campana_id] = {
        campana_id: r.campana_id,
        campana_nombre: r.campana_nombre,
        impresiones: 0, clics: 0, coste: 0, conversiones: 0, valor_conversiones: 0,
      };
    }
    const c = byCampana[r.campana_id];
    c.impresiones += r.impresiones;
    c.clics += r.clics;
    c.coste += Number(r.coste);
    c.conversiones += Number(r.conversiones);
    c.valor_conversiones += Number(r.valor_conversiones);
  }
  const por_campana = Object.values(byCampana).map(c => ({
    ...c,
    ctr: c.impresiones > 0 ? c.clics / c.impresiones : 0,
    cpc: c.clics > 0 ? c.coste / c.clics : 0,
    cpl: c.conversiones > 0 ? c.coste / c.conversiones : 0,
    roas: c.coste > 0 ? c.valor_conversiones / c.coste : 0,
  }));

  // Por día
  const byDay = {};
  for (const r of rows) {
    if (!byDay[r.fecha]) byDay[r.fecha] = { fecha: r.fecha, impresiones: 0, clics: 0, coste: 0, conversiones: 0 };
    byDay[r.fecha].impresiones += r.impresiones;
    byDay[r.fecha].clics += r.clics;
    byDay[r.fecha].coste += Number(r.coste);
    byDay[r.fecha].conversiones += Number(r.conversiones);
  }
  const por_dia = Object.values(byDay).sort((a, b) => a.fecha.localeCompare(b.fecha));

  res.json({ totales, por_campana, por_dia });
});

// POST /:customerId/recomendar
router.post('/:customerId/recomendar', requireAuth, async (req, res) => {
  const { customerId } = req.params;

  const { data: cliente } = await supabase
    .from('google_ads_clientes')
    .select('*')
    .eq('customer_id', customerId)
    .single();

  const desde = new Date();
  desde.setDate(desde.getDate() - 30);
  const { data: rows } = await supabase
    .from('google_ads_stats_diarias')
    .select('*')
    .eq('customer_id', customerId)
    .gte('fecha', desde.toISOString().slice(0, 10));

  if (!rows || rows.length === 0) {
    return res.status(400).json({ error: 'Sin datos para los últimos 30 días' });
  }

  const snapshot = { cliente, filas: rows.length, rows };

  const userMsg = `Cliente: ${cliente?.nombre_cliente || customerId}
Objetivo CPL: ${cliente?.objetivo_cpl ? `${cliente.objetivo_cpl} €` : 'no definido'}
Objetivo ROAS: ${cliente?.objetivo_roas || 'no definido'}

Datos últimos 30 días (${rows.length} filas campaña+día):
${JSON.stringify(rows.slice(0, 200), null, 2)}`;

  try {
    const response = await claudeClient.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1500,
      system: CAMPANAS_SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    });

    const texto = response.content.find(b => b.type === 'text')?.text || '';

    const { data: rec, error: recError } = await supabase
      .from('google_ads_recomendaciones')
      .insert({ customer_id: customerId, texto, metricas_snapshot: snapshot })
      .select()
      .single();

    if (recError) return res.status(500).json({ error: recError.message });
    res.json({ recomendacion: { id: rec.id, fecha: rec.fecha, texto: rec.texto } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:customerId/recomendaciones
router.get('/:customerId/recomendaciones', requireAuth, async (req, res) => {
  const { customerId } = req.params;
  const { data, error } = await supabase
    .from('google_ads_recomendaciones')
    .select('id, fecha, texto')
    .eq('customer_id', customerId)
    .order('fecha', { ascending: false })
    .limit(10);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /sync
router.post('/sync', requireAuth, async (_req, res) => {
  try {
    const result = await syncGoogleAds();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /:customerId/campanas — estado y presupuesto actuales en tiempo real
router.get('/:customerId/campanas', requireAuth, async (req, res) => {
  const { customerId } = req.params;
  try {
    const customer = getGadsCustomer(customerId);
    const gaql = `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.campaign_budget,
        campaign_budget.amount_micros,
        campaign_budget.resource_name
      FROM campaign
      WHERE campaign.status != 'REMOVED'
    `;
    const rows = await customer.query(gaql);
    const result = rows.map(r => ({
      id: String(r.campaign.id),
      nombre: r.campaign.name,
      status: r.campaign.status,
      presupuesto_eur: (Number(r.campaign_budget.amount_micros) || 0) / 1_000_000,
      presupuesto_resource_name: r.campaign_budget.resource_name,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: extractGadsError(e) });
  }
});

// GET /:customerId/recomendaciones-google
router.get('/:customerId/recomendaciones-google', requireAuth, async (req, res) => {
  const { customerId } = req.params;
  try {
    const customer = getGadsCustomer(customerId);
    const gaql = `
      SELECT
        recommendation.resource_name,
        recommendation.type,
        recommendation.campaign,
        recommendation.impact
      FROM recommendation
    `;
    const rows = await customer.query(gaql);
    const result = rows.map(r => ({
      resource_name: r.recommendation.resource_name,
      type: r.recommendation.type,
      campaign: r.recommendation.campaign,
      impact: r.recommendation.impact,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: extractGadsError(e) });
  }
});

// POST /:customerId/recomendaciones-google/aplicar
router.post('/:customerId/recomendaciones-google/aplicar', requireAuth, async (req, res) => {
  const { customerId } = req.params;
  const { resource_name } = req.body;
  if (!resource_name) return res.status(400).json({ error: 'resource_name es obligatorio' });
  try {
    const customer = getGadsCustomer(customerId);
    await customer.recommendations.apply([{ resource_name }]);
    await logAccion(customerId, 'aplicar_recomendacion', {
      origen: 'recomendacion_google',
      valor_nuevo: { resource_name },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: extractGadsError(e) });
  }
});

// POST /:customerId/campanas/:campanaId/estado
router.post('/:customerId/campanas/:campanaId/estado', requireAuth, async (req, res) => {
  const { customerId, campanaId } = req.params;
  const { estado } = req.body;
  if (!['PAUSED', 'ENABLED'].includes(estado)) {
    return res.status(400).json({ error: 'estado debe ser PAUSED o ENABLED' });
  }
  try {
    const customer = getGadsCustomer(customerId);
    // Leer estado actual antes de mutar
    const gaqlActual = `SELECT campaign.status FROM campaign WHERE campaign.id = ${campanaId}`;
    const rowsActual = await customer.query(gaqlActual);
    const estadoAnterior = rowsActual[0]?.campaign?.status || null;

    // Mutar: ENABLED=2, PAUSED=3
    await customer.campaigns.update([{
      resource_name: `customers/${customerId}/campaigns/${campanaId}`,
      status: estado === 'PAUSED' ? 3 : 2,
    }]);

    await logAccion(customerId, estado === 'PAUSED' ? 'pausar' : 'activar', {
      campana_id: campanaId,
      valor_anterior: { status: estadoAnterior },
      valor_nuevo: { status: estado },
    });
    res.json({ ok: true, estado });
  } catch (e) {
    res.status(500).json({ error: extractGadsError(e) });
  }
});

// POST /:customerId/campanas/:campanaId/presupuesto
router.post('/:customerId/campanas/:campanaId/presupuesto', requireAuth, async (req, res) => {
  const { customerId, campanaId } = req.params;
  const presupuesto_diario = parseFloat(req.body.presupuesto_diario);
  if (!isFinite(presupuesto_diario) || presupuesto_diario <= 0) {
    return res.status(400).json({ error: 'presupuesto_diario debe ser un número positivo' });
  }
  try {
    const customer = getGadsCustomer(customerId);
    // Leer presupuesto actual y resource_name del budget
    const gaqlBudget = `
      SELECT campaign.campaign_budget, campaign_budget.amount_micros, campaign_budget.resource_name
      FROM campaign WHERE campaign.id = ${campanaId}
    `;
    const rows = await customer.query(gaqlBudget);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Campaña no encontrada' });
    const anteriorMicros = Number(rows[0].campaign_budget.amount_micros) || 0;
    const budgetResourceName = rows[0].campaign_budget.resource_name;

    const nuevoMicros = Math.round(presupuesto_diario * 1_000_000);
    await customer.campaignBudgets.update([{
      resource_name: budgetResourceName,
      amount_micros: nuevoMicros,
    }]);

    await logAccion(customerId, 'cambiar_presupuesto', {
      campana_id: campanaId,
      valor_anterior: { presupuesto_eur: anteriorMicros / 1_000_000 },
      valor_nuevo: { presupuesto_eur: presupuesto_diario },
    });
    res.json({ ok: true, presupuesto_eur: presupuesto_diario });
  } catch (e) {
    res.status(500).json({ error: extractGadsError(e) });
  }
});

// GET /:customerId/acciones-log
router.get('/:customerId/acciones-log', requireAuth, async (req, res) => {
  const { customerId } = req.params;
  const limite = Math.min(parseInt(req.query.limite) || 20, 100);
  const { data, error } = await supabase
    .from('google_ads_acciones_log')
    .select('*')
    .eq('customer_id', customerId)
    .order('ejecutado_en', { ascending: false })
    .limit(limite);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
