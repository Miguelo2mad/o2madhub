// Parseo de xlsx/csv a texto tabular + troceado en bloques para Claude.
// Extraído de tarifas.js (extraerTarifasDeArchivo) para que banco.js
// (extraerMovimientosDeArchivo) lo reutilice sin duplicar la lectura de
// Excel/CSV — cada banco/proveedor exporta en un formato distinto, pero
// "leer la hoja a filas de texto" es exactamente el mismo problema.
const ExcelJS = require('exceljs');
const { parse: parseCsv } = require('csv-parse/sync');

function celdaATexto(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return celdaATexto(v.result);       // fórmula
    if ('text' in v) return String(v.text);                 // hipervínculo
    if (Array.isArray(v.richText)) return v.richText.map(r => r.text).join(''); // texto enriquecido
    return '';
  }
  return String(v);
}

async function parsearXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb.worksheets.map(ws => {
    const filas = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      filas.push(row.values.slice(1).map(celdaATexto));
    });
    return { hoja: ws.name, filas };
  });
}

function parsearCsv(buffer) {
  const filas = parseCsv(buffer, { relax_column_count: true, skip_empty_lines: true, bom: true })
    .map(fila => fila.map(c => String(c ?? '')));
  return [{ hoja: null, filas }];
}

// Despacha por extensión; csv es la única forma de texto plano que aceptamos,
// cualquier otra cosa se intenta como xlsx (cubre .xlsx y .xls).
async function parsearArchivoTabular(buffer, filename) {
  const ext = (filename || '').toLowerCase().split('.').pop();
  const hojas = ext === 'csv' ? parsearCsv(buffer) : await parsearXlsx(buffer);
  return hojas.filter(h => h.filas.length > 0);
}

const FILAS_POR_BLOQUE = 150;

// Trocea una hoja en bloques de máximo 150 filas de datos, repitiendo la
// primera fila de la hoja (la mejor candidata a cabecera, aunque no lo sea
// siempre) en cada bloque salvo el primero, para que el modelo tenga
// contexto de columnas en bloques que ya no incluyen la cabecera real.
function construirBloques(filas) {
  if (!filas.length) return [];
  const primeraFila = filas[0];
  const bloques = [];
  for (let i = 0; i < filas.length; i += FILAS_POR_BLOQUE) {
    const trozo = filas.slice(i, i + FILAS_POR_BLOQUE);
    bloques.push(i === 0 ? trozo : [primeraFila, ...trozo]);
  }
  return bloques;
}

function filasATexto(filas) {
  return filas.map(fila => fila.map(c => String(c ?? '')).join('\t')).join('\n');
}

module.exports = { parsearArchivoTabular, construirBloques, filasATexto };
