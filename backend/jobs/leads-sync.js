// Sincronización de leads de GoHighLevel → Supabase (tablas clientes_ghl,
// leads, leads_sync_log). Cron horario en index.js y POST /api/leads/sync.
//   1. /locations/search → alta de subcuentas nuevas en clientes_ghl, siempre
//      INACTIVAS: en Leads solo cuenta lo que Miguel marca "en captación".
//   2. Por cada subcuenta activa (= en captación) CON token_privado: backfill de 12 meses si
//      nunca se sincronizó; si no, desde ultima_sync − 24 h (solape). Las que
//      no tienen token se apuntan en el log como "sin token" y se saltan (no
//      es un error: es que aún no se ha configurado).
//   3. Upsert por ghl_contact_id y una fila en leads_sync_log por subcuenta.
// Un error en una subcuenta se registra y se sigue con las demás.
const { supabase } = require('../lib/supabase');
const ghl = require('../lib/ghl');

const PAGE_LIMIT = 100;
const VENTANA_DIAS = 30;          // trocea el rango para no rozar el tope de 10.000 de page
const SOLAPE_MS = 24 * 3600_000;
const PAUSA_PAGINA_MS = 150;
const SIN_TOKEN = 'sin token'; // valor de leads_sync_log.error para subcuentas saltadas

let enCurso = false;

async function altaSubcuentas() {
  const locations = await ghl.listarLocations();
  const { data: existentes, error } = await supabase.from('clientes_ghl').select('location_id');
  if (error) throw new Error(`clientes_ghl: ${error.message}`);
  const ya = new Set(existentes.map(r => r.location_id));
  const nuevas = locations
    .filter(l => l.id && !ya.has(l.id))
    .map(l => ({ location_id: l.id, nombre: (l.name || l.id).trim(), activo: false }));
  if (nuevas.length) {
    // ignoreDuplicates: nunca pisa nombre/activo/mapeo editados a mano.
    const { error: insErr } = await supabase
      .from('clientes_ghl')
      .upsert(nuevas, { onConflict: 'location_id', ignoreDuplicates: true });
    if (insErr) throw new Error(`alta clientes_ghl: ${insErr.message}`);
  }
  console.log(`[leads] ${locations.length} subcuentas en GHL (${nuevas.length} nuevas)`);
  return { subcuentas: locations.length, nuevas: nuevas.map(n => n.nombre) };
}

async function guardarLeads(contactos, locationId) {
  const filas = contactos
    .filter(c => c.id && c.dateAdded)
    .map(c => ghl.contactoALead(c, locationId));
  if (!filas.length) return { nuevos: 0, actualizados: 0 };

  const ids = filas.map(f => f.ghl_contact_id);
  const { data: existentes, error: selErr } = await supabase
    .from('leads').select('ghl_contact_id').in('ghl_contact_id', ids);
  if (selErr) throw new Error(`leads select: ${selErr.message}`);

  const { error } = await supabase.from('leads').upsert(filas, { onConflict: 'ghl_contact_id' });
  if (error) throw new Error(`leads upsert: ${error.message}`);
  return { nuevos: filas.length - existentes.length, actualizados: existentes.length };
}

// Todas las páginas de una ventana [gte, lte].
async function syncVentana(cliente, gte, lte, totales) {
  let searchAfter = null;
  let page = 1;
  let primeroAnterior = null;
  for (;;) {
    const data = await ghl.buscarContactos(cliente, { gte, lte, searchAfter, page, pageLimit: PAGE_LIMIT });
    const contactos = data.contacts || [];
    if (contactos.length && contactos[0].id === primeroAnterior) {
      throw new Error('GHL devolvió la misma página dos veces (paginación ignorada)');
    }
    primeroAnterior = contactos[0]?.id || null;

    const r = await guardarLeads(contactos, cliente.location_id);
    totales.nuevos += r.nuevos;
    totales.actualizados += r.actualizados;

    if (contactos.length < PAGE_LIMIT) return;
    const cursor = contactos[contactos.length - 1].searchAfter;
    if (Array.isArray(cursor) && cursor.length) {
      searchAfter = cursor;
    } else {
      searchAfter = null;
      page += 1;
      if (page * PAGE_LIMIT > 10000) throw new Error(`Más de 10.000 contactos entre ${gte} y ${lte} sin cursor searchAfter`);
    }
    await ghl.sleep(PAUSA_PAGINA_MS);
  }
}

