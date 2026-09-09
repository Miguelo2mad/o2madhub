'use strict';
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { importarContactosFD } = require('../jobs/crm-import-fd');

const CATALOGO_SERVICIOS = [
  'SEO','GOOGLE_ADS','META_ADS','SOCIAL_MEDIA','WEB_DESIGN','WEB_DEVELOPMENT',
  'ECOMMERCE','PHOTO','VIDEO','BRANDING','CONTENT','AI_AUTOMATION',
  'WHATSAPP_AI','VOICE_AI','CRM','CONSULTING','HOSTING','MAINTENANCE',
];

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

// GET /api/crm/resumen
router.get('/resumen', requireAuth, async (_req, res) => {
  try {
    const { count: total, error: totalErr } = await supabase
      .from('crm_empresas')
      .select('*', { count: 'exact', head: true });
    if (totalErr) throw totalErr;

    const { data: empresas, error: empErr } = await supabase
      .from('crm_empresas')
      .select('fd_contact_id');
    if (empErr) throw empErr;

    const fdIds = empresas.filter(e => e.fd_contact_id).map(e => e.fd_contact_id);
    const sinMetricas = empresas.length - fdIds.length;

    const { data: metrics, error: mErr } = fdIds.length
      ? await supabase.from('customer_metrics').select('fd_contact_id, customer_status').in('fd_contact_id', fdIds)
      : { data: [], error: null };
    if (mErr) throw mErr;

    const por_status = { ACTIVE: 0, AT_RISK: 0, INACTIVE: 0, DORMANT: 0, LOST: 0, NEW: 0, sin_datos: sinMetricas };
    for (const m of metrics) {
      const s = m.customer_status || 'sin_datos';
      if (s in por_status) por_status[s]++;
      else por_status.sin_datos++;
    }

    res.json({ total, por_status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/crm/empresas
router.get('/empresas', requireAuth, async (req, res) => {
  try {
    const { estado, q, orden = 'score', limit = 50, offset = 0 } = req.query;

    // Build raw SQL via RPC not available — use Supabase select with join via two queries
    // Query crm_empresas, then enrich with customer_metrics
    let empQuery = supabase
      .from('crm_empresas')
      .select('id, nombre, cif, email, sector, fd_contact_id, telefono', { count: 'exact' });

    if (q) {
      empQuery = empQuery.or(`nombre.ilike.%${q}%,cif.ilike.%${q}%,email.ilike.%${q}%`);
    }

    const { data: empresas, count: total, error: empErr } = await empQuery;
    if (empErr) throw empErr;

    const fdIds = empresas.filter(e => e.fd_contact_id).map(e => e.fd_contact_id);
    let metricsMap = {};
    if (fdIds.length) {
      const { data: metrics } = await supabase
        .from('customer_metrics')
        .select('fd_contact_id, customer_status, reactivation_score, revenue_12m, revenue_total, days_since_last_invoice, last_invoice_date, invoice_count, first_invoice_date, services_used')
        .in('fd_contact_id', fdIds);
      for (const m of metrics || []) metricsMap[m.fd_contact_id] = m;
    }

    let rows = empresas.map(e => {
      const m = e.fd_contact_id ? metricsMap[e.fd_contact_id] : null;
      return {
        id: e.id, nombre: e.nombre, cif: e.cif, email: e.email, sector: e.sector,
        customer_status: m?.customer_status || null,
        reactivation_score: m?.reactivation_score || null,
        revenue_12m: m?.revenue_12m || null,
        revenue_total: m?.revenue_total || null,
        days_since_last_invoice: m?.days_since_last_invoice || null,
        last_invoice_date: m?.last_invoice_date || null,
        invoice_count: m?.invoice_count || null,
        first_invoice_date: m?.first_invoice_date || null,
        services_used: m?.services_used || null,
      };
    });

    if (estado) rows = rows.filter(r => r.customer_status === estado);

    if (orden === 'score') {
      rows.sort((a, b) => (b.reactivation_score ?? -1) - (a.reactivation_score ?? -1));
    } else if (orden === 'facturado') {
      rows.sort((a, b) => (b.revenue_12m ?? -1) - (a.revenue_12m ?? -1));
    } else if (orden === 'ultima') {
      rows.sort((a, b) => {
        if (!a.last_invoice_date) return 1;
        if (!b.last_invoice_date) return -1;
        return new Date(b.last_invoice_date) - new Date(a.last_invoice_date);
      });
    }

    const lim = Number(limit);
    const off = Number(offset);
    const paginated = rows.slice(off, off + lim);

    res.json({ total: rows.length, data: paginated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/crm/empresas/:id
router.get('/empresas/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: empresa, error: empErr } = await supabase
      .from('crm_empresas')
      .select('*')
      .eq('id', id)
      .single();
    if (empErr || !empresa) return res.status(404).json({ error: 'Empresa no encontrada' });

    let metricas = null;
    if (empresa.fd_contact_id) {
      const { data: m } = await supabase
        .from('customer_metrics')
        .select('*')
        .eq('fd_contact_id', empresa.fd_contact_id)
        .maybeSingle();
      metricas = m;
    }

    // Últimas 10 facturas con primera línea de descripción
    let facturas = [];
    if (empresa.fd_contact_id) {
      const { data: invs } = await supabase
        .from('fd_invoices')
        .select('fd_invoice_id, document_number, invoice_date, total, state')
        .eq('fd_contact_id', empresa.fd_contact_id)
        .order('invoice_date', { ascending: false })
        .limit(10);
      if (invs?.length) {
        const invIds = invs.map(i => i.fd_invoice_id);
        const { data: lines } = await supabase
          .from('fd_invoice_lines')
          .select('fd_invoice_id, description')
          .in('fd_invoice_id', invIds);
        const firstLine = {};
        for (const l of lines || []) {
          if (!firstLine[l.fd_invoice_id]) firstLine[l.fd_invoice_id] = l.description;
        }
        facturas = invs.map(i => ({ ...i, primera_linea_descripcion: firstLine[i.fd_invoice_id] || null }));
      }
    }

    // Servicios contratados
    let servicios = [];
    if (empresa.fd_contact_id) {
      const { data: svcRows } = await supabase.rpc
        ? await supabase.from('fd_invoice_lines')
            .select('service_category, fd_invoices!inner(invoice_date, fd_contact_id)')
            .eq('fd_invoices.fd_contact_id', empresa.fd_contact_id)
            .not('service_category', 'is', null)
        : { data: [] };

      // Aggregate manually
      const svcMap = {};
      for (const row of svcRows || []) {
        const cat = row.service_category;
        const date = row.fd_invoices?.invoice_date;
        if (!cat) continue;
        if (!svcMap[cat]) svcMap[cat] = { service_category: cat, primera_vez: date, ultima_vez: date };
        else {
          if (date && date < svcMap[cat].primera_vez) svcMap[cat].primera_vez = date;
          if (date && date > svcMap[cat].ultima_vez) svcMap[cat].ultima_vez = date;
        }
      }
      servicios = Object.values(svcMap);
    }

    const contratados = servicios.map(s => s.service_category);
    const nunca_contratados = CATALOGO_SERVICIOS.filter(s => !contratados.includes(s));

    // Actividades
    const { data: actividades } = await supabase
      .from('crm_actividades')
      .select('*')
      .eq('empresa_id', id)
      .order('fecha', { ascending: false })
      .limit(20);

    // Señal de churn
    let senal = null;
    if (metricas && metricas.frequency_deviation_ratio >= 3 && metricas.customer_status !== 'ACTIVE') {
      const avgDays = Math.round(metricas.average_days_between_invoices || 0);
      const daysSince = Math.round(metricas.days_since_last_invoice || 0);
      const ratio = (metricas.frequency_deviation_ratio || 0).toFixed(1);
      senal = `Facturaba cada ${avgDays} días de media y lleva ${daysSince} días sin actividad (${ratio}x su intervalo habitual)`;
    }

    res.json({ empresa, metricas, facturas, servicios, nunca_contratados, actividades: actividades || [], senal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/crm/empresas
router.post('/empresas', requireAuth, async (req, res) => {
  try {
    const { nombre, cif, email, telefono, sector } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ error: 'nombre es obligatorio' });

    const { data, error } = await supabase
      .from('crm_empresas')
      .insert({ nombre: nombre.trim(), cif: cif || null, email: email || null, telefono: telefono || null, sector: sector || null, origen: 'manual' })
      .select()
      .single();
    if (error) throw error;

    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/crm/empresas/:id
router.patch('/empresas/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['nombre', 'cif', 'email', 'telefono', 'sector'];
    const updates = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('crm_empresas')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/crm/empresas/:id/actividades
router.post('/empresas/:id/actividades', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, detalle, tipo = 'nota' } = req.body;
    if (!titulo?.trim()) return res.status(400).json({ error: 'titulo es obligatorio' });

    const { data, error } = await supabase
      .from('crm_actividades')
      .insert({ empresa_id: id, tipo, titulo: titulo.trim(), detalle: detalle || null, autor: req.user.email })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/crm/import
router.post('/import', requireAuth, async (_req, res) => {
  try {
    const result = await importarContactosFD();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
