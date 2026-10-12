// Módulo Leads: contactos de GoHighLevel por cliente (ver backend/jobs/leads-sync.js
// y docs/leads.md). Fechas guardadas en UTC; todo se agrega en Europe/Madrid.
const express = require('express');
const router = express.Router();
const { DateTime } = require('luxon');
const { supabase } = require('../lib/supabase');
const { syncLeads, syncSubcuentaEnSegundoPlano, SIN_TOKEN } = require('../jobs/leads-sync');
const { validarTokenPrivado } = require('../lib/ghl');

const TZ = 'Europe/Madrid';
const CANALES = ['meta', 'google', 'organico', 'directo', 'manual', 'otro'];
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

// Subcuentas "en captación" (activo = true). Todo lo global (panel de
// agencia, ranking, matriz, totales sin location_id) ignora las inactivas,
// tengan o no token. Pedir una subcuenta concreta por location_id sí funciona
// aunque esté inactiva (su panel sigue siendo consultable por URL).
async function locationsActivas() {
  const { data, error } = await supabase.from('clientes_ghl').select('location_id').eq('activo', true);
  if (error) throw new Error(error.message);
  return data.map(c => c.location_id);
}

// location_ids que abarca una petición: la subcuenta pedida o todas las activas.
const locationsAmbito = async locationId => (locationId ? [locationId] : locationsActivas());

// Filas de la vista leads_diarios entre dos días Madrid (inclusive), de una
// subcuenta o de todas las activas.
async function diarios({ locationId, desde, hasta }) {
  const ambito = locationId ? [locationId] : await locationsActivas();
  return fetchAll(() => supabase.from('leads_diarios')
    .select('location_id, dia, canal, total')
    .in('location_id', ambito)
    .gte('dia', desde.toISODate())
    .lte('dia', hasta.toISODate())
    .order('dia').order('location_id').order('canal'));
}

const sumar = (filas, pred) => filas.reduce((s, f) => (pred(f) ? s + f.total : s), 0);
const variacion = (actual, anterior) => (anterior > 0 ? Math.round(((actual - anterior) / anterior) * 1000) / 10 : null);

function claveBucket(dia, granularidad) {
  if (granularidad === 'mes') return dia.toFormat('yyyy-MM');
  if (granularidad === 'semana') return dia.startOf('week').toISODate();
  return dia.toISODate();
}

// granularidad + desde/hasta de la query, con desde alineado al inicio de
// semana/mes. Sin fechas: últimos 30 días / 12 semanas / 12 meses.
function rangoSerie(query) {
  const granularidad = ['dia', 'semana', 'mes'].includes(query.granularidad) ? query.granularidad : 'dia';
  const porDefecto = { dia: { days: 29 }, semana: { weeks: 11 }, mes: { months: 11 } }[granularidad];
  const hasta = parseDia(query.hasta, hoyMadrid());
  let desde = parseDia(query.desde, hasta.minus(porDefecto));
  if (granularidad === 'semana') desde = desde.startOf('week');
  if (granularidad === 'mes') desde = desde.startOf('month');
  return { granularidad, desde, hasta };
}

// Buckets vacíos de desde a hasta (para que las gráficas no salten periodos).
function crearBuckets(desde, hasta, granularidad, init) {
  const buckets = new Map();
  const paso = { dia: { days: 1 }, semana: { weeks: 1 }, mes: { months: 1 } }[granularidad];
  for (let d = desde; d <= hasta; d = d.plus(paso)) {
    const k = claveBucket(d, granularidad);
    buckets.set(k, { periodo: k, ...init() });
  }
  return buckets;
}

// Periodo anterior comparable: si el rango empieza el día 1 y no sale del mes,
// los mismos días del mes anterior; si no, el mismo nº de días justo antes.
function periodoAnterior(desde, hasta) {
  if (desde.day === 1 && desde.hasSame(hasta, 'month')) {
    const d = desde.minus({ months: 1 });
    const h = DateTime.min(hasta.minus({ months: 1 }), d.endOf('month').startOf('day'));
    return { desde: d, hasta: h };
  }
  const dias = Math.round(hasta.diff(desde, 'days').days) + 1;
  const h = desde.minus({ days: 1 });
  return { desde: h.minus({ days: dias - 1 }), hasta: h };
}

