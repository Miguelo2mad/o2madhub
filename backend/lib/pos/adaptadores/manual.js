// Adaptador de referencia: los clientes con adaptador "manual" no tienen
// integración de API, sus ventas se cargan por foto (ver backend/lib/ventas.js).
// clientes_pos.activo debería ser false para ellos; este adaptador existe
// para que la interfaz común tenga una implementación de verdad y el cron
// no reviente si por error queda activada una fila con adaptador "manual".
async function obtenerVentas(fecha, credenciales) {
  throw new Error('El adaptador "manual" no tiene integración de API; las ventas se cargan por foto.');
}

module.exports = { obtenerVentas };
