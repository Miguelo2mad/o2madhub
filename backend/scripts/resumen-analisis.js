'use strict';
// Resumen de análisis en texto plano para un cliente y un rango de fechas
// (por defecto los últimos 30 días). Sin gráficos, solo tablas de texto
// alineadas — pensado para pegar en un chat o un email, no para la app.
// La lógica vive en backend/lib/resumen-analisis.js (generarResumen), que
// también usa POST /analytics/preguntar; este script solo parsea argumentos
// e imprime.
//
//   node backend/scripts/resumen-analisis.js timbol
//   node backend/scripts/resumen-analisis.js comarea --desde=2026-08-01 --hasta=2026-08-31
//
// En Railway: railway run node backend/scripts/resumen-analisis.js timbol
const { generarResumen } = require('../lib/resumen-analisis');

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

function parseRango(args) {
  let desde, hasta;
  for (const arg of args) {
    const mD = /^--desde=(\d{4}-\d{2}-\d{2})$/.exec(arg);
    const mH = /^--hasta=(\d{4}-\d{2}-\d{2})$/.exec(arg);
    if (mD) desde = mD[1];
    if (mH) hasta = mH[1];
  }
  return { desde, hasta };
}

// ── 1. Ventas ────────────────────────────────────────────────────────────
function imprimirVentas(ventas) {
  console.log('\n=== 1. VENTAS ===');
  imprimirTabla(
    [
      { clave: 'fecha', nombre: 'Fecha' },
      { clave: 'total_neto', nombre: 'Total neto', align: 'right' },
      { clave: 'num_tickets', nombre: 'Tickets', align: 'right' },
      { clave: 'detalle', nombre: 'Detalle artículo' },
    ],
    ventas.dias.map(v => ({
      fecha: v.fecha,
      total_neto: v.total_neto != null ? eur(v.total_neto) : '—',
      num_tickets: v.num_tickets ?? '—',
      detalle: v.detalle_por_articulo == null ? '—' : (v.detalle_por_articulo ? 'Sí' : 'No'),
    }))
  );
  console.log(`\nTotal ventas netas del periodo: ${eur(ventas.total_periodo)}`);
  console.log(`Días sin cierre cargado: ${ventas.dias_sin_cierre} de ${ventas.dias.length}`);
}

// ── 2. Compras ───────────────────────────────────────────────────────────
function imprimirCompras(compras) {
  console.log('\n=== 2. COMPRAS (factura + ticket, sin albaranes) ===');
  imprimirTabla(
    [
      { clave: 'fecha', nombre: 'Fecha' },
      { clave: 'total', nombre: 'Compras', align: 'right' },
    ],
    compras.dias.map(d => ({ fecha: d.fecha, total: eur(d.total) }))
  );
  console.log(`\nTotal compras del periodo: ${eur(compras.total_periodo)}`);
  console.log('\nGasto por proveedor:');
  imprimirTabla(
    [
      { clave: 'proveedor', nombre: 'Proveedor' },
      { clave: 'total', nombre: 'Total', align: 'right' },
      { clave: 'count', nombre: 'Nº facturas', align: 'right' },
      { clave: 'pct', nombre: '% del total', align: 'right' },
    ],
    compras.por_proveedor.map(p => ({ proveedor: p.proveedor, total: eur(p.total), count: p.num_facturas, pct: pctFmt(p.pct) }))
  );
}

// ── 3. Food cost ─────────────────────────────────────────────────────────
function imprimirFoodcost(foodcost) {
  console.log('\n=== 3. FOOD COST ===');
  const { compras, ventas_neto, foodcost_pct } = foodcost.periodo;
  console.log(`Food cost del periodo: ${foodcost_pct != null ? pctFmt(foodcost_pct) : '—'} (compras ${eur(compras)} / ventas ${eur(ventas_neto)})`);
  console.log('\nFood cost por semana:');
  imprimirTabla(
    [
      { clave: 'rango', nombre: 'Semana' },
      { clave: 'compras', nombre: 'Compras', align: 'right' },
      { clave: 'ventas', nombre: 'Ventas netas', align: 'right' },
      { clave: 'pct', nombre: 'Food cost', align: 'right' },
    ],
    foodcost.semanas.map(s => ({
      rango: `${s.desde} a ${s.hasta}`, compras: eur(s.compras), ventas: eur(s.ventas_neto),
      pct: s.foodcost_pct != null ? pctFmt(s.foodcost_pct) : '—',
    }))
  );
}

