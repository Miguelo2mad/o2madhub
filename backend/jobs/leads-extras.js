// Extras de Leads que se calculan tras sincronizar los contactos de una
// subcuenta (ver leads-sync.js → syncCliente). Cada uno es independiente: un
// fallo se registra y no tumba la sync de leads.
//   - marcarImportados: contactos de una importación masiva (≥30 altas en
//     ±5 min), que no son leads de ese día; el módulo los excluye.
//   - marcarDuplicados: mismo teléfono normalizado o email dentro de la
//     subcuenta (sin contar importados); el primero por fecha es el original.
//   - syncOportunidades: pipelines (etapas en el orden de GHL) + todas las
//     oportunidades de la subcuenta.
//   - syncRespuestas: primera respuesta AUTOMÁTICA y primera HUMANA tras el
//     alta de cada lead (velocidad de respuesta). Incremental y con tope por ejecución; el
//     histórico se completa con backend/scripts/leads-respuestas.js.
const { supabase } = require('../lib/supabase');
const ghl = require('../lib/ghl');

const LOTE = 500;
const VENTANA_RESPUESTA_MS = 7 * 86400_000; // tras 7 días sin respuesta ya no se vuelve a mirar
const RECHEQUEO_MS = 3600_000;              // un lead sin respuesta se re-mira como mucho cada hora

// Humana = escrita por un usuario de GHL (el mensaje trae userId) o llamada
// saliente que no lanza una app. Automática = todo lo demás: workflows,
// campañas y apps del marketplace (bots/IA: source "app" + meta.marketplace,
// sin userId). Verificado en Nadal (oct 2026): 218 salientes, 0 con userId.
const deMarketplace = m => /marketplace/.test(typeof m.meta === 'string' ? m.meta : JSON.stringify(m.meta || {}));
const esHumana = m => !!m.userId || (/CALL/i.test(m.messageType || '') && !deMarketplace(m));
// Apps del marketplace que son Gulliver AI enviando por GHL. Verificado en
// Nadal (oct 2026): las 216 primeras respuestas de esta app son WhatsApp, todas
// de contactos con conversación en Gulliver y 201 a ±2 min del mensaje de la IA.
const APPS_GULLIVER = new Set(['6a3d086913f8e75af6800118']);
function origenAutomatico(m) {
  if (deMarketplace(m)) {
    const meta = typeof m.meta === 'string' ? JSON.parse(m.meta || '{}') : m.meta || {};
    const appId = meta.marketplace?.appId;
    return APPS_GULLIVER.has(appId) ? 'gulliver' : `app:${appId || '?'}`;
  }
  return m.source || 'desconocido';
}

async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

const trozos = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// ---- Importaciones masivas ----

const RAFAGA_MS = 5 * 60_000;
const RAFAGA_MIN = 30;

async function marcarImportados(locationId) {
  const leads = await fetchAll(() => supabase.from('leads')
    .select('ghl_contact_id, fecha_creacion, importado')
    .eq('location_id', locationId).order('fecha_creacion').order('ghl_contact_id'));
  const t = leads.map(l => new Date(l.fecha_creacion).getTime());
  const marcar = [], desmarcar = [];
  // Ventana deslizante: altas dentro de ±5 min de cada contacto.
  let lo = 0, hi = 0;
  leads.forEach((l, i) => {
    while (t[lo] < t[i] - RAFAGA_MS) lo++;
    while (hi + 1 < t.length && t[hi + 1] <= t[i] + RAFAGA_MS) hi++;
    const importado = hi - lo + 1 >= RAFAGA_MIN;
    if (importado && !l.importado) marcar.push(l.ghl_contact_id);
    if (!importado && l.importado) desmarcar.push(l.ghl_contact_id);
  });
  for (const [ids, valor] of [[marcar, true], [desmarcar, false]]) {
    for (const tr of trozos(ids, 200)) {
      const { error } = await supabase.from('leads').update({ importado: valor }).in('ghl_contact_id', tr);
      if (error) throw new Error(`importados: ${error.message}`);
    }
  }
  return { marcados: marcar.length, desmarcados: desmarcar.length };
}

// ---- Duplicados ----

