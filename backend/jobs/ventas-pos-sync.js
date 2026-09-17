'use strict';
// Sincronización diaria de ventas desde el TPV, para los clientes con un
// adaptador de API configurado y activo en clientes_pos. Si no hay ninguno
// activo (todos los clientes cargan por foto, que es la situación de hoy),
// no hace nada y no loguea nada — nada de ruido cada noche sin TPVs.
const { supabase } = require('../lib/supabase');
const { getAdaptador } = require('../lib/pos');
const { descifrarCredenciales } = require('../lib/pos/crypto');
const { guardarVentaDiaria } = require('../lib/ventas');

function ayerISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function runVentasPosSync() {
  const { data: clientes, error } = await supabase
    .from('clientes_pos').select('*').eq('activo', true).neq('adaptador', 'manual');
  if (error) { console.error('[ventas-pos-sync] no se pudo leer clientes_pos:', error.message); return; }
  if (!clientes.length) return;

  const fecha = ayerISO();
  console.log(`[ventas-pos-sync] sincronizando ${clientes.length} cliente(s) para ${fecha}`);

  for (const cp of clientes) {
    try {
      if (!cp.credenciales_cifradas) throw new Error('Sin credenciales configuradas');
      const credenciales = descifrarCredenciales(cp.credenciales_cifradas);
      const adaptador = getAdaptador(cp.adaptador);
      const venta = await adaptador.obtenerVentas(fecha, credenciales);
      await guardarVentaDiaria(cp.cliente, { ...venta, fecha: venta.fecha || fecha, origen: 'api', origen_ref: cp.adaptador });
      await supabase.from('clientes_pos')
        .update({ ultimo_sync_at: new Date().toISOString(), ultimo_sync_error: null }).eq('id', cp.id);
      console.log(`[ventas-pos-sync] ✓ ${cp.cliente} (${cp.adaptador}) — ${fecha}`);
    } catch (e) {
      console.error(`[ventas-pos-sync] ✗ ${cp.cliente} (${cp.adaptador}): ${e.message}`);
      try {
        await supabase.from('clientes_pos')
          .update({ ultimo_sync_at: new Date().toISOString(), ultimo_sync_error: e.message }).eq('id', cp.id);
      } catch (e2) {
        console.error(`[ventas-pos-sync] no se pudo registrar el error de sync de ${cp.cliente}:`, e2.message);
      }
    }
  }
}

module.exports = { runVentasPosSync };
