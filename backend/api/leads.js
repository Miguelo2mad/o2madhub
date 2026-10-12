// Módulo Leads: contactos de GoHighLevel por cliente (ver backend/jobs/leads-sync.js
// y docs/leads.md). Fechas guardadas en UTC; todo se agrega en Europe/Madrid.
const express = require('express');
const router = express.Router();
const { DateTime } = require('luxon');
const { supabase } = require('../lib/supabase');
const { syncLeads, syncSubcuentaEnSegundoPlano, SIN_TOKEN } = require('../jobs/leads-sync');
const { validarTokenPrivado } = require('../lib/ghl');

const TZ = 'Europe/Madrid';
const CANALES = ['meta', 'google', 'organico', 'manual', 'otro'];
const PAGE_SIZE = 50;

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

// Rol del hub: misma fuente que la home (profiles.role, con app_metadata de respaldo).
async function requireAdmin(req, res, next) {
  const { data } = await supabase.from('profiles').select('role').eq('id', req.user.id).maybeSingle();
  const role = (data?.role || req.user.app_metadata?.role || '').toLowerCase();
  if (role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  next();
}

// ---- Helpers ----

const hoyMadrid = () => DateTime.now().setZone(TZ).startOf('day');

function parseDia(s, fallback) {
  if (!s) return fallback;
  const d = DateTime.fromISO(String(s), { zone: TZ });
  return d.isValid ? d.startOf('day') : fallback;
}

// PostgREST devuelve como mucho 1000 filas por petición.
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// Filas de la vista leads_diarios entre dos días Madrid (inclusive).
function diarios({ locationId, desde, hasta }) {
  return fetchAll(() => {
    let q = supabase.from('leads_diarios')
      .select('location_id, dia, canal, total')
      .gte('dia', desde.toISODate())
      .lte('dia', hasta.toISODate())
      .order('dia').order('location_id').order('canal');
    if (locationId) q = q.eq('location_id', locationId);
    return q;
  });
}

const sumar = (filas, pred) => filas.reduce((s, f) => (pred(f) ? s + f.total : s), 0);
const variacion = (actual, anterior) => (anterior > 0 ? Math.round(((actual - anterior) / anterior) * 1000) / 10 : null);

function claveBucket(dia, granularidad) {
  if (granularidad === 'mes') return dia.toFormat('yyyy-MM');
  if (granularidad === 'semana') return dia.startOf('week').toISODate();
  return dia.toISODate();
}

function sanitizarBusqueda(q) {
  return String(q || '').replace(/[,()*%\\]/g, ' ').trim().slice(0, 100);
}

// Filtros comunes del listado y del CSV sobre la tabla leads.
function filtrosLeads(q, { location_id, desde, hasta, canal, q: busqueda }) {
  if (location_id) q = q.eq('location_id', location_id);
  const d = parseDia(desde, null);
  const h = parseDia(hasta, null);
  if (d) q = q.gte('fecha_creacion', d.toUTC().toISO());
  if (h) q = q.lte('fecha_creacion', h.endOf('day').toUTC().toISO());
  if (canal && CANALES.includes(canal)) q = q.eq('canal', canal);
  const s = sanitizarBusqueda(busqueda);
  if (s) q = q.or(`nombre.ilike.*${s}*,email.ilike.*${s}*,telefono.ilike.*${s}*,utm_campaign.ilike.*${s}*`);
  return q;
}

const COLS_LISTADO = 'ghl_contact_id, location_id, nombre, email, telefono, fuente, canal, utm_source, utm_medium, utm_campaign, utm_content, tags, fecha_creacion';

async function nombresClientes() {
  const { data, error } = await supabase.from('clientes_ghl').select('location_id, nombre');
  if (error) throw new Error(error.message);
  return Object.fromEntries(data.map(c => [c.location_id, c.nombre]));
}

function csvField(s) {
  const str = String(s ?? '');
  return /[;"\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// ---- Clientes (subcuentas GHL) ----

const infoToken = t => ({ token_configurado: !!t, token_ultimos4: t ? t.slice(-4) : null });

// GET /clientes — subcuentas con leads del mes actual (Madrid).
router.get('/clientes', requireAuth, async (_req, res) => {
  try {
    const { data: clientes, error } = await supabase
      .from('clientes_ghl')
      .select('id, location_id, nombre, cliente_id, activo, ultima_sync, created_at, token_privado, crm_empresas(nombre)')
      .order('nombre');
    if (error) throw new Error(error.message);

    const hoy = hoyMadrid();
    const filas = await diarios({ desde: hoy.startOf('month'), hasta: hoy });
    const porLocation = {};
    for (const f of filas) porLocation[f.location_id] = (porLocation[f.location_id] || 0) + f.total;

    // El token privado nunca sale del backend: solo si existe y sus últimos 4.
    res.json(clientes.map(({ token_privado, crm_empresas, ...c }) => ({
      ...c,
      cliente_nombre: crm_empresas?.nombre || null,
      ...infoToken(token_privado),
      leads_mes: porLocation[c.location_id] || 0,
    })));
  } catch (e) {
    console.error('[leads] GET /clientes:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /empresas — clientes del hub (crm_empresas) para el mapeo en /leads/clientes.
router.get('/empresas', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const data = await fetchAll(() => supabase.from('crm_empresas').select('id, nombre').order('nombre'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /clientes/:location_id — nombre, cliente_id, activo, token_privado.
// token_privado: string = validar contra GET /locations/{id} y guardar (y
// lanzar en segundo plano el backfill de 12 meses de esa subcuenta);
// '' o null = borrar; ausente = no tocar.
router.patch('/clientes/:location_id', requireAuth, requireAdmin, async (req, res) => {
  const locationId = req.params.location_id;
  const cambios = {};
  const { nombre, cliente_id, activo, token_privado } = req.body || {};
  if (nombre !== undefined) {
    if (!String(nombre).trim()) return res.status(400).json({ error: 'nombre no puede estar vacío' });
    cambios.nombre = String(nombre).trim();
  }
  if (cliente_id !== undefined) cambios.cliente_id = cliente_id || null;
  if (activo !== undefined) cambios.activo = !!activo;
  const tokenNuevo = token_privado ? String(token_privado).trim() : null;
  if (token_privado !== undefined) {
    cambios.token_privado = tokenNuevo;
    if (tokenNuevo) {
      const v = await validarTokenPrivado(locationId, tokenNuevo);
      if (!v.ok) {
        console.warn(`[leads] token privado rechazado para ${locationId}: ${v.error}`);
        return res.status(400).json({ error: v.error });
      }
      cambios.ultima_sync = null; // token nuevo → backfill completo de 12 meses
    }
  }
  if (!Object.keys(cambios).length) return res.status(400).json({ error: 'Nada que actualizar' });

  const { data, error } = await supabase
    .from('clientes_ghl')
    .update(cambios)
    .eq('location_id', locationId)
    .select('location_id, nombre, cliente_id, activo, ultima_sync, token_privado')
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Subcuenta no encontrada' });

  const backfill = !!tokenNuevo && data.activo;
  const lanzadoEn = new Date().toISOString();
  if (backfill) {
    console.log(`[leads] token privado guardado para ${data.nombre}; backfill en segundo plano`);
    syncSubcuentaEnSegundoPlano(locationId);
  }
  const { token_privado: t, ...resto } = data;
  res.json({ ...resto, ...infoToken(t), backfill_lanzado: backfill, backfill_lanzado_en: backfill ? lanzadoEn : null });
});

// ---- Métricas ----

// GET /resumen?location_id= — hoy, semana, mes, mes anterior, mismo mes del año anterior.
router.get('/resumen', requireAuth, async (req, res) => {
  try {
    const locationId = req.query.location_id || null;
    const hoy = hoyMadrid();
    const iniSemana = hoy.startOf('week');
    const iniMes = hoy.startOf('month');
    const iniMesAnt = iniMes.minus({ months: 1 });
    const finMesAnt = iniMes.minus({ days: 1 });
    // Mes anterior "a la misma altura": del día 1 al mismo día del mes (o su último día).
    const mesAntMismoDia = iniMesAnt.plus({ days: Math.min(hoy.day, iniMesAnt.daysInMonth) - 1 });
    const iniMesAnio = iniMes.minus({ years: 1 });
    const finMesAnio = iniMesAnio.endOf('month').startOf('day');

    const filas = await diarios({ locationId, desde: iniMesAnio, hasta: hoy });
    const enRango = (a, b) => f => f.dia >= a.toISODate() && f.dia <= b.toISODate();

    const mes = sumar(filas, enRango(iniMes, hoy));
    const mesAnterior = sumar(filas, enRango(iniMesAnt, finMesAnt));
    const mesAnteriorMismoDia = sumar(filas, enRango(iniMesAnt, mesAntMismoDia));
    const mismoMesAnioAnterior = sumar(filas, enRango(iniMesAnio, finMesAnio));

    res.json({
      hoy: sumar(filas, enRango(hoy, hoy)),
      semana: sumar(filas, enRango(iniSemana, hoy)),
      mes,
      mes_anterior: mesAnterior,
      mes_anterior_mismo_dia: mesAnteriorMismoDia,
      variacion_pct: variacion(mes, mesAnterior),
      variacion_mismo_dia_pct: variacion(mes, mesAnteriorMismoDia),
      mismo_mes_anio_anterior: mismoMesAnioAnterior,
      variacion_anual_pct: variacion(mes, mismoMesAnioAnterior),
      fecha: hoy.toISODate(),
    });
  } catch (e) {
    console.error('[leads] GET /resumen:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /serie?location_id=&granularidad=dia|semana|mes&desde=&hasta=
router.get('/serie', requireAuth, async (req, res) => {
  try {
    const granularidad = ['dia', 'semana', 'mes'].includes(req.query.granularidad) ? req.query.granularidad : 'dia';
    const hoy = hoyMadrid();
    const porDefecto = { dia: { days: 29 }, semana: { weeks: 11 }, mes: { months: 11 } }[granularidad];
    const hasta = parseDia(req.query.hasta, hoy);
    let desde = parseDia(req.query.desde, hasta.minus(porDefecto));
    if (granularidad === 'semana') desde = desde.startOf('week');
    if (granularidad === 'mes') desde = desde.startOf('month');
    if (desde > hasta) return res.status(400).json({ error: 'desde debe ser anterior a hasta' });

    const filas = await diarios({ locationId: req.query.location_id || null, desde, hasta });

    // Buckets vacíos incluidos, para que la gráfica no salte periodos.
    const buckets = new Map();
    const paso = { dia: { days: 1 }, semana: { weeks: 1 }, mes: { months: 1 } }[granularidad];
    for (let d = desde; d <= hasta; d = d.plus(paso)) {
      const k = claveBucket(d, granularidad);
      buckets.set(k, { periodo: k, total: 0, ...Object.fromEntries(CANALES.map(c => [c, 0])) });
    }
    for (const f of filas) {
      const b = buckets.get(claveBucket(DateTime.fromISO(f.dia, { zone: TZ }), granularidad));
      if (!b) continue;
      b.total += f.total;
      b[f.canal] = (b[f.canal] || 0) + f.total;
    }
    res.json({ granularidad, desde: desde.toISODate(), hasta: hasta.toISODate(), canales: CANALES, serie: [...buckets.values()] });
  } catch (e) {
    console.error('[leads] GET /serie:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /matriz — cliente × últimos 12 meses (incluido el actual).
router.get('/matriz', requireAuth, async (_req, res) => {
  try {
    const hoy = hoyMadrid();
    const desde = hoy.startOf('month').minus({ months: 11 });
    const meses = Array.from({ length: 12 }, (_, i) => desde.plus({ months: i }).toFormat('yyyy-MM'));

    const [{ data: clientes, error }, filas] = await Promise.all([
      supabase.from('clientes_ghl').select('location_id, nombre, activo').order('nombre'),
      diarios({ desde, hasta: hoy }),
    ]);
    if (error) throw new Error(error.message);

    const celdas = {};
    for (const f of filas) {
      const k = `${f.location_id}|${f.dia.slice(0, 7)}`;
      celdas[k] = (celdas[k] || 0) + f.total;
    }
    const totales = Object.fromEntries(meses.map(m => [m, 0]));
    const filasMatriz = clientes
      .map(c => {
        const valores = Object.fromEntries(meses.map(m => [m, celdas[`${c.location_id}|${m}`] || 0]));
        meses.forEach(m => { totales[m] += valores[m]; });
        return { location_id: c.location_id, nombre: c.nombre, activo: c.activo, meses: valores, total: Object.values(valores).reduce((a, b) => a + b, 0) };
      })
      .filter(c => c.activo || c.total > 0);

    res.json({ meses, clientes: filasMatriz, totales });
  } catch (e) {
    console.error('[leads] GET /matriz:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /desglose?location_id=&desde=&hasta= — totales por canal y por utm_campaign.
router.get('/desglose', requireAuth, async (req, res) => {
  try {
    const hoy = hoyMadrid();
    const hasta = parseDia(req.query.hasta, hoy);
    const desde = parseDia(req.query.desde, hoy.startOf('month'));
    const locationId = req.query.location_id || null;

    const [filas, campanas] = await Promise.all([
      diarios({ locationId, desde, hasta }),
      fetchAll(() => filtrosLeads(
        supabase.from('leads').select('utm_campaign, canal').order('ghl_contact_id'),
        { location_id: locationId, desde: desde.toISODate(), hasta: hasta.toISODate() },
      )),
    ]);

    const porCanal = Object.fromEntries(CANALES.map(c => [c, 0]));
    for (const f of filas) porCanal[f.canal] = (porCanal[f.canal] || 0) + f.total;

    const porCampana = {};
    for (const l of campanas) {
      const k = l.utm_campaign || '(sin campaña)';
      porCampana[k] ||= { utm_campaign: l.utm_campaign, total: 0, canales: {} };
      porCampana[k].total += 1;
      porCampana[k].canales[l.canal] = (porCampana[k].canales[l.canal] || 0) + 1;
    }

    res.json({
      desde: desde.toISODate(), hasta: hasta.toISODate(),
      total: Object.values(porCanal).reduce((a, b) => a + b, 0),
      por_canal: CANALES.map(c => ({ canal: c, total: porCanal[c] })),
      por_campana: Object.values(porCampana).sort((a, b) => b.total - a.total),
    });
  } catch (e) {
    console.error('[leads] GET /desglose:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---- Sync ----

// POST /sync?location_id= — sync manual (admin). Espera a que termine.
router.post('/sync', requireAuth, requireAdmin, async (req, res) => {
  const locationId = req.query.location_id || req.body?.location_id || undefined;
  try {
    const result = await syncLeads({ locationId });
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e.code === 'EN_CURSO') return res.status(409).json({ ok: false, error: e.message });
    console.error('[leads] POST /sync:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /sync-log?limite=&location_id=&desde= — últimas ejecuciones. Sin
// location_id se omiten las filas "sin token" (una por subcuenta y hora).
router.get('/sync-log', requireAuth, async (req, res) => {
  const limite = Math.min(parseInt(req.query.limite) || 50, 200);
  let q = supabase
    .from('leads_sync_log')
    .select('*')
    .order('inicio', { ascending: false })
    .limit(limite);
  if (req.query.location_id) q = q.eq('location_id', req.query.location_id);
  else q = q.or(`error.is.null,error.neq."${SIN_TOKEN}"`);
  if (req.query.desde) q = q.gte('inicio', req.query.desde);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---- Listado ----

// GET /export.csv — mismos filtros que el listado, sin paginar.
router.get('/export.csv', requireAuth, async (req, res) => {
  try {
    const [nombres, leads] = await Promise.all([
      nombresClientes(),
      fetchAll(() => filtrosLeads(
        supabase.from('leads').select(COLS_LISTADO).order('fecha_creacion', { ascending: false }).order('ghl_contact_id'),
        req.query,
      )),
    ]);
    const header = ['Fecha (Madrid)', 'Cliente', 'Nombre', 'Email', 'Teléfono', 'Canal', 'Fuente',
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'Tags', 'ID GHL'];
    const filas = leads.map(l => [
      DateTime.fromISO(l.fecha_creacion).setZone(TZ).toFormat('yyyy-MM-dd HH:mm'),
      nombres[l.location_id] || l.location_id, l.nombre, l.email, l.telefono, l.canal, l.fuente,
      l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, (l.tags || []).join(', '), l.ghl_contact_id,
    ]);
    const csv = [header, ...filas].map(r => r.map(csvField).join(';')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${hoyMadrid().toISODate()}.csv"`);
    res.send('﻿' + csv); // BOM: Excel-ES detecta UTF-8
  } catch (e) {
    console.error('[leads] GET /export.csv:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /?location_id=&desde=&hasta=&canal=&q=&page= — listado paginado.
router.get('/', requireAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const from = (page - 1) * PAGE_SIZE;
    const [nombres, { data, count, error }] = await Promise.all([
      nombresClientes(),
      filtrosLeads(
        supabase.from('leads').select(COLS_LISTADO, { count: 'exact' }).order('fecha_creacion', { ascending: false }),
        req.query,
      ).range(from, from + PAGE_SIZE - 1),
    ]);
    if (error) throw new Error(error.message);
    res.json({
      page, page_size: PAGE_SIZE, total: count || 0,
      data: data.map(l => ({ ...l, cliente: nombres[l.location_id] || l.location_id })),
    });
  } catch (e) {
    console.error('[leads] GET /:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