async function marcarDuplicados(locationId) {
  const leads = await fetchAll(() => supabase.from('leads')
    .select('ghl_contact_id, email, telefono, es_duplicado, duplicado_de')
    .eq('location_id', locationId).eq('importado', false)
    .order('fecha_creacion').order('ghl_contact_id'));

  const porTel = new Map();
  const porEmail = new Map();
  const deseado = new Map(); // id → id del original (o null)
  for (const l of leads) {
    const tel = ghl.normalizarTelefono(l.telefono);
    const email = ghl.normalizarEmail(l.email);
    const previo = (tel && porTel.get(tel)) || (email && porEmail.get(email)) || null;
    // Se apunta siempre al original "raíz", no a otro duplicado.
    const original = previo ? (deseado.get(previo) || previo) : null;
    deseado.set(l.ghl_contact_id, original);
    if (tel && !porTel.has(tel)) porTel.set(tel, l.ghl_contact_id);
    if (email && !porEmail.has(email)) porEmail.set(email, l.ghl_contact_id);
  }

  // Solo se escriben los que cambian, agrupados por original.
  const marcar = new Map();
  const desmarcar = [];
  for (const l of leads) {
    const orig = deseado.get(l.ghl_contact_id);
    if (orig && (l.duplicado_de !== orig || !l.es_duplicado)) {
      if (!marcar.has(orig)) marcar.set(orig, []);
      marcar.get(orig).push(l.ghl_contact_id);
    } else if (!orig && (l.es_duplicado || l.duplicado_de)) desmarcar.push(l.ghl_contact_id);
  }
  for (const [orig, ids] of marcar) {
    for (const t of trozos(ids, 200)) {
      const { error } = await supabase.from('leads').update({ es_duplicado: true, duplicado_de: orig }).in('ghl_contact_id', t);
      if (error) throw new Error(`duplicados: ${error.message}`);
    }
  }
  for (const t of trozos(desmarcar, 200)) {
    const { error } = await supabase.from('leads').update({ es_duplicado: false, duplicado_de: null }).in('ghl_contact_id', t);
    if (error) throw new Error(`duplicados: ${error.message}`);
  }
  const total = [...deseado.values()].filter(Boolean).length;
  return { duplicados: total, cambios: [...marcar.values()].reduce((s, a) => s + a.length, 0) + desmarcar.length };
}

// ---- Oportunidades ----

async function syncOportunidades(cliente) {
  const pipelines = await ghl.listarPipelines(cliente);
  if (pipelines.length) {
    const filas = pipelines.map(p => ({
      id: p.id,
      location_id: cliente.location_id,
      nombre: p.name || p.id,
      etapas: (p.stages || [])
        .map((s, i) => ({ id: s.id, nombre: s.name, posicion: s.position ?? i }))
        .sort((a, b) => a.posicion - b.posicion),
      synced_at: new Date().toISOString(),
    }));
    const { error } = await supabase.from('ghl_pipelines').upsert(filas, { onConflict: 'id' });
    if (error) throw new Error(`ghl_pipelines: ${error.message}`);
  }

  await ghl.sleep(150);
  const opps = await ghl.listarOportunidades(cliente);
  const filas = opps.map(o => ({
    id: o.id,
    location_id: cliente.location_id,
    contact_id: o.contactId || o.contact?.id || null,
    pipeline_id: o.pipelineId || null,
    etapa_id: o.pipelineStageId || null,
    estado: o.status || null,
    valor: o.monetaryValue != null ? Number(o.monetaryValue) : null,
    nombre: o.name || null,
    fuente: o.source || null,
    creada_at: o.createdAt || null,
    actualizada_at: o.updatedAt || null,
    cambio_estado_at: o.lastStatusChangeAt || null,
    cambio_etapa_at: o.lastStageChangeAt || null,
    raw: o,
    synced_at: new Date().toISOString(),
  }));
  for (const t of trozos(filas, LOTE)) {
    const { error } = await supabase.from('oportunidades').upsert(t, { onConflict: 'id' });
    if (error) throw new Error(`oportunidades: ${error.message}`);
  }
  return { pipelines: pipelines.length, oportunidades: filas.length };
}

// ---- Velocidad de respuesta ----

// Primer saliente real (mensaje o llamada; no actividades del sistema) desde
// el alta del lead, separado en automático y humano. En leads_respuesta:
//   primera_at / primera_tipo / primera_origen → primera respuesta AUTOMÁTICA
//   primera_manual_at                          → primera respuesta HUMANA
// (la primera de cualquier tipo es la menor de las dos).
async function respuestaDeLead(cliente, lead) {
  const convs = await ghl.conversacionesContacto(cliente, lead.ghl_contact_id);
  const salientes = [];
  for (const c of convs) {
    await ghl.sleep(150);
    const msgs = await ghl.mensajesConversacion(cliente, c.id, { maxPaginas: 5 });
    const desde = new Date(lead.fecha_creacion).getTime() - 60_000;
    for (const m of msgs) {
      if (m.direction !== 'outbound' || /ACTIVITY/i.test(m.messageType || '')) continue;
      if (new Date(m.dateAdded).getTime() < desde) continue;
      salientes.push(m);
    }
  }
  salientes.sort((a, b) => a.dateAdded.localeCompare(b.dateAdded));
  const automatica = salientes.find(m => !esHumana(m));
  const humana = salientes.find(esHumana);
  return {
    ghl_contact_id: lead.ghl_contact_id,
    location_id: cliente.location_id,
    conversaciones: convs.length,
    primera_at: automatica?.dateAdded || null,
    primera_tipo: automatica?.messageType || null,
    primera_origen: automatica ? origenAutomatico(automatica) : null,
    primera_manual_at: humana?.dateAdded || null,
    revisado_at: new Date().toISOString(),
  };
}

