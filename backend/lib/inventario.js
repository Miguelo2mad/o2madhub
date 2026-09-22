'use strict';
// Inventario estimado (Fase 2 del escandallo, ver database/migrations/042 y
// 045): para cada ingrediente con escandallo o con compras registradas,
//   stock = cantidad_inicial
//           + compras del ingrediente desde fecha_inicial
//           - (unidades vendidas de cada plato × cantidad en escandallo)
// Sin red (salvo supabase) y sin estado — mismo estilo que resumen-analisis.js:
// consultas en dos pasos (sin joins embebidos de PostgREST) para que sea
// fácil de mockear y testear.
const { supabase } = require('./supabase');
const { normalizarTextoProducto, normalizarUnidad, convertirUnidad } = require('./tarifas');

function hoyIso() {
  return new Date().toISOString().slice(0, 10);
}

function offsetDias(iso, dias) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// Unidad más frecuente de una lista de unidades ya normalizadas (ignora
// null/undefined) — desempate por orden de aparición.
function unidadMasFrecuente(unidades) {
  const conteo = new Map();
  for (const u of unidades) {
    if (!u) continue;
    conteo.set(u, (conteo.get(u) || 0) + 1);
  }
  let mejor = null, mejorCount = 0;
  for (const [u, c] of conteo) {
    if (c > mejorCount) { mejor = u; mejorCount = c; }
  }
  return mejor;
}

// ── Carga de datos ───────────────────────────────────────────────────────
async function cargarDatos(cliente) {
  const tablaFacturas = `${cliente}_facturas`;
  const tablaLineas = `${cliente}_factura_lineas`;

  const { data: platos, error: errP } = await supabase
    .from('platos').select('id, nombre, nombre_norm').eq('cliente', cliente);
  if (errP) throw new Error(`platos: ${errP.message}`);

  const platoIds = platos.map(p => p.id);
  let escandallo = [];
  if (platoIds.length) {
    const { data, error: errE } = await supabase
      .from('escandallo').select('plato_id, ingrediente, ingrediente_norm, cantidad, unidad')
      .in('plato_id', platoIds);
    if (errE) throw new Error(`escandallo: ${errE.message}`);
    escandallo = data;
  }

  const { data: aliases, error: errA } = await supabase
    .from('plato_alias').select('texto_tpv_norm, plato_id').eq('cliente', cliente);
  if (errA) throw new Error(`plato_alias: ${errA.message}`);

  const { data: ventasDiarias, error: errV } = await supabase
    .from('ventas_diarias').select('id, fecha').eq('cliente', cliente);
  if (errV) throw new Error(`ventas_diarias: ${errV.message}`);

  const { data: ventasLineas, error: errVL } = await supabase
    .from('ventas_lineas').select('venta_id, producto_norm, cantidad').eq('cliente', cliente);
  if (errVL) throw new Error(`ventas_lineas: ${errVL.message}`);

  const { data: facturas, error: errF } = await supabase
    .from(tablaFacturas).select('id, fecha_factura')
    .in('tipo', ['factura', 'ticket']);
  if (errF) throw new Error(`${tablaFacturas}: ${errF.message}`);

  const facturaIds = facturas.map(f => f.id);
  let facturaLineas = [];
  if (facturaIds.length) {
    const { data, error: errFL } = await supabase
      .from(tablaLineas).select('factura_id, producto, cantidad, unidad')
      .in('factura_id', facturaIds)
      .not('producto', 'is', null);
    if (errFL) throw new Error(`${tablaLineas}: ${errFL.message}`);
    facturaLineas = data;
  }

  const { data: stockGuardado, error: errS } = await supabase
    .from('inventario_stock').select('*').eq('cliente', cliente);
  if (errS) throw new Error(`inventario_stock: ${errS.message}`);

  return { platos, escandallo, aliases, ventasDiarias, ventasLineas, facturas, facturaLineas, stockGuardado };
}