const rangoPeriodo = query => {
  const hoy = hoyMadrid();
  return { desde: parseDia(query.desde, hoy.startOf('month')), hasta: parseDia(query.hasta, hoy) };
};

function sanitizarBusqueda(q) {
  return String(q || '').replace(/[,()*%\\]/g, ' ').trim().slice(0, 100);
}

// Filtros comunes del listado, el CSV, el desglose y el heatmap sobre la
// tabla leads. ambito = location_ids permitidos (ver locationsAmbito).
function filtrosLeads(q, ambito, { desde, hasta, canal, q: busqueda }) {
  q = q.in('location_id', ambito);
  const d = parseDia(desde, null);
  const h = parseDia(hasta, null);
  if (d) q = q.gte('fecha_creacion', d.toUTC().toISO());
  if (h) q = q.lte('fecha_creacion', h.endOf('day').toUTC().toISO());
  if (canal && CANALES.includes(canal)) q = q.eq('canal', canal);
  const s = sanitizarBusqueda(busqueda);
  if (s) q = q.or(`nombre.ilike.*${s}*,email.ilike.*${s}*,telefono.ilike.*${s}*,utm_campaign.ilike.*${s}*`);
  return q;
}

const COLS_LISTADO = 'ghl_contact_id, location_id, nombre, email, telefono, fuente, canal, utm_source, utm_medium, utm_campaign, utm_content, campaign_id, ad_id, tags, fecha_creacion';

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

// Mapeos subcuenta → cuenta de anuncios (tabla de la migración 053).
async function cuentasPublicidad(locationId) {
  let q = supabase.from('cuentas_publicidad').select('fuente, cuenta_id, location_id, campana_filtro');
  if (locationId) q = q.eq('location_id', locationId);
  const { data, error } = await q;
  if (error) throw new Error(`cuentas_publicidad: ${error.message}`);
  return data;
}

