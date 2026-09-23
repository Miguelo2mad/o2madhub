'use strict';
// Generación diaria de ejecuciones de checklist — cron a las 05:00 Madrid
// (ver index.js). Recorre los clientes con algún local activo; idempotente
// por el unique(checklist_id, fecha) de la migración 047, así que también
// se puede llamar bajo demanda (backend/lib/checklists.js lo hace en cada
// GET de tareas del empleado) sin duplicar nada.
const { supabase } = require('../lib/supabase');
const { generarEjecucionesDelDia } = require('../lib/checklists');

async function runChecklistsGeneracion() {
  const { data: locales, error } = await supabase.from('locales').select('cliente').eq('activo', true);
  if (error) throw new Error(`locales: ${error.message}`);

  const clientes = [...new Set(locales.map(l => l.cliente))];
  const resultado = {};
  for (const cliente of clientes) {
    try {
      const { creadas } = await generarEjecucionesDelDia(cliente);
      resultado[cliente] = creadas;
    } catch (e) {
      console.error(`[checklists-generacion] ${cliente}:`, e.message);
      resultado[cliente] = `error: ${e.message}`;
    }
  }
  console.log('[checklists-generacion]', resultado);
  return resultado;
}

module.exports = { runChecklistsGeneracion };
