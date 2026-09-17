'use strict';
// One-off: recorre timbol_facturas y comarea_facturas con fecha_factura o
// numero_factura vacíos, descarga el archivo de Drive y reintenta con
// reintentarFechaYNumero() — el mismo reintento insistente que ya corre en
// cada subida nueva (ver backend/lib/extraccion.js). Esto es solo para los
// documentos que se subieron ANTES de que existiera ese reintento.
//
//   node backend/scripts/reintentar-incompletos.js           → DRY RUN:
//                                                                muestra qué rellenaría, no guarda nada.
//   node backend/scripts/reintentar-incompletos.js --apply   → guarda los cambios.
//
// En Railway (necesita las env vars reales de Drive/Supabase/Anthropic):
//   railway run node backend/scripts/reintentar-incompletos.js
const { supabase } = require('../lib/supabase');
const { drive } = require('../lib/google');
const { reintentarFechaYNumero } = require('../lib/extraccion');

const TABLAS = ['timbol_facturas', 'comarea_facturas'];

async function descargarArchivo(fileId) {
  const meta = await drive.files.get({ fileId, fields: 'mimeType, name' });
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return { buffer: Buffer.from(res.data), mimeType: meta.data.mimeType };
}

async function procesarTabla(tabla, apply) {
  const { data: filas, error } = await supabase
    .from(tabla)
    .select('id, fecha_factura, numero_factura, drive_file_id, proveedor')
    .or('fecha_factura.is.null,numero_factura.is.null');
  if (error) throw new Error(`${tabla}: ${error.message}`);

  const sinArchivo = filas.filter(f => !f.drive_file_id);
  const conArchivo = filas.filter(f => f.drive_file_id);

  console.log(`\n=== ${tabla}: ${filas.length} incompleta(s) ===`);
  if (sinArchivo.length) {
    console.log(`  ${sinArchivo.length} sin drive_file_id, no se pueden reintentar: ${sinArchivo.map(f => f.id).join(', ')}`);
  }

  let rellenadas = 0, sinCambio = 0, errores = 0;

  for (const fila of conArchivo) {
    try {
      const { buffer, mimeType } = await descargarArchivo(fila.drive_file_id);
      const data = { fecha_factura: fila.fecha_factura, numero_factura: fila.numero_factura };
      await reintentarFechaYNumero(buffer, mimeType, data);

      const cambios = {};
      if (!fila.fecha_factura && data.fecha_factura) cambios.fecha_factura = data.fecha_factura;
      if (!fila.numero_factura && data.numero_factura) cambios.numero_factura = data.numero_factura;

      if (!Object.keys(cambios).length) {
        sinCambio++;
        console.log(`  = #${fila.id} (${fila.proveedor || '(sin proveedor)'}) — sigue sin fecha/número`);
        continue;
      }

      rellenadas++;
      console.log(`  ✓ #${fila.id} (${fila.proveedor || '(sin proveedor)'}) — ${JSON.stringify(cambios)}`);
      if (apply) {
        const { error: errUpdate } = await supabase.from(tabla).update(cambios).eq('id', fila.id);
        if (errUpdate) { errores++; console.error(`    ✗ no se pudo guardar: ${errUpdate.message}`); }
      }
    } catch (e) {
      errores++;
      console.error(`  ✗ #${fila.id}: ${e.message}`);
    }
  }

  console.log(`  Rellenadas: ${rellenadas}, sin cambio: ${sinCambio}, errores: ${errores}`);
}

(async () => {
  const apply = process.argv.includes('--apply');
  for (const tabla of TABLAS) {
    await procesarTabla(tabla, apply);
  }
  console.log(apply
    ? '\nCambios guardados.'
    : '\nDry run — nada guardado. Repite con --apply para escribir.');
})().catch(e => { console.error(e); process.exit(1); });