// GET /clientes — subcuentas con leads del mes actual (Madrid).
router.get('/clientes', requireAuth, async (_req, res) => {
  try {
    const { data: clientes, error } = await supabase
      .from('clientes_ghl')
      .select('id, location_id, nombre, cliente_id, activo, ultima_sync, created_at, token_privado, crm_empresas(nombre)')
      .order('nombre');
    if (error) throw new Error(error.message);

    const hoy = hoyMadrid();
    const [filas, cuentas] = await Promise.all([diarios({ desde: hoy.startOf('month'), hasta: hoy }), cuentasPublicidad()]);
    const porLocation = {};
    for (const f of filas) porLocation[f.location_id] = (porLocation[f.location_id] || 0) + f.total;

    // El token privado nunca sale del backend: solo si existe y sus últimos 4.
    res.json(clientes.map(({ token_privado, crm_empresas, ...c }) => ({
      ...c,
      cliente_nombre: crm_empresas?.nombre || null,
      ...infoToken(token_privado),
      leads_mes: porLocation[c.location_id] || 0,
      cuentas_ads: cuentas.filter(m => m.location_id === c.location_id),
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

// PATCH /clientes/:location_id — nombre, cliente_id, activo ("en captación"),
// token_privado. token_privado: string = validar contra GET /locations/{id} y
// guardar; '' o null = borrar; ausente = no tocar. Se lanza en segundo plano
// la sync de la subcuenta si queda en captación con token y, o bien el token
// es nuevo (backfill de 12 meses), o bien se acaba de poner en captación.
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

  const { data: previo } = await supabase.from('clientes_ghl').select('activo').eq('location_id', locationId).maybeSingle();
  const { data, error } = await supabase
    .from('clientes_ghl')
    .update(cambios)
    .eq('location_id', locationId)
    .select('location_id, nombre, cliente_id, activo, ultima_sync, token_privado')
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Subcuenta no encontrada' });

  const recienActivada = data.activo && previo && !previo.activo;
  const backfill = data.activo && !!data.token_privado && (!!tokenNuevo || recienActivada);
  const lanzadoEn = new Date().toISOString();
  if (backfill) {
    console.log(`[leads] ${data.nombre}: ${tokenNuevo ? 'token nuevo' : 'puesta en captación'}; sync en segundo plano`);
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
    const { granularidad, desde, hasta } = rangoSerie(req.query);
    if (desde > hasta) return res.status(400).json({ error: 'desde debe ser anterior a hasta' });

    const filas = await diarios({ locationId: req.query.location_id || null, desde, hasta });

    const buckets = crearBuckets(desde, hasta, granularidad, () => ({ total: 0, ...Object.fromEntries(CANALES.map(c => [c, 0])) }));
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

// GET /matriz — cliente × últimos 12 meses (incluido el actual). Solo subcuentas activas con token.
router.get('/matriz', requireAuth, async (_req, res) => {
  try {
    const hoy = hoyMadrid();
    const desde = hoy.startOf('month').minus({ months: 11 });
    const meses = Array.from({ length: 12 }, (_, i) => desde.plus({ months: i }).toFormat('yyyy-MM'));

    const [{ data: clientes, error }, filas] = await Promise.all([
      supabase.from('clientes_ghl').select('location_id, nombre').eq('activo', true).not('token_privado', 'is', null).order('nombre'),
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
        return { location_id: c.location_id, nombre: c.nombre, meses: valores, total: Object.values(valores).reduce((a, b) => a + b, 0) };
      });

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

    const ambito = await locationsAmbito(locationId);
    const [filas, campanas] = await Promise.all([
      diarios({ locationId, desde, hasta }),
      fetchAll(() => filtrosLeads(
        supabase.from('leads').select('utm_campaign, canal').order('ghl_contact_id'),
        ambito, { desde: desde.toISODate(), hasta: hasta.toISODate() },
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

// GET /ranking?desde=&hasta= — subcuentas activas con token por leads del periodo
// (por defecto, el mes en curso) y variación frente al periodo anterior.
router.get('/ranking', requireAuth, async (req, res) => {
  try {
    const { desde, hasta } = rangoPeriodo(req.query);
    const ant = periodoAnterior(desde, hasta);
    const [{ data: clientes, error }, filas] = await Promise.all([
      supabase.from('clientes_ghl').select('location_id, nombre').eq('activo', true).not('token_privado', 'is', null),
      diarios({ desde: ant.desde, hasta }),
    ]);
    if (error) throw new Error(error.message);

    const enRango = (loc, a, b) => f => f.location_id === loc && f.dia >= a.toISODate() && f.dia <= b.toISODate();
    const ranking = clientes.map(c => {
      const leads = sumar(filas, enRango(c.location_id, desde, hasta));
      const anterior = sumar(filas, enRango(c.location_id, ant.desde, ant.hasta));
      return { location_id: c.location_id, nombre: c.nombre, leads, leads_anterior: anterior, variacion_pct: variacion(leads, anterior) };
    }).sort((a, b) => b.leads - a.leads || b.leads_anterior - a.leads_anterior);

    res.json({
      desde: desde.toISODate(), hasta: hasta.toISODate(),
      anterior: { desde: ant.desde.toISODate(), hasta: ant.hasta.toISODate() },
      ranking,
    });
  } catch (e) {
    console.error('[leads] GET /ranking:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /heatmap?location_id=&desde=&hasta= — leads por día de la semana (0 =
// lunes) × hora, en Europe/Madrid, con totales por día, por hora y por franja.
const FRANJAS = [
  { nombre: 'Madrugada', desde: 0, hasta: 7 },
  { nombre: 'Mañana', desde: 7, hasta: 13 },
  { nombre: 'Mediodía', desde: 13, hasta: 16 },
  { nombre: 'Tarde', desde: 16, hasta: 20 },
  { nombre: 'Noche', desde: 20, hasta: 24 },
];
router.get('/heatmap', requireAuth, async (req, res) => {
  try {
    const { desde, hasta } = rangoPeriodo(req.query);
    const ambito = await locationsAmbito(req.query.location_id || null);
    const leads = await fetchAll(() => filtrosLeads(
      supabase.from('leads').select('fecha_creacion').order('ghl_contact_id'),
      ambito, { desde: desde.toISODate(), hasta: hasta.toISODate() },
    ));
    const matriz = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const l of leads) {
      const d = DateTime.fromISO(l.fecha_creacion).setZone(TZ);
      matriz[d.weekday - 1][d.hour] += 1;
    }
    const porHora = Array.from({ length: 24 }, (_, h) => matriz.reduce((s, fila) => s + fila[h], 0));
    res.json({
      desde: desde.toISODate(), hasta: hasta.toISODate(),
      total: leads.length,
      matriz,
      por_dia: matriz.map(fila => fila.reduce((a, b) => a + b, 0)),
      por_hora: porHora,
      por_franja: FRANJAS.map(f => ({ ...f, total: porHora.slice(f.desde, f.hasta).reduce((a, b) => a + b, 0) })),
    });
  } catch (e) {
    console.error('[leads] GET /heatmap:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /coste?location_id=&granularidad=&desde=&hasta=&fuente=google — gasto de
// la vista gasto_diario ÷ leads del mismo canal, por periodo, con totales del
// rango y del periodo anterior. Hoy fuente = google; meta entrará igual.
router.get('/coste', requireAuth, async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id es obligatorio' });
  const fuente = req.query.fuente === 'meta' ? 'meta' : 'google';
  try {
    const cuentas = (await cuentasPublicidad(locationId)).filter(c => c.fuente === fuente);
    if (!cuentas.length) return res.json({ fuente, mapeada: false });

    const { granularidad, desde, hasta } = rangoSerie(req.query);
    const ant = periodoAnterior(desde, hasta);
    const [gasto, filas] = await Promise.all([
      fetchAll(() => supabase.from('gasto_diario')
        .select('fecha, gasto, impresiones, clics')
        .eq('fuente', fuente).eq('location_id', locationId)
        .gte('fecha', ant.desde.toISODate()).lte('fecha', hasta.toISODate())
        .order('fecha')),
      diarios({ locationId, desde: ant.desde, hasta }),
    ]);

    const buckets = crearBuckets(desde, hasta, granularidad, () => ({ gasto: 0, impresiones: 0, clics: 0, leads: 0 }));
    const acumular = (b, g) => { b.gasto += Number(g.gasto) || 0; b.impresiones += g.impresiones || 0; b.clics += g.clics || 0; };
    const totales = { gasto: 0, impresiones: 0, clics: 0, leads: 0 };
    const anterior = { gasto: 0, impresiones: 0, clics: 0, leads: 0 };
    const enActual = dia => dia >= desde.toISODate() && dia <= hasta.toISODate();
    const enAnterior = dia => dia >= ant.desde.toISODate() && dia <= ant.hasta.toISODate();

    for (const g of gasto) {
      if (enActual(g.fecha)) {
        acumular(totales, g);
        const b = buckets.get(claveBucket(DateTime.fromISO(g.fecha, { zone: TZ }), granularidad));
        if (b) acumular(b, g);
      } else if (enAnterior(g.fecha)) acumular(anterior, g);
    }
    for (const f of filas) {
      if (f.canal !== fuente) continue;
      if (enActual(f.dia)) {
        totales.leads += f.total;
        const b = buckets.get(claveBucket(DateTime.fromISO(f.dia, { zone: TZ }), granularidad));
        if (b) b.leads += f.total;
      } else if (enAnterior(f.dia)) anterior.leads += f.total;
    }
    const cpl = t => (t.leads > 0 ? Math.round((t.gasto / t.leads) * 100) / 100 : null);
    const conCpl = t => ({ ...t, gasto: Math.round(t.gasto * 100) / 100, cpl: cpl(t) });

    res.json({
      fuente, mapeada: true, cuentas, granularidad,
      desde: desde.toISODate(), hasta: hasta.toISODate(),
      anterior_rango: { desde: ant.desde.toISODate(), hasta: ant.hasta.toISODate() },
      // Primer día con gasto registrado: el sync de Google Ads guarda una
      // ventana móvil de 30 días, así que antes de esa fecha no hay datos.
      primer_dia_gasto: gasto[0]?.fecha || null,
      totales: conCpl(totales),
      anterior: conCpl(anterior),
      variacion_cpl_pct: cpl(totales) != null && cpl(anterior) != null ? variacion(cpl(totales), cpl(anterior)) : null,
      variacion_gasto_pct: variacion(totales.gasto, anterior.gasto),
      variacion_leads_pct: variacion(totales.leads, anterior.leads),
      serie: [...buckets.values()].map(conCpl),
    });
  } catch (e) {
    console.error('[leads] GET /coste:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---- Cuentas de anuncios (admin) ----

// GET /cuentas-ads — cuentas de Google Ads dadas de alta en Campañas.
router.get('/cuentas-ads', requireAuth, requireAdmin, async (_req, res) => {
  const { data, error } = await supabase
    .from('google_ads_clientes').select('customer_id, nombre_cliente, activo').order('nombre_cliente');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ google: data });
});

// PUT /clientes/:location_id/cuentas-ads — reemplaza los mapeos de esa
// subcuenta. Body: { cuentas: [{ fuente, cuenta_id, campana_filtro }] }.
// campana_filtro: patrón ILIKE sobre el nombre de campaña (p. ej. "%Rupit%"),
// para cuentas que se reparten entre varias subcuentas; vacío = todas.
router.put('/clientes/:location_id/cuentas-ads', requireAuth, requireAdmin, async (req, res) => {
  const locationId = req.params.location_id;
  const cuentas = Array.isArray(req.body?.cuentas) ? req.body.cuentas : null;
  if (!cuentas) return res.status(400).json({ error: 'cuentas debe ser un array' });
  const filas = cuentas
    .filter(c => c && c.cuenta_id)
    .map(c => ({
      fuente: c.fuente === 'meta' ? 'meta' : 'google',
      cuenta_id: String(c.cuenta_id).replace(/-/g, '').trim(),
      location_id: locationId,
      campana_filtro: c.campana_filtro ? String(c.campana_filtro).trim() : null,
    }));
  try {
    const { error: delErr } = await supabase.from('cuentas_publicidad').delete().eq('location_id', locationId);
    if (delErr) throw new Error(delErr.message);
    if (filas.length) {
      const { error: insErr } = await supabase.from('cuentas_publicidad').insert(filas);
      if (insErr) throw new Error(insErr.message);
    }
    res.json(await cuentasPublicidad(locationId));
  } catch (e) {
    console.error('[leads] PUT cuentas-ads:', e.message);
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
    const ambito = await locationsAmbito(req.query.location_id || null);
    const [nombres, leads] = await Promise.all([
      nombresClientes(),
      fetchAll(() => filtrosLeads(
        supabase.from('leads').select(COLS_LISTADO).order('fecha_creacion', { ascending: false }).order('ghl_contact_id'),
        ambito, req.query,
      )),
    ]);
    const header = ['Fecha (Madrid)', 'Cliente', 'Nombre', 'Email', 'Teléfono', 'Canal', 'Fuente',
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'campaign_id', 'ad_id', 'Tags', 'ID GHL'];
    const filas = leads.map(l => [
      DateTime.fromISO(l.fecha_creacion).setZone(TZ).toFormat('yyyy-MM-dd HH:mm'),
      nombres[l.location_id] || l.location_id, l.nombre, l.email, l.telefono, l.canal, l.fuente,
      l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.campaign_id, l.ad_id, (l.tags || []).join(', '), l.ghl_contact_id,
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
    const ambito = await locationsAmbito(req.query.location_id || null);
    const [nombres, { data, count, error }] = await Promise.all([
      nombresClientes(),
      filtrosLeads(
        supabase.from('leads').select(COLS_LISTADO, { count: 'exact' }).order('fecha_creacion', { ascending: false }),
        ambito, req.query,
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