// Revisa como mucho `max` leads: primero los que nunca se han mirado (más
// recientes antes) y luego los que aún pueden recibir respuesta (menos de 7
// días desde el alta, sin respuesta manual y revisados hace más de 1 h).
// concurrencia: leads en paralelo dentro de la subcuenta. Cada worker hace
// ~3 peticiones/s, así que 4 se quedan holgadas bajo el límite de GHL (100 /
// 10 s por location). La sync horaria usa 1; el script de histórico, 4.
async function syncRespuestas(cliente, { max = 150, concurrencia = 1, alProgreso } = {}) {
  const [leads, revisados] = await Promise.all([
    fetchAll(() => supabase.from('leads').select('ghl_contact_id, fecha_creacion')
      .eq('location_id', cliente.location_id).eq('importado', false)
      .order('fecha_creacion', { ascending: false }).order('ghl_contact_id')),
    fetchAll(() => supabase.from('leads_respuesta').select('ghl_contact_id, primera_manual_at, revisado_at')
      .eq('location_id', cliente.location_id).order('ghl_contact_id')),
  ]);
  const yaRevisado = new Map(revisados.map(r => [r.ghl_contact_id, r]));
  const ahora = Date.now();
  const nuevos = leads.filter(l => !yaRevisado.has(l.ghl_contact_id));
  const abiertos = leads.filter(l => {
    const r = yaRevisado.get(l.ghl_contact_id);
    if (!r || r.primera_manual_at) return false;
    const alta = new Date(l.fecha_creacion).getTime();
    return ahora - alta < VENTANA_RESPUESTA_MS && ahora - new Date(r.revisado_at).getTime() > RECHEQUEO_MS;
  });
  const cola = [...nuevos, ...abiertos].slice(0, max);

  const filas = [];
  let errores = 0;
  let hechos = 0;
  let siguiente = 0;
  const guardar = async () => {
    if (!filas.length) return;
    const { error } = await supabase.from('leads_respuesta').upsert(filas.splice(0), { onConflict: 'ghl_contact_id' });
    if (error) throw new Error(`leads_respuesta: ${error.message}`);
  };
  const worker = async () => {
    while (siguiente < cola.length) {
      const lead = cola[siguiente++];
      try {
        filas.push(await respuestaDeLead(cliente, lead));
      } catch (e) {
        errores += 1;
        if (errores <= 3) console.warn(`[leads] respuesta ${cliente.nombre}/${lead.ghl_contact_id}: ${e.message}`);
        if (errores > 20) throw new Error(`demasiados errores leyendo conversaciones (${e.message})`);
      }
      if (filas.length >= 50) await guardar();
      hechos += 1;
      if (alProgreso) alProgreso(hechos, cola.length);
      await ghl.sleep(150);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrencia) }, worker));
  if (filas.length) {
    const { error } = await supabase.from('leads_respuesta').upsert(filas, { onConflict: 'ghl_contact_id' });
    if (error) throw new Error(`leads_respuesta: ${error.message}`);
  }
  return { revisados: cola.length - errores, pendientes: nuevos.length + abiertos.length - cola.length, errores };
}

// Los tres extras de una subcuenta; devuelve un texto de error (o null) para el log.
async function extrasCliente(cliente) {
  const fallos = [];
  for (const [nombre, fn] of [
    ['importados', () => marcarImportados(cliente.location_id)],
    ['duplicados', () => marcarDuplicados(cliente.location_id)],
    ['oportunidades', () => syncOportunidades(cliente)],
    ['respuestas', () => syncRespuestas(cliente)],
  ]) {
    try {
      const r = await fn();
      console.log(`[leads] ${cliente.nombre} · ${nombre}: ${JSON.stringify(r)}`);
    } catch (e) {
      console.error(`[leads] ERROR ${cliente.nombre} · ${nombre}: ${e.message}`);
      fallos.push(`${nombre}: ${e.message}`);
    }
  }
  return fallos.length ? fallos.join(' | ') : null;
}

module.exports = { marcarImportados, marcarDuplicados, syncOportunidades, syncRespuestas, extrasCliente };
