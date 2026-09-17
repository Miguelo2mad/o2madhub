// One-off: clasifica (factura/albarán/ticket/revisar) las facturas de Timbol
// y Comarea subidas ANTES de la clasificación automática. Aplica la misma
// regla determinista del backend (clasificarTipoFactura) sobre los campos de
// IVA ya guardados en base de datos — no vuelve a llamar al modelo.
//
//   node clasificar-facturas-existentes.js           → DRY RUN: calcula y
//                                                        muestra el diff, sin escribir.
//   node clasificar-facturas-existentes.js --apply   → aplica los cambios.
const { supabase } = require('./backend/lib/supabase');
const { clasificarTipoFactura } = require('./backend/lib/extraccion');
require('dotenv').config();

const TABLAS = ['timbol_facturas', 'comarea_facturas'];

async function calcularCambios(tabla) {
  const { data: rows, error } = await supabase
    .from(tabla).select('id, tipo, importe_base, iva_porcentaje, proveedor, numero_factura');
  if (error) throw new Error(`${tabla}: ${error.message}`);

  return rows
    .map(r => ({
      ...r,
      nuevoTipo: clasificarTipoFactura({
        tipoModelo:    null,
        tipoConfianza: null,
        importeBase:   r.importe_base,
        ivaPorcentaje: r.iva_porcentaje,
      }),
    }))
    .filter(r => r.nuevoTipo !== r.tipo);
}

function printDistribucion(rows, tabla) {
  const dist = {};
  for (const r of rows) dist[r.nuevoTipo] = (dist[r.nuevoTipo] || 0) + 1;
  console.log(`  Nueva distribución en cambios de ${tabla}:`, dist);
}

async function dryRun() {
  for (const tabla of TABLAS) {
    const cambios = await calcularCambios(tabla);
    console.log(`\n=== ${tabla}: ${cambios.length} fila(s) cambian de tipo ===`);
    for (const c of cambios) {
      console.log(`  #${c.id} ${c.proveedor || '(sin proveedor)'} / ${c.numero_factura || '—'} | ` +
        `base=${c.importe_base ?? 'null'} iva%=${c.iva_porcentaje ?? 'null'} | ${c.tipo} → ${c.nuevoTipo}`);
    }
    printDistribucion(cambios, tabla);
  }
  console.log('\nSin cambios en base de datos (dry run). Aplica con: node clasificar-facturas-existentes.js --apply');
}

async function apply() {
  for (const tabla of TABLAS) {
    const cambios = await calcularCambios(tabla);
    console.log(`\n[apply] ${tabla}: aplicando ${cambios.length} cambio(s)…`);
    let ok = 0, fail = 0;
    for (const c of cambios) {
      const { error } = await supabase.from(tabla).update({ tipo: c.nuevoTipo }).eq('id', c.id);
      if (error) { fail++; console.error(`  ✗ #${c.id}: ${error.message}`); } else ok++;
    }
    console.log(`  Aplicados: ${ok}, fallos: ${fail}`);
  }
}

(async () => {
  if (process.argv.includes('--apply')) await apply();
  else await dryRun();
})().catch(e => { console.error(e); process.exit(1); });
