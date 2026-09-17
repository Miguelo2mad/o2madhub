'use strict';
// Resumen de análisis en texto plano para un cliente y un rango de fechas
// (por defecto los últimos 30 días). Sin gráficos, solo tablas de texto
// alineadas — pensado para pegar en un chat o un email, no para la app.
//
//   node backend/scripts/resumen-analisis.js timbol
//   node backend/scripts/resumen-analisis.js comarea --desde=2026-08-01 --hasta=2026-08-31
//
// En Railway: railway run node backend/scripts/resumen-analisis.js timbol
const { supabase } = require('../lib/supabase');
const { normalizarTextoProducto } = require('../lib/tarifas');
const { calcularFoodcost } = require('../lib/ventas');

const CLIENTES_VALIDOS = ['timbol', 'comarea'];

// ── Formato ──────────────────────────────────────────────────────────────
const eur = (n) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(Number(n) || 0);
const numFmt = (n) => new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(Number(n) || 0);
const pctFmt = (n) => `${Number(n).toFixed(1).replace('.', ',')}%`;

function imprimirTabla(columnas, filas) {
  if (!filas.length) { console.log('(sin datos)'); return; }
  const anchos = columnas.map(c => Math.max(c.nombre.length, ...filas.map(f => String(f[c.clave] ?? '').length)));
  const formatear = (valores) => valores.map((v, i) => {
    const s = String(v ?? '');
    return columnas[i].align === 'right' ? s.padStart(anchos[i]) : s.padEnd(anchos[i]);
  }).join('  ');
  console.log(formatear(columnas.map(c => c.nombre)));
  console.log(anchos.map(a => '-'.repeat(a)).join('  '));
  filas.forEach(f => console.log(formatear(columnas.map(c => f[c.clave]))));
}

// ── Rango de fechas ──────────────────────────────────────────────────────
function parseRango(args) {
  let desde = null, hasta = null;
  for (const arg of args) {
    const mD = /^--desde=(\d{4}-\d{2}-\d{2})$/.exec(arg);
    const mH = /^--hasta=(\d{4}-\d{2}-\d{2})$/.exec(arg);
    if (mD) desde = mD[1];
    if (mH) hasta = mH[1];
  }
  const hastaIso = hasta || new Date().toISOString().slice(0, 10);
  const desdeIso = desde || new Date(new Date(`${hastaIso}T00:00:00Z`).getTime() - 29 * 86400000).toISOString().slice(0, 10);
  return { desde: desdeIso, hasta: hastaIso };
}

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

// ── 1. Ventas ────────────────────────────────────────────────────────────
async function seccionVentas(cliente, fechas) {
  console.log('\n=== 1. VENTAS ===');
  const { data, error } = await supabase
    .from('ventas_diarias')
    .select('fecha, total_neto, num_tickets, detalle_por_articulo')
    .eq('cliente', cliente)
    .gte('fecha', fechas[0]).lte('fecha', fechas[fechas.length - 1]);
  if (error) throw new Error(`ventas_diarias: ${error.message}`);

  const porFecha = new Map(data.map(v => [v.fecha, v]));
  imprimirTabla(
    [
      { clave: 'fecha', nombre: 'Fecha' },
      { clave: 'total_neto', nombre: 'Total neto', align: 'right' },
      { clave: 'num_tickets', nombre: 'Tickets', align: 'right' },
      { clave: 'detalle', nombre: 'Detalle artículo' },
    ],
    fechas.map(f => {
      const v = porFecha.get(f);
      return {
        fecha: f,
        total_neto: v ? eur(v.total_neto) : '—',
        num_tickets: v ? (v.num_tickets ?? '—') : '—',
        detalle: v ? (v.detalle_por_articulo === false ? 'No' : 'Sí') : '—',
      };
    })
  );

  const totalPeriodo = data.reduce((s, v) => s + (Number(v.total_neto) || 0), 0);
  const diasSinCierre = fechas.length - data.length;
  console.log(`\nTotal ventas netas del periodo: ${eur(totalPeriodo)}`);
  console.log(`Días sin cierre cargado: ${diasSinCierre} de ${fechas.length}`);

  return { ventasPorFechaNum: new Map(data.map(v => [v.fecha, Number(v.total_neto) || 0])) };
}