// ── Cálculo ──────────────────────────────────────────────────────────────
// Toda la parte de aquí abajo es pura (recibe los datos ya cargados) para
// poder testearla sin mockear supabase en cada caso.
function calcular({ platos, escandallo, aliases, ventasDiarias, ventasLineas, facturas, facturaLineas, stockGuardado }) {
  const hoy = hoyIso();
  const desde7d = offsetDias(hoy, -6);
  const desde30d = offsetDias(hoy, -29);

  const nombrePorPlato = new Map(platos.map(p => [p.id, p.nombre]));
  const platoIdPorNombreNorm = new Map(platos.map(p => [p.nombre_norm, p.id]));
  const platoIdPorAlias = new Map(aliases.map(a => [a.texto_tpv_norm, a.plato_id]));

  const escandalloPorPlato = new Map(); // plato_id -> [{ingrediente_norm, ingrediente, cantidad, unidad}]
  for (const e of escandallo) {
    const unidad = normalizarUnidad(e.unidad);
    if (!escandalloPorPlato.has(e.plato_id)) escandalloPorPlato.set(e.plato_id, []);
    escandalloPorPlato.get(e.plato_id).push({ ...e, unidad });
  }

  const fechaPorVenta = new Map(ventasDiarias.map(v => [v.id, v.fecha]));
  const fechaPorFactura = new Map(facturas.map(f => [f.id, f.fecha_factura]));

  // Estado acumulado por ingrediente, construido incrementalmente a partir
  // de escandallo + compras + inventario_stock — luego se completa con las
  // series (fecha, cantidad, unidad) para compras y consumo.
  const ingredientes = new Map(); // ingrediente_norm -> { ingrediente, unidadesVistas: [], platos: Set, tieneEscandallo, compras: [], consumo: [] }

  function obtenerIngrediente(ingredienteNorm, nombreDisplay) {
    if (!ingredientes.has(ingredienteNorm)) {
      ingredientes.set(ingredienteNorm, {
        ingrediente: nombreDisplay,
        unidadesEscandallo: [],
        unidadesCompra: [],
        platos: new Set(),
        tieneEscandallo: false,
        compras: [],  // { fecha, cantidad, unidad }
        consumo: [],  // { fecha, cantidad, unidad }
      });
    }
    const ing = ingredientes.get(ingredienteNorm);
    // El nombre "bonito" se sobreescribe con lo último que llega; como
    // escandallo se procesa antes que compras (ver más abajo), un ingrediente
    // con receta muestra el nombre del escandallo aunque también se compre.
    if (nombreDisplay) ing.ingrediente = nombreDisplay;
    return ing;
  }

  // 1. Ingredientes con escandallo.
  for (const [platoId, lineas] of escandalloPorPlato) {
    for (const l of lineas) {
      const ing = obtenerIngrediente(l.ingrediente_norm, l.ingrediente);
      ing.tieneEscandallo = true;
      ing.unidadesEscandallo.push(l.unidad);
      ing.platos.add(nombrePorPlato.get(platoId));
    }
  }

  // 2. Consumo teórico: cada línea de venta se resuelve a un plato (alias
  // primero, si no hay, nombre_norm directo) y se reparte entre sus
  // ingredientes según el escandallo. Ventas sin plato reconocido se
  // ignoran a propósito — no hay receta con la que repartirlas.
  for (const vl of ventasLineas) {
    const fecha = fechaPorVenta.get(vl.venta_id);
    if (!fecha || !vl.producto_norm) continue;
    const platoId = platoIdPorAlias.get(vl.producto_norm) ?? platoIdPorNombreNorm.get(vl.producto_norm);
    if (platoId == null) continue;
    const lineasEscandallo = escandalloPorPlato.get(platoId);
    if (!lineasEscandallo) continue;

    const unidadesVendidas = Number(vl.cantidad) || 0;
    for (const l of lineasEscandallo) {
      const ing = obtenerIngrediente(l.ingrediente_norm, l.ingrediente);
      ing.consumo.push({ fecha, cantidad: unidadesVendidas * Number(l.cantidad), unidad: l.unidad });
    }
  }

  // 3. Compras: agrupadas por producto normalizado de la línea de factura.
  for (const fl of facturaLineas) {
    const fecha = fechaPorFactura.get(fl.factura_id);
    if (!fecha) continue;
    const ingredienteNorm = normalizarTextoProducto(fl.producto);
    if (!ingredienteNorm) continue;
    const unidad = normalizarUnidad(fl.unidad);
    const ing = obtenerIngrediente(ingredienteNorm, ingredientes.has(ingredienteNorm) ? null : fl.producto);
    ing.unidadesCompra.push(unidad);
    ing.compras.push({ fecha, cantidad: Number(fl.cantidad) || 0, unidad });
  }

  // 4. Ingredientes ya ajustados a mano aunque de momento no tengan ni
  // escandallo ni compras — no deben "desaparecer" del listado.
  const stockPorIngrediente = new Map(stockGuardado.map(s => [s.ingrediente_norm, s]));
  for (const s of stockGuardado) {
    if (!ingredientes.has(s.ingrediente_norm)) obtenerIngrediente(s.ingrediente_norm, s.ingrediente_norm);
  }

  // 5. Resolución final por ingrediente: unidad de referencia, conversión,
  // stock estimado y consumo de los últimos 7/30 días.
  const resultado = [];
  for (const [ingredienteNorm, ing] of ingredientes) {
    const guardado = stockPorIngrediente.get(ingredienteNorm);
    const unidad = guardado?.unidad
      || unidadMasFrecuente(ing.unidadesEscandallo)
      || unidadMasFrecuente(ing.unidadesCompra)
      || 'ud';

    const cantidadInicial = Number(guardado?.cantidad_inicial) || 0;
    const fechaInicial = guardado?.fecha_inicial || primeraFecha([...ing.compras, ...ing.consumo]) || hoy;

    let unidadConflicto = false;
    const sumarConvertido = (items, filtroFecha) => {
      let total = 0;
      for (const item of items) {
        if (filtroFecha && item.fecha < filtroFecha) continue;
        const convertido = convertirUnidad(item.cantidad, item.unidad, unidad);
        if (convertido == null) { unidadConflicto = true; continue; }
        total += convertido;
      }
      return total;
    };

    const compras = sumarConvertido(ing.compras, fechaInicial);
    const consumoTotal = sumarConvertido(ing.consumo, fechaInicial);
    const consumo7d = sumarConvertido(ing.consumo, desde7d);
    const consumo30d = sumarConvertido(ing.consumo, desde30d);

    resultado.push({
      ingrediente: ing.ingrediente,
      ingrediente_norm: ingredienteNorm,
      unidad,
      cantidad_inicial: cantidadInicial,
      fecha_inicial: fechaInicial,
      compras: Number(compras.toFixed(4)),
      consumo_teorico: Number(consumoTotal.toFixed(4)),
      stock_estimado: Number((cantidadInicial + compras - consumoTotal).toFixed(4)),
      consumo_7d: Number(consumo7d.toFixed(4)),
      consumo_30d: Number(consumo30d.toFixed(4)),
      tiene_escandallo: ing.tieneEscandallo,
      unidad_conflicto: unidadConflicto,
      platos: [...ing.platos].filter(Boolean).sort(),
    });
  }

  resultado.sort((a, b) => a.ingrediente.localeCompare(b.ingrediente, 'es'));
  return resultado;
}

