'use strict';
// Recalcula canal, UTMs, campaign_id y ad_id de TODOS los leads a partir de su
// raw (el contacto de GHL tal cual), con la lógica actual de
// contactoALead() en backend/lib/ghl.js. Hay que pasarlo cada vez que cambie
// la derivación de canal; la sync solo reclasifica lo que vuelve a descargar.
//
//   node backend/scripts/leads-reclasificar.js           → DRY RUN: muestra el
//                                                           antes → después, no guarda nada.
//   node backend/scripts/leads-reclasificar.js --apply   → guarda los cambios.
//
// En Railway (env vars reales de Supabase):
//   railway run node backend/scripts/leads-reclasificar.js --apply
const { supabase } = require('../lib/supabase');
const { contactoALead } = require('../lib/ghl');

const APPLY = process.argv.includes('--apply');
const CAMPOS = ['canal', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'campaign_id', 'ad_id'];
const LOTE = 500;

async function main() {
  const transiciones = {};
  let revisados = 0;
  let cambiados = 0;

  for (let from = 0; ; from += LOTE) {
    const { data, error } = await supabase
      .from('leads')
      .select(`ghl_contact_id, location_id, fecha_creacion, raw, synced_at, ${CAMPOS.join(', ')}`)
      .order('ghl_contact_id')
      .range(from, from + LOTE - 1);
    if (error) throw new Error(error.message);

    const cambios = [];
    for (const l of data) {
      const nuevo = contactoALead(l.raw, l.location_id);
      const k = `${l.canal} → ${nuevo.canal}`;
      transiciones[k] = (transiciones[k] || 0) + 1;
      if (CAMPOS.some(c => (l[c] ?? null) !== (nuevo[c] ?? null))) {
        // Fila completa (upsert exige las columnas NOT NULL); synced_at se conserva.
        cambios.push({ ...nuevo, fecha_creacion: l.fecha_creacion, synced_at: l.synced_at });
      }
    }
    revisados += data.length;
    cambiados += cambios.length;

    if (APPLY && cambios.length) {
      const { error: upErr } = await supabase.from('leads').upsert(cambios, { onConflict: 'ghl_contact_id' });
      if (upErr) throw new Error(`upsert: ${upErr.message}`);
    }
    if (data.length < LOTE) break;
  }

  console.log(`${revisados} leads revisados, ${cambiados} con cambios${APPLY ? ' (guardados)' : ' (DRY RUN, nada guardado)'}`);
  console.log('Canal antes → después:');
  Object.entries(transiciones).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${String(n).padStart(6)}  ${k}`));
}

main().catch(e => { console.error('ERROR', e.message); process.exit(1); });