// ── 2. Compras ───────────────────────────────────────────────────────────
async function seccionCompras(cliente, fechas) {
  console.log('\n=== 2. COMPRAS (factura + ticket, sin albaranes) ===');
  const tabla = `${cliente}_facturas`;
  const { data, error } = await supabase
    .from(tabla)
    .select('fecha_factura, importe_total, proveedor')
    .in('tipo', ['factura', 'ticket'])
    .gte('fecha_factura', fechas[0]).lte('fecha_factura', fechas[fechas.length - 1]);
  if (error) throw new Error(`${tabla}: ${error.message}`);

  const porFecha = new Map();
  for (const f of data) porFecha.set(f.fecha_factura, (porFecha.get(f.fecha_factura) || 0) + (Number(f.importe_total) || 0));

  imprimirTabla(
    [
      { clave: 'fecha', nombre: 'Fecha' },
      { clave: 'total', nombre: 'Compras', align: 'right' },
    ],
    fechas.map(f => ({ fecha: f, total: eur(porFecha.get(f) || 0) }))
  );

  const totalPeriodo = data.reduce((s, f) => s + (Number(f.importe_total) || 0), 0);
  console.log(`\nTotal compras del periodo: ${eur(totalPeriodo)}`);

  const porProveedor = new Map();
  for (const f of data) {
    const key = f.proveedor || '(sin proveedor)';
    if (!porProveedor.has(key)) porProveedor.set(key, { total: 0, count: 0 });
    const p = porProveedor.get(key);
    p.total += Number(f.importe_total) || 0;
    p.count += 1;
  }
  const proveedores = [...porProveedor.entries()]
    .map(([proveedor, v]) => ({ proveedor, total: v.total, count: v.count, pct: totalPeriodo > 0 ? (v.total / totalPeriodo) * 100 : 0 }))
    .sort((a, b) => b.total - a.total);

  console.log('\nGasto por proveedor:');
  imprimirTabla(
    [
      { clave: 'proveedor', nombre: 'Proveedor' },
      { clave: 'total', nombre: 'Total', align: 'right' },
      { clave: 'count', nombre: 'Nº facturas', align: 'right' },
      { clave: 'pct', nombre: '% del total', align: 'right' },
    ],
    proveedores.map(p => ({ proveedor: p.proveedor, total: eur(p.total), count: p.count, pct: pctFmt(p.pct) }))
  );

  return { porFecha };
}

// ── 3. Food cost ─────────────────────────────────────────────────────────
// Reutiliza calcularFoodcost() de backend/lib/ventas.js — misma aritmética
// que /analytics/foodcost en la app, para no tener dos criterios distintos.
function seccionFoodcost(fechas, comprasPorFecha, ventasPorFecha) {
  console.log('\n=== 3. FOOD COST ===');
  const resultado = calcularFoodcost(comprasPorFecha, ventasPorFecha, fechas);
  const { compras, ventas_neto, foodcost_pct } = resultado.acumulado;
  console.log(`Food cost del periodo: ${foodcost_pct != null ? pctFmt(foodcost_pct) : '—'} (compras ${eur(compras)} / ventas ${eur(ventas_neto)})`);

  const semanas = [];
  for (let i = 0; i < fechas.length; i += 7) {
    const bloque = fechas.slice(i, i + 7);
    const comprasSemana = bloque.reduce((s, f) => s + (comprasPorFecha.get(f) || 0), 0);
    const ventasSemana = bloque.reduce((s, f) => s + (ventasPorFecha.get(f) || 0), 0);
    semanas.push({
      rango: `${bloque[0]} a ${bloque[bloque.length - 1]}`,
      compras: eur(comprasSemana),
      ventas: eur(ventasSemana),
      pct: ventasSemana > 0 ? pctFmt((comprasSemana / ventasSemana) * 100) : '—',
    });
  }
  console.log('\nFood cost por semana:');
  imprimirTabla(
    [
      { clave: 'rango', nombre: 'Semana' },
      { clave: 'compras', nombre: 'Compras', align: 'right' },
      { clave: 'ventas', nombre: 'Ventas netas', align: 'right' },
      { clave: 'pct', nombre: 'Food cost', align: 'right' },
    ],
    semanas
  );
}

// ── 4. Top 20 productos por gasto ────────────────────────────────────────
// Agrupado por (producto normalizado, proveedor) — el mismo producto
// comprado a dos proveedores distintos da dos filas, para que "proveedor"
// signifique algo concreto en cada una.
async function seccionTopProductosCompra(cliente, fechas) {
  console.log('\n=== 4. TOP 20 PRODUCTOS POR GASTO ===');
  const tablaFacturas = `${cliente}_facturas`;
  const tablaLineas = `${cliente}_factura_lineas`;

  const { data: facturas, error: errF } = await supabase
    .from(tablaFacturas).select('id, proveedor')
    .in('tipo', ['factura', 'ticket'])
    .gte('fecha_factura', fechas[0]).lte('fecha_factura', fechas[fechas.length - 1]);
  if (errF) throw new Error(`${tablaFacturas}: ${errF.message}`);
  if (!facturas.length) { console.log('Sin facturas en el periodo.'); return; }

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

  const top = [...grupos.values()]
    .map(g => ({
      producto: g.producto,
      proveedor: g.proveedor,
      cantidad: g.cantidad,
      gasto: g.gasto,
      precioMedio: g.precios.reduce((s, p) => s + p, 0) / g.precios.length,
      precioMin: Math.min(...g.precios),
      precioMax: Math.max(...g.precios),
    }))
    .sort((a, b) => b.gasto - a.gasto)
    .slice(0, 20);

  imprimirTabla(
    [
      { clave: 'producto', nombre: 'Producto' },
      { clave: 'proveedor', nombre: 'Proveedor' },
      { clave: 'cantidad', nombre: 'Cantidad', align: 'right' },
      { clave: 'gasto', nombre: 'Gasto', align: 'right' },
      { clave: 'precioMedio', nombre: 'Precio medio', align: 'right' },
      { clave: 'precioMin', nombre: 'Precio mín', align: 'right' },
      { clave: 'precioMax', nombre: 'Precio máx', align: 'right' },
    ],
    top.map(t => ({
      producto: t.producto, proveedor: t.proveedor, cantidad: numFmt(t.cantidad), gasto: eur(t.gasto),
      precioMedio: eur(t.precioMedio), precioMin: eur(t.precioMin), precioMax: eur(t.precioMax),
    }))
  );
}

