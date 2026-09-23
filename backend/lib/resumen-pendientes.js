'use strict';
// Punto único para el badge del botón "Más" del nav (ver frontend/pages/
// nav-mas-shared.js): agrega en una sola llamada lo que cada pestaña ya
// calcula por separado, sin duplicar su lógica de negocio — solo cuenta.
//
// - facturas: mismo criterio de "revisar"/incompleta que seccionIncompletos
//   en resumen-analisis.js, pero sin acotar por fecha (ahí importa el
//   periodo del resumen; aquí solo si queda ALGO pendiente, sin importar
//   cuándo se subió).
// - banco: mismo campo `conciliado` que backend/lib/banco.js.
// - checklists: mismo criterio que el tablero del día (backend/api/
//   checklists.js `/checklists/tablero`: fuera_rango o foto no coincide),
//   recalculado aquí con una consulta más pequeña porque el tablero trae
//   además nombres/checklist/turno que el badge no necesita.
const { supabase } = require('./supabase');

async function contarFacturasPendientes(cliente) {
  const tabla = `${cliente}_facturas`;
  const { count, error } = await supabase
    .from(tabla).select('id', { count: 'exact', head: true })
    .or('tipo.eq.revisar,fecha_factura.is.null,numero_factura.is.null');
  if (error) throw new Error(`${tabla}: ${error.message}`);
  return count || 0;
}

async function contarBancoSinConciliar(cliente) {
  const { count, error } = await supabase
    .from('movimientos_banco').select('id', { count: 'exact', head: true })
    .eq('cliente', cliente).eq('conciliado', false);
  if (error) throw new Error(`movimientos_banco: ${error.message}`);
  return count || 0;
}

async function contarChecklistsPorRevisar(cliente) {
  const hoy = new Date().toISOString().slice(0, 10);
  const { data: ejecuciones, error: errE } = await supabase
    .from('checklist_ejecuciones').select('id').eq('cliente', cliente).eq('fecha', hoy);
  if (errE) throw new Error(`checklist_ejecuciones: ${errE.message}`);
  if (!ejecuciones.length) return 0;

  const { data: respuestas, error: errR } = await supabase
    .from('checklist_respuestas').select('fuera_rango, foto_verificacion')
    .in('ejecucion_id', ejecuciones.map(e => e.id));
  if (errR) throw new Error(`checklist_respuestas: ${errR.message}`);

  return respuestas.filter(r => r.fuera_rango || r.foto_verificacion?.coincide === false).length;
}

async function calcularPendientes(cliente) {
  const [facturas, banco, checklists] = await Promise.all([
    contarFacturasPendientes(cliente),
    contarBancoSinConciliar(cliente),
    contarChecklistsPorRevisar(cliente),
  ]);
  return {
    facturas_pendientes: facturas,
    banco_sin_conciliar: banco,
    checklists_por_revisar: checklists,
    hay_pendientes: (facturas + banco + checklists) > 0,
  };
}

module.exports = { calcularPendientes };