// ── 4. Top 20 productos por gasto ────────────────────────────────────────
function imprimirProductosCompra(productos) {
  console.log('\n=== 4. TOP 20 PRODUCTOS POR GASTO ===');
  if (!productos.length) { console.log('Sin facturas en el periodo.'); return; }
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
    productos.map(p => ({
      producto: p.producto, proveedor: p.proveedor, cantidad: numFmt(p.cantidad), gasto: eur(p.gasto),
      precioMedio: eur(p.precio_medio), precioMin: eur(p.precio_min), precioMax: eur(p.precio_max),
    }))
  );
}

// ── 5. Productos vendidos ────────────────────────────────────────────────
function imprimirProductosVendidos(productosVendidos) {
  console.log('\n=== 5. PRODUCTOS VENDIDOS ===');
  if (!productosVendidos.top_unidades.length) { console.log('Sin líneas de venta por producto en el periodo.'); return; }
  const columnas = [
    { clave: 'producto', nombre: 'Producto' },
    { clave: 'unidades', nombre: 'Unidades', align: 'right' },
    { clave: 'importe', nombre: 'Importe', align: 'right' },
  ];
  console.log('\nTop 20 por unidades vendidas:');
  imprimirTabla(columnas, productosVendidos.top_unidades.map(p => ({ producto: p.producto, unidades: numFmt(p.unidades), importe: eur(p.importe) })));
  console.log('\nTop 20 por importe:');
  imprimirTabla(columnas, productosVendidos.top_importe.map(p => ({ producto: p.producto, unidades: numFmt(p.unidades), importe: eur(p.importe) })));
}

// ── 6. Sobreprecios contra tarifa ────────────────────────────────────────
function imprimirSobreprecios(sobreprecios) {
  console.log('\n=== 6. SOBREPRECIOS CONTRA TARIFA ===');
  console.log(`Total sobreprecio del periodo: ${eur(sobreprecios.total_eur)}`);
  if (sobreprecios.por_proveedor.length) {
    console.log('\nPor proveedor:');
    imprimirTabla(
      [{ clave: 'proveedor', nombre: 'Proveedor' }, { clave: 'total', nombre: 'Total', align: 'right' }],
      sobreprecios.por_proveedor.map(p => ({ proveedor: p.proveedor, total: eur(p.total) }))
    );
  }
  if (sobreprecios.por_producto.length) {
    console.log('\nPor producto:');
    imprimirTabla(
      [{ clave: 'producto', nombre: 'Producto' }, { clave: 'total', nombre: 'Total', align: 'right' }],
      sobreprecios.por_producto.map(p => ({ producto: p.producto, total: eur(p.total) }))
    );
  }
}

// ── 7. Incompletos / posibles duplicados / revisar ──────────────────────
function imprimirIncompletos(incompletos) {
  console.log('\n=== 7. INCOMPLETOS / POSIBLES DUPLICADOS / REVISAR ===');
  console.log(`Incompletos (sin fecha o sin número): ${incompletos.incompletos}`);
  console.log(`Posibles duplicados: ${incompletos.duplicados}`);
  console.log(`En revisar: ${incompletos.revisar}`);
  console.log(`(sobre ${incompletos.total_documentos} documento(s) subido(s) en el periodo)`);
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const cliente = process.argv[2];
  if (!CLIENTES_VALIDOS.includes(cliente)) {
    console.error(`Uso: node backend/scripts/resumen-analisis.js <${CLIENTES_VALIDOS.join('|')}> [--desde=YYYY-MM-DD] [--hasta=YYYY-MM-DD]`);
    process.exit(1);
  }
  const { desde, hasta } = parseRango(process.argv.slice(3));
  const resumen = await generarResumen({ cliente, desde, hasta });

  console.log(`Resumen de análisis — ${cliente}`);
  console.log(`Periodo: ${resumen.desde} a ${resumen.hasta} (${resumen.dias_totales} día(s))`);

  imprimirVentas(resumen.ventas);
  imprimirCompras(resumen.compras);
  imprimirFoodcost(resumen.foodcost);
  imprimirProductosCompra(resumen.productos_compra);
  imprimirProductosVendidos(resumen.productos_vendidos);
  imprimirSobreprecios(resumen.sobreprecios);
  imprimirIncompletos(resumen.incompletos);
}

main().catch(e => { console.error(e); process.exit(1); });