// ── 5. Productos vendidos ────────────────────────────────────────────────
async function seccionProductosVendidos(cliente, fechas) {
  console.log('\n=== 5. PRODUCTOS VENDIDOS ===');
  const { data: ventas, error: errV } = await supabase
    .from('ventas_diarias').select('id').eq('cliente', cliente)
    .gte('fecha', fechas[0]).lte('fecha', fechas[fechas.length - 1]);
  if (errV) throw new Error(`ventas_diarias: ${errV.message}`);
  if (!ventas.length) { console.log('Sin cierres de caja en el periodo.'); return; }

  const { data: lineas, error: errL } = await supabase
    .from('ventas_lineas').select('producto, cantidad, importe')
    .in('venta_id', ventas.map(v => v.id));
  if (errL) throw new Error(`ventas_lineas: ${errL.message}`);
  if (!lineas.length) { console.log('Sin líneas de venta por producto en el periodo.'); return; }

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
  const columnas = [
    { clave: 'producto', nombre: 'Producto' },
    { clave: 'unidades', nombre: 'Unidades', align: 'right' },
    { clave: 'importe', nombre: 'Importe', align: 'right' },
  ];

  console.log('\nTop 20 por unidades vendidas:');
  imprimirTabla(columnas, [...lista].sort((a, b) => b.unidades - a.unidades).slice(0, 20)
    .map(p => ({ producto: p.producto, unidades: numFmt(p.unidades), importe: eur(p.importe) })));

  console.log('\nTop 20 por importe:');
  imprimirTabla(columnas, [...lista].sort((a, b) => b.importe - a.importe).slice(0, 20)
    .map(p => ({ producto: p.producto, unidades: numFmt(p.unidades), importe: eur(p.importe) })));
}

// ── 6. Incompletos / posibles duplicados / revisar ──────────────────────
// Por created_at (fecha de subida), no fecha_factura: un documento
// incompleto puede no tener fecha_factura precisamente por eso, así que
// filtrar por fecha_factura los dejaría fuera del recuento.
async function seccionRecuentos(cliente, fechas) {
  console.log('\n=== 6. INCOMPLETOS / POSIBLES DUPLICADOS / REVISAR ===');
  const tabla = `${cliente}_facturas`;
  const { data, error } = await supabase
    .from(tabla).select('fecha_factura, numero_factura, posible_duplicado, tipo')
    .gte('created_at', `${fechas[0]}T00:00:00.000Z`)
    .lte('created_at', `${fechas[fechas.length - 1]}T23:59:59.999Z`);
  if (error) throw new Error(`${tabla}: ${error.message}`);

  const incompletos = data.filter(f => !f.fecha_factura || !f.numero_factura).length;
  const duplicados = data.filter(f => f.posible_duplicado).length;
  const revisar = data.filter(f => f.tipo === 'revisar').length;

  console.log(`Incompletos (sin fecha o sin número): ${incompletos}`);
  console.log(`Posibles duplicados: ${duplicados}`);
  console.log(`En revisar: ${revisar}`);
  console.log(`(sobre ${data.length} documento(s) subido(s) en el periodo)`);
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const cliente = process.argv[2];
  if (!CLIENTES_VALIDOS.includes(cliente)) {
    console.error(`Uso: node backend/scripts/resumen-analisis.js <${CLIENTES_VALIDOS.join('|')}> [--desde=YYYY-MM-DD] [--hasta=YYYY-MM-DD]`);
    process.exit(1);
  }
  const { desde, hasta } = parseRango(process.argv.slice(3));
  const fechas = generarFechas(desde, hasta);

  console.log(`Resumen de análisis — ${cliente}`);
  console.log(`Periodo: ${desde} a ${hasta} (${fechas.length} día(s))`);

  const { ventasPorFechaNum } = await seccionVentas(cliente, fechas);
  const { porFecha: comprasPorFechaNum } = await seccionCompras(cliente, fechas);
  seccionFoodcost(fechas, comprasPorFechaNum, ventasPorFechaNum);
  await seccionTopProductosCompra(cliente, fechas);
  await seccionProductosVendidos(cliente, fechas);
  await seccionRecuentos(cliente, fechas);
}

main().catch(e => { console.error(e); process.exit(1); });