async function syncCliente(cliente) {
  const inicio = new Date();
  if (!cliente.token_privado) {
    const { error: logErr } = await supabase.from('leads_sync_log').insert({
      location_id: cliente.location_id, inicio: inicio.toISOString(), fin: inicio.toISOString(), error: SIN_TOKEN,
    });
    if (logErr) console.error('[leads] ERROR escribiendo leads_sync_log:', logErr.message);
    return { location_id: cliente.location_id, nombre: cliente.nombre, leads_nuevos: 0, leads_actualizados: 0, error: null, sin_token: true };
  }

  const desde = cliente.ultima_sync
    ? new Date(new Date(cliente.ultima_sync).getTime() - SOLAPE_MS)
    : new Date(Date.UTC(inicio.getUTCFullYear() - 1, inicio.getUTCMonth(), inicio.getUTCDate()));
  const totales = { nuevos: 0, actualizados: 0 };
  let error = null;

  try {
    for (let t = desde.getTime(); t < inicio.getTime(); t += VENTANA_DIAS * 86400_000) {
      const fin = Math.min(t + VENTANA_DIAS * 86400_000, inicio.getTime());
      await syncVentana(cliente, new Date(t).toISOString(), new Date(fin).toISOString(), totales);
    }
    const { error: updErr } = await supabase
      .from('clientes_ghl').update({ ultima_sync: inicio.toISOString() }).eq('location_id', cliente.location_id);
    if (updErr) throw new Error(`ultima_sync: ${updErr.message}`);
    console.log(`[leads] ✓ ${cliente.nombre} — ${totales.nuevos} nuevos, ${totales.actualizados} actualizados`);
  } catch (e) {
    error = e.message;
    console.error(`[leads] ERROR ${cliente.nombre} (${cliente.location_id}): ${error}`);
  }

  const { error: logErr } = await supabase.from('leads_sync_log').insert({
    location_id: cliente.location_id,
    inicio: inicio.toISOString(),
    fin: new Date().toISOString(),
    leads_nuevos: totales.nuevos,
    leads_actualizados: totales.actualizados,
    error,
  });
  if (logErr) console.error('[leads] ERROR escribiendo leads_sync_log:', logErr.message);

  return {
    location_id: cliente.location_id, nombre: cliente.nombre,
    leads_nuevos: totales.nuevos, leads_actualizados: totales.actualizados, error,
    backfill: !cliente.ultima_sync, sin_token: false,
  };
}

async function syncLeads({ locationId } = {}) {
  if (enCurso) {
    const err = new Error('Ya hay una sincronización de leads en curso');
    err.code = 'EN_CURSO';
    throw err;
  }
  enCurso = true;
  const t0 = Date.now();
  try {
    let alta = null;
    let errorAlta = null;
    if (!locationId) {
      try {
        alta = await altaSubcuentas();
      } catch (e) {
        // Sin listado de subcuentas se sigue con las ya dadas de alta.
        errorAlta = e.message;
        console.error('[leads] ERROR listando subcuentas:', e.message);
      }
    }

    let q = supabase.from('clientes_ghl').select('*').eq('activo', true).order('nombre');
    if (locationId) q = q.eq('location_id', locationId);
    const { data: clientes, error } = await q;
    if (error) throw new Error(`clientes_ghl: ${error.message}`);

    const resultados = [];
    for (const cliente of clientes) resultados.push(await syncCliente(cliente));

    const resumen = {
      subcuentas_ghl: alta?.subcuentas ?? null,
      subcuentas_nuevas: alta?.nuevas ?? [],
      error_subcuentas: errorAlta,
      clientes: resultados,
      leads_nuevos: resultados.reduce((s, r) => s + r.leads_nuevos, 0),
      leads_actualizados: resultados.reduce((s, r) => s + r.leads_actualizados, 0),
      con_error: resultados.filter(r => r.error).length,
      sin_token: resultados.filter(r => r.sin_token).map(r => r.nombre),
      segundos: Math.round((Date.now() - t0) / 1000),
    };
    console.log(`[leads] sync terminada en ${resumen.segundos}s — ${resumen.leads_nuevos} nuevos, ${resumen.con_error} con error, ${resumen.sin_token.length} sin token (saltadas)`);
    return resumen;
  } finally {
    enCurso = false;
  }
}

// Backfill de una subcuenta en segundo plano (tras guardar su token). Si hay
// otra sync en curso, espera a que acabe en vez de fallar con EN_CURSO.
function syncSubcuentaEnSegundoPlano(locationId) {
  (async () => {
    for (let i = 0; enCurso && i < 360; i++) await ghl.sleep(5000); // máx. 30 min esperando
    try {
      await syncLeads({ locationId });
    } catch (e) {
      console.error(`[leads] backfill en segundo plano de ${locationId} falló:`, e.message);
    }
  })();
}

module.exports = { syncLeads, syncSubcuentaEnSegundoPlano, SIN_TOKEN };
