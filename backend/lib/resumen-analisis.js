'use strict';
// Resumen de análisis para un cliente y un rango de fechas: la misma lógica
// que usan backend/scripts/resumen-analisis.js (texto plano) y
// POST /analytics/preguntar (contexto en JSON para Claude) — un único sitio
// para que "food cost" o "incompletos" no signifiquen dos cosas distintas
// según quién pregunte.
const { supabase } = require('./supabase');
const { normalizarTextoProducto } = require('./tarifas');
const { calcularFoodcost } = require('./ventas');
const { extraerJson } = require('./claude-json');
const gastosPersonalLib = require('./gastos-personal');

// ── Fechas ───────────────────────────────────────────────────────────────
function generarFechas(desde, hasta) {
  const fechas = [];
  const cursor = new Date(`${desde}T00:00:00Z`);
  const fin = new Date(`${hasta}T00:00:00Z`);
  while (cursor <= fin) {
    fechas.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return fechas;
}

function offsetDias(iso, dias) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function fechaValida(f) {
  return typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f);
}

// Último recurso si el caller no da desde/hasta: últimos 30 días, igual que
// el default que tenía el script antes de este refactor.
function rangoPorDefecto(desde, hasta) {
  const hastaIso = fechaValida(hasta) ? hasta : new Date().toISOString().slice(0, 10);
  const desdeIso = fechaValida(desde) ? desde : offsetDias(hastaIso, -29);
  return { desde: desdeIso, hasta: hastaIso };
}

// Traduce el periodo elegido en un chip/selector a desde/hasta concretos.
// 'personalizado' exige desdeQuery/hastaQuery; cualquier otro valor
// (incluido uno desconocido) cae a los últimos 30 días.
function resolverPeriodo(periodo, desdeQuery, hastaQuery) {
  const hoyIso = new Date().toISOString().slice(0, 10);
  switch (periodo) {
    case 'semana':
      return { desde: offsetDias(hoyIso, -6), hasta: hoyIso };
    case 'mes':
      return { desde: `${hoyIso.slice(0, 7)}-01`, hasta: hoyIso };
    case 'personalizado':
      if (!fechaValida(desdeQuery) || !fechaValida(hastaQuery)) {
        throw new Error('El periodo personalizado requiere desde y hasta en formato YYYY-MM-DD');
      }
      return { desde: desdeQuery, hasta: hastaQuery };
    case '30d':
    default:
      return { desde: offsetDias(hoyIso, -29), hasta: hoyIso };
  }
}

// Periodo inmediatamente anterior, de la misma duración (en días) que
// [desde, hasta] — para comparar "esta semana" con "la semana anterior",
// nunca con un día suelto.
function periodoAnterior(desde, hasta) {
  const duracion = generarFechas(desde, hasta).length;
  return { desde: offsetDias(desde, -duracion), hasta: offsetDias(desde, -1) };
}

// ── 1. Ventas ────────────────────────────────────────────────────────────
async function seccionVentas(cliente, fechas) {
  const { data, error } = await supabase
    .from('ventas_diarias')
    .select('fecha, total_neto, num_tickets, detalle_por_articulo')
    .eq('cliente', cliente)
    .gte('fecha', fechas[0]).lte('fecha', fechas[fechas.length - 1]);
  if (error) throw new Error(`ventas_diarias: ${error.message}`);

  const porFecha = new Map(data.map(v => [v.fecha, v]));
  const dias = fechas.map(f => {
    const v = porFecha.get(f);
    return {
      fecha: f,
      total_neto: v ? Number(v.total_neto) || 0 : null,
      num_tickets: v ? (v.num_tickets ?? null) : null,
      detalle_por_articulo: v ? v.detalle_por_articulo !== false : null,
    };
  });

  return {
    publico: {
      dias,
      total_periodo: data.reduce((s, v) => s + (Number(v.total_neto) || 0), 0),
      dias_sin_cierre: fechas.length - data.length,
    },
    porFechaNum: new Map(data.map(v => [v.fecha, Number(v.total_neto) || 0])),
  };
}

