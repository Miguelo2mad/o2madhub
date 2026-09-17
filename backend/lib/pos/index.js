// Interfaz común de adaptadores de TPV. Un adaptador implementa
// obtenerVentas(fecha, credenciales) y devuelve el MISMO shape que la
// extracción por foto (ver VENTA_SCHEMA en backend/lib/ventas.js):
// { fecha, total_bruto, total_neto, num_tickets, desglose_pago,
//   detalle_por_articulo, lineas, dudas }
// para que guardarVentaDiaria() no tenga que saber de dónde vino el dato.
// Empieza solo con la interfaz + el adaptador "manual" de referencia; el
// primer adaptador real se añade cuando se sepa el TPV de Timbol.
const ADAPTADORES = {
  manual: require('./adaptadores/manual'),
};

function getAdaptador(nombre) {
  const a = ADAPTADORES[nombre];
  if (!a) throw new Error(`Adaptador de TPV desconocido: "${nombre}"`);
  return a;
}

module.exports = { getAdaptador, ADAPTADORES };