function primeraFecha(items) {
  const fechas = items.map(i => i.fecha).filter(Boolean).sort();
  return fechas[0] || null;
}

// ── API pública ──────────────────────────────────────────────────────────
async function calcularInventario(cliente) {
  const datos = await cargarDatos(cliente);
  return { cliente, ingredientes: calcular(datos) };
}

// Upsert manual: "el día que Roman cuenta algo a mano". fecha_inicial por
// defecto hoy — resetea el punto de partida desde ese día sin tocar el
// histórico de compras/ventas anteriores.
async function ajustarStock(cliente, { ingrediente, unidad, cantidad_inicial, fecha_inicial }) {
  if (!ingrediente || typeof ingrediente !== 'string' || !ingrediente.trim()) {
    throw new Error('Falta el nombre del ingrediente');
  }
  const unidadNorm = normalizarUnidad(unidad);
  if (!unidadNorm) throw new Error('Falta la unidad');
  const cantidad = Number(cantidad_inicial);
  if (!Number.isFinite(cantidad)) throw new Error('cantidad_inicial debe ser un número');

  const ingredienteNorm = normalizarTextoProducto(ingrediente);
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(fecha_inicial || '') ? fecha_inicial : hoyIso();

  const { error } = await supabase
    .from('inventario_stock')
    .upsert(
      { cliente, ingrediente_norm: ingredienteNorm, unidad: unidadNorm, cantidad_inicial: cantidad, fecha_inicial: fecha, updated_at: new Date().toISOString() },
      { onConflict: 'cliente,ingrediente_norm' }
    );
  if (error) throw new Error(`Supabase (ajustar stock): ${error.message}`);

  const inventario = await calcularInventario(cliente);
  return inventario.ingredientes.find(i => i.ingrediente_norm === ingredienteNorm) || null;
}

module.exports = { calcularInventario, ajustarStock };
