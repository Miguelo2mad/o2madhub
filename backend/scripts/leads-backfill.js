'use strict';
// Re-descarga de GHL los contactos de las subcuentas en captación desde una
// fecha (por defecto, el 1-ene-2024, igual que el primer sync) en ventanas de
// 30 días, con el mismo rate limit que la sync horaria. Idempotente: hace
// upsert por ghl_contact_id. Al terminar imprime los leads por año.
//
//   node backend/scripts/leads-backfill.js                         → todas las subcuentas en captación
//   node backend/scripts/leads-backfill.js --desde=2024-01-01 --location=<id>
//
// En Railway (env vars reales):  railway run node backend/scripts/leads-backfill.js
const { supabase } = require('../lib/supabase');
const { syncLeads } = require('../jobs/leads-sync');

const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];

async function leadsPorAnio() {
  const { data: clientes } = await supabase.from('clientes_ghl').select('location_id, nombre').eq('activo', true).order('nombre');
  for (const c of clientes) {
    const anios = {};
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('leads').select('fecha_creacion')
        .eq('location_id', c.location_id).order('ghl_contact_id').range(from, from + 999);
      if (error) throw new Error(error.message);
      // Año en Europe/Madrid (el 31-dic a las 23:30 UTC ya es 1-ene en Madrid).
      data.forEach(l => {
        const y = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric' }).format(new Date(l.fecha_creacion));
        anios[y] = (anios[y] || 0) + 1;
      });
      if (data.length < 1000) break;
    }
    const total = Object.values(anios).reduce((a, b) => a + b, 0);
    console.log(`  ${c.nombre}: ${Object.keys(anios).sort().map(y => `${y}=${anios[y]}`).join(' · ')} (total ${total})`);
  }
}

(async () => {
  const desde = new Date(`${arg('desde') || '2024-01-01'}T00:00:00.000Z`).toISOString();
  console.log(`Backfill desde ${desde}${arg('location') ? ` (solo ${arg('location')})` : ''}…`);
  const r = await syncLeads({ locationId: arg('location'), desde });
  r.clientes.forEach(c => console.log(`  ${c.nombre}: ${c.sin_token ? 'sin token' : `${c.leads_nuevos} nuevos, ${c.leads_actualizados} actualizados${c.error ? ` — ERROR ${c.error}` : ''}`}`));
  console.log(`\nLeads por año (Madrid):`);
  await leadsPorAnio();
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
