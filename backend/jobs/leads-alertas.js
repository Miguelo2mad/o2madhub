// Alerta por email: lead de Meta que lleva 30 min sin ningún mensaje saliente
// (ni workflow, ni Gulliver, ni humano). Cron cada 5 min (index.js).
// No depende de la sync horaria: busca en GHL las altas de las subcuentas en
// captación entre hace 3 h y hace 30 min, y para cada lead de Meta mira sus
// conversaciones (mismo criterio que la velocidad de respuesta,
// leads-extras.js → respuestaDeLead). Cada lead se avisa una sola vez
// (leads_alertas). Destino: LEADS_ALERT_TO (por defecto info@o2mad.com).
const { supabase } = require('../lib/supabase');
const ghl = require('../lib/ghl');
const { respuestaDeLead } = require('./leads-extras');
const { enviarEmail } = require('../api/notifications');

const TIPO = 'sin_saliente_30min';
const MIN_MS = 30 * 60_000;
const MAX_MS = 3 * 3600_000;          // más antiguo ya no es una alerta útil
const RAFAGA = 30;                    // ≥30 altas en la ventana = importación, no leads
const DESTINO = () => process.env.LEADS_ALERT_TO || 'info@o2mad.com';

let enCurso = false;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function leadsMetaRecientes(cliente, ahora) {
  const data = await ghl.buscarContactos(cliente, {
    gte: new Date(ahora - MAX_MS).toISOString(),
    lte: new Date(ahora - MIN_MS).toISOString(),
    pageLimit: 100,
  });
  const contactos = (data.contacts || []).filter(c => c.id && c.dateAdded);
  if (contactos.length >= RAFAGA) {
    console.warn(`[leads-alertas] ${cliente.nombre}: ${contactos.length} altas en la ventana (importación), se omite`);
    return [];
  }
  return contactos.map(c => ghl.contactoALead(c, cliente.location_id)).filter(l => l.canal === 'meta');
}

async function revisarAlertas() {
  if (enCurso) return { omitida: 'en curso' };
  enCurso = true;
  try {
    // Migración 056 aún sin aplicar: no hay dónde recordar los avisos, no se envía nada.
    const { error: tErr } = await supabase.from('leads_alertas').select('tipo').limit(1);
    if (tErr && ['42P01', 'PGRST205'].includes(tErr.code)) return { omitida: 'migración 056 pendiente' };
    const { data: clientes, error } = await supabase.from('clientes_ghl')
      .select('location_id, nombre, token_privado').eq('activo', true).not('token_privado', 'is', null);
    if (error) throw new Error(error.message);
    const ahora = Date.now();
    const avisos = [];
    for (const cliente of clientes) {
      try {
        const leads = await leadsMetaRecientes(cliente, ahora);
        if (!leads.length) continue;
        const { data: ya, error: aErr } = await supabase.from('leads_alertas')
          .select('ghl_contact_id').eq('tipo', TIPO).in('ghl_contact_id', leads.map(l => l.ghl_contact_id));
        if (aErr) throw new Error(aErr.message);
        const avisados = new Set(ya.map(a => a.ghl_contact_id));
        for (const lead of leads.filter(l => !avisados.has(l.ghl_contact_id))) {
          const r = await respuestaDeLead(cliente, lead);
          if (r.primera_at || r.primera_manual_at) continue;
          avisos.push({ cliente, lead, minutos: Math.round((ahora - new Date(lead.fecha_creacion).getTime()) / 60000) });
          await ghl.sleep(200);
        }
      } catch (e) {
        console.error(`[leads-alertas] ${cliente.nombre}:`, e.message);
      }
    }
    if (!avisos.length) return { avisos: 0 };

    const filas = avisos.map(({ cliente, lead, minutos }) => `<tr>
      <td>${esc(cliente.nombre)}</td><td>${esc(lead.nombre || '—')}</td><td>${esc(lead.telefono || 'sin teléfono')}</td>
      <td>${minutos} min</td>
      <td><a href="https://app.gohighlevel.com/v2/location/${encodeURIComponent(cliente.location_id)}/contacts/detail/${encodeURIComponent(lead.ghl_contact_id)}">Abrir en GHL</a></td></tr>`).join('');
    await enviarEmail({
      to: DESTINO(),
      subject: `Leads de Meta sin respuesta: ${avisos.length}`,
      html: `<p>${avisos.length === 1 ? 'Este lead de Meta lleva' : 'Estos leads de Meta llevan'} más de 30 minutos sin ningún mensaje saliente (ni workflow, ni IA, ni del equipo).</p>
        <table border="1" cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:13px;">
        <tr><th>Cliente</th><th>Lead</th><th>Teléfono</th><th>Desde el alta</th><th></th></tr>${filas}</table>
        <p style="color:#888;font-size:12px;">O2MAD Hub · módulo Leads. Cada lead se avisa una sola vez.</p>`,
    });
    const { error: insErr } = await supabase.from('leads_alertas').upsert(
      avisos.map(({ cliente, lead }) => ({ location_id: cliente.location_id, ghl_contact_id: lead.ghl_contact_id, tipo: TIPO })),
      { onConflict: 'ghl_contact_id,tipo', ignoreDuplicates: true });
    if (insErr) console.error('[leads-alertas] guardando alertas:', insErr.message);
    console.log(`[leads-alertas] email enviado: ${avisos.length} leads sin saliente`);
    return { avisos: avisos.length };
  } finally {
    enCurso = false;
  }
}

module.exports = { revisarAlertas };