// ── 2. Compras ───────────────────────────────────────────────────────────
async function seccionCompras(cliente, fechas) {
  const tabla = `${cliente}_facturas`;
  const { data, error } = await supabase
    .from(tabla)
    .select('fecha_factura, importe_total, proveedor')
    .in('tipo', ['factura', 'ticket'])
    .gte('fecha_factura', fechas[0]).lte('fecha_factura', fechas[fechas.length - 1]);
  if (error) throw new Error(`${tabla}: ${error.message}`);

  const porFechaNum = new Map();
  for (const f of data) porFechaNum.set(f.fecha_factura, (porFechaNum.get(f.fecha_factura) || 0) + (Number(f.importe_total) || 0));

  const totalPeriodo = data.reduce((s, f) => s + (Number(f.importe_total) || 0), 0);

  const porProveedorAcc = new Map();
  for (const f of data) {
    const key = f.proveedor || '(sin proveedor)';
    if (!porProveedorAcc.has(key)) porProveedorAcc.set(key, { total: 0, count: 0 });
    const p = porProveedorAcc.get(key);
    p.total += Number(f.importe_total) || 0;
    p.count += 1;
  }
  const porProveedor = [...porProveedorAcc.entries()]
    .map(([proveedor, v]) => ({
      proveedor, total: v.total, num_facturas: v.count,
      pct: totalPeriodo > 0 ? Number(((v.total / totalPeriodo) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    publico: {
      dias: fechas.map(f => ({ fecha: f, total: porFechaNum.get(f) || 0 })),
      total_periodo: totalPeriodo,
      por_proveedor: porProveedor,
    },
    porFechaNum,
  };
}

// ── Personal ─────────────────────────────────────────────────────────────
// Reutiliza calcularCosteMes() de backend/lib/gastos-personal.js (nóminas +
// SS + coste de horas extra), un mes calendario completo a la vez. El rango
// de fechas del resumen puede no coincidir con un mes exacto (semana, 30d,
// personalizado...), así que se suman TODOS los meses que el rango toca —
// de ahí que el resultado se marque como aproximación de gestión, nunca
// como cifra contable.
async function seccionPersonal(cliente, fechas) {
  const meses = [...new Set(fechas.map(f => f.slice(0, 7)))];
  const porMes = await Promise.all(meses.map(mes => gastosPersonalLib.calcularCosteMes(cliente, mes)));
  return {
    meses: porMes.map(m => ({
      mes: m.mes, nominas: m.nominas.total, seguridad_social: m.seguridad_social.total,
      horas_extra: m.horas_extra.total, total: m.total,
    })),
    total_periodo: porMes.reduce((s, m) => s + m.total, 0),
  };
}

// ── 3. Food cost ─────────────────────────────────────────────────────────
// Reutiliza calcularFoodcost() de backend/lib/ventas.js — misma aritmética
// que /analytics/foodcost en la app, para no tener dos criterios distintos.
function seccionFoodcost(fechas, comprasPorFecha, ventasPorFecha) {
  const resultado = calcularFoodcost(comprasPorFecha, ventasPorFecha, fechas);

  const semanas = [];
  for (let i = 0; i < fechas.length; i += 7) {
    const bloque = fechas.slice(i, i + 7);
    const comprasSemana = bloque.reduce((s, f) => s + (comprasPorFecha.get(f) || 0), 0);
    const ventasSemana = bloque.reduce((s, f) => s + (ventasPorFecha.get(f) || 0), 0);
    semanas.push({
      desde: bloque[0],
      hasta: bloque[bloque.length - 1],
      compras: comprasSemana,
      ventas_neto: ventasSemana,
      foodcost_pct: ventasSemana > 0 ? Number(((comprasSemana / ventasSemana) * 100).toFixed(2)) : null,
    });
  }

  return { periodo: resultado.acumulado, semanas };
}

// ── 4. Top 20 productos por gasto ────────────────────────────────────────
// Agrupado por (producto normalizado, proveedor) — el mismo producto
// comprado a dos proveedores distintos da dos filas, para que "proveedor"
// signifique algo concreto en cada una.
async function seccionProductosCompra(cliente, fechas) {
  const tablaFacturas = `${cliente}_facturas`;
  const tablaLineas = `${cliente}_factura_lineas`;

  const { data: facturas, error: errF } = await supabase
    .from(tablaFacturas).select('id, proveedor')
    .in('tipo', ['factura', 'ticket'])
    .gte('fecha_factura', fechas[0]).lte('fecha_factura', fechas[fechas.length - 1]);
  if (errF) throw new Error(`${tablaFacturas}: ${errF.message}`);
  if (!facturas.length) return [];

  const proveedorPorFactura = new Map(facturas.map(f => [f.id, f.proveedor]));
  const { data: lineas, error: errL } = await supabase
    .from(tablaLineas).select('factura_id, producto, cantidad, precio_unitario, importe_linea')
    .in('factura_id', facturas.map(f => f.id))
    .not('producto', 'is', null)
    .not('precio_unitario', 'is', null);
  if (errL) throw new Error(`${tablaLineas}: ${errL.message}`);

  const grupos = new Map();
  for (const l of lineas) {
    const proveedor = proveedorPorFactura.get(l.factura_id) || '(sin proveedor)';
    const key = `${normalizarTextoProducto(l.producto)}||${proveedor}`;
    if (!grupos.has(key)) grupos.set(key, { producto: l.producto, proveedor, cantidad: 0, gasto: 0, precios: [] });
    const g = grupos.get(key);
    const cantidad = Number(l.cantidad) || 0;
    const precio = Number(l.precio_unitario);
    g.cantidad += cantidad;
    g.gasto += l.importe_linea != null ? Number(l.importe_linea) : cantidad * precio;
    g.precios.push(precio);
  }

  return [...grupos.values()]
    .map(g => ({
      producto: g.producto,
      proveedor: g.proveedor,
      cantidad: g.cantidad,
      gasto: g.gasto,
      precio_medio: Number((g.precios.reduce((s, p) => s + p, 0) / g.precios.length).toFixed(4)),
      precio_min: Math.min(...g.precios),
      precio_max: Math.max(...g.precios),
    }))
    .sort((a, b) => b.gasto - a.gasto)
    .slice(0, 20);
}

// ── 5. Productos vendidos ────────────────────────────────────────────────
async function seccionProductosVendidos(cliente, fechas) {
  const { data: ventas, error: errV } = await supabase
    .from('ventas_diarias').select('id').eq('cliente', cliente)
    .gte('fecha', fechas[0]).lte('fecha', fechas[fechas.length - 1]);
  if (errV) throw new Error(`ventas_diarias: ${errV.message}`);
  if (!ventas.length) return { top_unidades: [], top_importe: [] };

  const { data: lineas, error: errL } = await supabase
    .from('ventas_lineas').select('producto, cantidad, importe')
    .in('venta_id', ventas.map(v => v.id));
  if (errL) throw new Error(`ventas_lineas: ${errL.message}`);
  if (!lineas.length) return { top_unidades: [], top_importe: [] };

  const grupos = new Map();
  for (const l of lineas) {
    if (!l.producto) continue;
    const key = normalizarTextoProducto(l.producto);
    if (!grupos.has(key)) grupos.set(key, { producto: l.producto, unidades: 0, importe: 0 });
    const g = grupos.get(key);
    g.unidades += Number(l.cantidad) || 0;
    g.importe += Number(l.importe) || 0;
  }
  const lista = [...grupos.values()];
  return {
    top_unidades: [...lista].sort((a, b) => b.unidades - a.unidades).slice(0, 20),
    top_importe: [...lista].sort((a, b) => b.importe - a.importe).slice(0, 20),
  };
}

// ── 6. Sobreprecios contra tarifa ────────────────────────────────────────
// Mismo criterio que GET /analytics/sobreprecios (total_sobreprecio_eur por
// factura, desviacion_eur por línea en estado 'sobreprecio'), pero acotado
// al rango de fechas del resumen en vez de a un mes concreto.
async function seccionSobreprecios(cliente, fechas) {
  const tablaFacturas = `${cliente}_facturas`;
  const tablaLineas = `${cliente}_factura_lineas`;

  const { data: facturas, error } = await supabase
    .from(tablaFacturas)
    .select('id, proveedor, fecha_factura, total_sobreprecio_eur')
    .gt('total_sobreprecio_eur', 0)
    .gte('fecha_factura', fechas[0]).lte('fecha_factura', fechas[fechas.length - 1]);
  if (error) throw new Error(`${tablaFacturas}: ${error.message}`);

  const facturaIds = facturas.map(f => f.id);
  let lineas = [];
  if (facturaIds.length) {
    const { data, error: errL } = await supabase
      .from(tablaLineas)
      .select('factura_id, producto_tarifa, desviacion_eur')
      .eq('estado_precio', 'sobreprecio')
      .in('factura_id', facturaIds);
    if (errL) throw new Error(`${tablaLineas}: ${errL.message}`);
    lineas = data;
  }

  const porProveedorAcc = new Map();
  for (const f of facturas) porProveedorAcc.set(f.proveedor, (porProveedorAcc.get(f.proveedor) || 0) + (Number(f.total_sobreprecio_eur) || 0));
  const porProductoAcc = new Map();
  for (const l of lineas) {
    const key = l.producto_tarifa || '(sin producto)';
    porProductoAcc.set(key, (porProductoAcc.get(key) || 0) + (Number(l.desviacion_eur) || 0));
  }

  return {
    total_eur: facturas.reduce((s, f) => s + (Number(f.total_sobreprecio_eur) || 0), 0),
    por_proveedor: [...porProveedorAcc.entries()].map(([proveedor, total]) => ({ proveedor, total })).sort((a, b) => b.total - a.total),
    por_producto: [...porProductoAcc.entries()].map(([producto, total]) => ({ producto, total })).sort((a, b) => b.total - a.total),
    facturas_afectadas: facturas.map(f => ({ id: f.id, proveedor: f.proveedor, fecha_factura: f.fecha_factura, total_sobreprecio_eur: Number(f.total_sobreprecio_eur) || 0 })),
  };
}

// ── 7. Incompletos / posibles duplicados / revisar ──────────────────────
// Por created_at (fecha de subida), no fecha_factura: un documento
// incompleto puede no tener fecha_factura precisamente por eso, así que
// filtrar por fecha_factura los dejaría fuera del recuento.
async function seccionIncompletos(cliente, fechas) {
  const tabla = `${cliente}_facturas`;
  const { data, error } = await supabase
    .from(tabla).select('fecha_factura, numero_factura, posible_duplicado, tipo')
    .gte('created_at', `${fechas[0]}T00:00:00.000Z`)
    .lte('created_at', `${fechas[fechas.length - 1]}T23:59:59.999Z`);
  if (error) throw new Error(`${tabla}: ${error.message}`);

  return {
    incompletos: data.filter(f => !f.fecha_factura || !f.numero_factura).length,
    duplicados: data.filter(f => f.posible_duplicado).length,
    revisar: data.filter(f => f.tipo === 'revisar').length,
    total_documentos: data.length,
  };
}

// ── Resumen completo ─────────────────────────────────────────────────────
async function generarResumen({ cliente, desde, hasta }) {
  const rango = rangoPorDefecto(desde, hasta);
  const fechas = generarFechas(rango.desde, rango.hasta);

  const ventas = await seccionVentas(cliente, fechas);
  const compras = await seccionCompras(cliente, fechas);
  const personal = await seccionPersonal(cliente, fechas);
  const foodcost = seccionFoodcost(fechas, compras.porFechaNum, ventas.porFechaNum);
  const productos_compra = await seccionProductosCompra(cliente, fechas);
  const productos_vendidos = await seccionProductosVendidos(cliente, fechas);
  const sobreprecios = await seccionSobreprecios(cliente, fechas);
  const incompletos = await seccionIncompletos(cliente, fechas);

  // Aproximación de gestión, no un resultado contable: compras es solo
  // factura/ticket (ver seccionCompras) y personal suma meses completos
  // aunque el rango los toque solo parcialmente (ver seccionPersonal).
  const resultado_aproximado = {
    valor: ventas.publico.total_periodo - compras.publico.total_periodo - personal.total_periodo,
    nota: 'Aproximación de gestión (ventas − compras − personal), no es un resultado contable.',
  };

  return {
    cliente,
    desde: rango.desde,
    hasta: rango.hasta,
    dias_totales: fechas.length,
    ventas: ventas.publico,
    compras: compras.publico,
    personal,
    resultado_aproximado,
    foodcost,
    productos_compra,
    productos_vendidos,
    sobreprecios,
    incompletos,
  };
}

// ── "Pregúntale a tu restaurante" ────────────────────────────────────────
// Un único bloque de reglas para el analista: nunca inventar cifras, nunca
// comparar días sueltos, avisar de huecos de caja y de food cost fuera de
// rango. Reutiliza extraerJson() (backend/lib/claude-json.js) aunque la
// salida sea texto: el esquema solo tiene un campo string, pero así se
// mantiene el mismo reintento ante respuesta truncada que el resto del hub.
const PREGUNTAR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { respuesta: { type: 'string' } },
  required: ['respuesta'],
};

const SYSTEM_PREGUNTAR = `Eres un analista de restaurantes que responde preguntas de un gestor sobre
su propio negocio, a partir de datos ya calculados en dos JSON (periodo_actual y
periodo_anterior). No los recalcules ni los cuestiones, son correctos.

Reglas estrictas:
- Responde SOLO con los datos de los JSON proporcionados. Si un dato no está o es null,
  dilo explícitamente ("no tengo ese dato") — nunca inventes ni estimes una cifra.
- Máximo 6 líneas. Los números van primero, la explicación (el porqué) después.
- Toda comparación es SIEMPRE contra periodo_anterior (mismo número de días, inmediatamente
  anterior a periodo_actual) — nunca compares días sueltos entre sí.
- Si periodo_actual.ventas.dias_sin_cierre es mayor que 0, dilo al principio de la respuesta
  (cuántos días de caja faltan sobre el total de periodo_actual.dias_totales), antes de
  responder a la pregunta.
- Texto plano en español, tuteando al gestor. Sin listas ni viñetas, salvo que la pregunta
  pida explícitamente un ranking o un listado.
- El food cost normal en hostelería está entre 28% y 35%. Si el food cost del periodo
  (periodo_actual.foodcost.periodo.foodcost_pct) está fuera de ese rango, indícalo.`;

function construirPromptPreguntar({ pregunta, actual, anterior }) {
  return `${SYSTEM_PREGUNTAR}

periodo_actual (${actual.desde} a ${actual.hasta}):
${JSON.stringify(actual)}

periodo_anterior (${anterior.desde} a ${anterior.hasta}):
${JSON.stringify(anterior)}

Pregunta del gestor: ${pregunta}`;
}

async function preguntarSobreResumen({ pregunta, actual, anterior }) {
  const { data } = await extraerJson({
    maxTokens: 1024,
    effort: 'medium',
    schema: PREGUNTAR_SCHEMA,
    content: [{ type: 'text', text: construirPromptPreguntar({ pregunta, actual, anterior }) }],
    mensajeError: 'La IA no pudo generar una respuesta a la pregunta.',
  });
  return data.respuesta;
}

module.exports = {
  generarResumen, resolverPeriodo, periodoAnterior, preguntarSobreResumen,
};
