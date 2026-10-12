'use strict';
// Completa el histórico de velocidad de respuesta (tabla leads_respuesta):
// la sync horaria solo revisa 150 leads por subcuenta y ejecución, y el
// primer relleno de una subcuenta con miles de leads tarda. ~2-3 llamadas a
// GHL por lead con 150 ms de pausa (dentro del rate limit de 100 / 10 s).
//
//   node backend/scripts/leads-respuestas.js                    → subcuentas en captación con token
//   node backend/scripts/leads-respuestas.js --location=<id> --max=20000 --concurrencia=4
//
// En Railway:  railway run node backend/scripts/leads-respuestas.js
const { supabase } = require('../lib/supabase');
const { syncRespuestas } = require('../jobs/leads-extras');

const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];

(async () => {
  let q = supabase.from('clientes_ghl').select('location_id, nombre, token_privado')
    .eq('activo', true).not('token_privado', 'is', null).order('nombre');
  if (arg('location')) q = q.eq('location_id', arg('location'));
  const { data: clientes, error } = await q;
  if (error) throw new Error(error.message);
  const max = Number(arg('max')) || 20000;
  for (const c of clientes) {
    const t0 = Date.now();
    const r = await syncRespuestas(c, {
      max,
      concurrencia: Number(arg('concurrencia')) || 4,
      alProgreso: (i, n) => { if (i % 250 === 0) console.log(`  ${c.nombre}: ${i}/${n}`); },
    });
    console.log(`${c.nombre}: ${JSON.stringify(r)} en ${Math.round((Date.now() - t0) / 1000)} s`);
  }
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
