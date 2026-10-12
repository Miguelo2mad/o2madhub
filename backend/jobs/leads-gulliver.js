// Sync de Gulliver AI → leads_ia_contacto y leads_citas (cron horario, minuto 40).
// Por cada subcuenta de clientes_gulliver activa:
//   - contactos con actividad desde la última sync (−24 h de solape; la primera
//     vez, todo el histórico). Gulliver devuelve las cifras de todo el historial
//     del contacto, así que el upsert deja la fila al día.
//   - citas creadas o con fecha en los últimos 60 días (recoge cambios de estado:
//     cancelada, no_show). La primera vez, todas.
// El cruce con leads se hace al consultar (backend/api/leads.js → cruceGulliver).
const { supabase } = require('../lib/supabase');
const gulliver = require('../lib/gulliver');

const BACKFILL_DESDE = '2024-01-01';
const SOLAPE_MS = 24 * 3600_000;
const VENTANA_CITAS_MS = 60 * 86400_000;
const LOTE = 500;

let enCurso = false;

async function upsertPorLotes(tabla, filas, onConflict) {
  for (let i = 0; i < filas.length; i += LOTE) {
    const { error } = await supabase.from(tabla).upsert(filas.slice(i, i + LOTE), { onConflict });
    if (error) throw new Error(`${tabla}: ${error.message}`);
  }
}

async function syncClienteGulliver(cliente, { desde } = {}) {
  const t0 = Date.now();
  const ahora = new Date();
  const primera = !cliente.ultimo_sync_at;
  const desdeContactos = desde || (primera ? BACKFILL_DESDE
    : new Date(new Date(cliente.ultimo_sync_at).getTime() - SOLAPE_MS).toISOString());
  const desdeCitas = desde || (primera ? BACKFILL_DESDE
    : new Date(ahora.getTime() - VENTANA_CITAS_MS).toISOString());

  try {
    const contactos = await gulliver.contactos({ hotelId: cliente.hotel_id, desde: desdeContactos });
    // Gulliver ya agrupa por E.164; se vuelve a normalizar por si acaso y se descartan repetidos.
    const porTel = new Map();
    for (const c of contactos) {
      const telefono = gulliver.telefonoE164(c.phone);
      if (!telefono) continue;
      porTel.set(telefono, {
        location_id: cliente.location_id,
        telefono,
        ghl_contact_id: c.ghl_contact_id || null,
        primera_at: c.primera_at,
        ultima_at: c.ultima_at,
        mensajes: c.mensajes || 0,
        mensajes_usuario: c.mensajes_usuario || 0,
        llamadas: c.llamadas || 0,
        primera_respuesta_ia_at: c.primera_respuesta_ia_at || null,
        canales: c.canales || [],
        synced_at: ahora.toISOString(),
      });
    }
    await upsertPorLotes('leads_ia_contacto', [...porTel.values()], 'location_id,telefono');

    const citas = await gulliver.citas({ hotelId: cliente.hotel_id, desde: desdeCitas });
    await upsertPorLotes('leads_citas', citas.map(c => ({
      id: c.id,
      location_id: cliente.location_id,
      telefono: gulliver.telefonoE164(c.phone),
      ghl_contact_id: c.ghl_contact_id || null,
      creada_at: c.created_at || null,
      starts_at: c.starts_at,
      estado: c.status,
      origen: c.source || null,
      canal: c.channel || null,
      tratamiento: c.treatment || null,
      cancelada_at: c.cancelled_at || null,
      synced_at: ahora.toISOString(),
    })), 'id');

    await supabase.from('clientes_gulliver')
      .update({ ultimo_sync_at: ahora.toISOString(), error: null })
      .eq('location_id', cliente.location_id);
    const r = { location_id: cliente.location_id, contactos: porTel.size, citas: citas.length, segundos: Math.round((Date.now() - t0) / 1000) };
    console.log(`[leads-gulliver] ${cliente.location_id}: ${r.contactos} contactos, ${r.citas} citas en ${r.segundos}s`);
    return r;
  } catch (e) {
    console.error(`[leads-gulliver] ${cliente.location_id} falló:`, e.message);
    await supabase.from('clientes_gulliver').update({ error: e.message.slice(0, 500) }).eq('location_id', cliente.location_id);
    return { location_id: cliente.location_id, error: e.message };
  }
}

async function syncGulliver({ locationId, desde } = {}) {
  if (enCurso) return { omitida: 'ya hay una sync de Gulliver en curso' };
  if (!process.env.GULLIVER_API_KEY) {
    console.warn('[leads-gulliver] GULLIVER_API_KEY no configurada: se omite');
    return { omitida: 'GULLIVER_API_KEY no configurada' };
  }
  enCurso = true;
  try {
    let q = supabase.from('clientes_gulliver').select('*').eq('activo', true);
    if (locationId) q = q.eq('location_id', locationId);
    const { data: clientes, error } = await q;
    if (error) throw new Error(`clientes_gulliver: ${error.message}`);
    const resultados = [];
    for (const c of clientes) resultados.push(await syncClienteGulliver(c, { desde }));
    return { clientes: resultados };
  } finally {
    enCurso = false;
  }
}

module.exports = { syncGulliver };
