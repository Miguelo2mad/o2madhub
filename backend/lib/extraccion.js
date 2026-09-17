// Extracción compartida de facturas/albaranes/tickets vía Claude Vision.
// Punto único de llamada al modelo para los uploads manuales de Timbol y
// Comarea: antes cada cliente tenía su propia copia de esta función con el
// mismo esquema y el mismo prompt — quedaba duplicada y con riesgo de que
// cada uno acabara clasificando con criterios distintos.
const { client } = require('./claude');
const { compararConTarifa } = require('./tarifas');

const FACTURA_LINEA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    producto:        { type: ['string', 'null'], description: 'Nombre del producto tal como aparece' },
    cantidad:        { type: ['number', 'null'] },
    unidad:          { type: ['string', 'null'], description: 'Unidad de medida en minúsculas: kg, l, ud, caja...' },
    precio_unitario: { type: ['number', 'null'], description: 'Precio por unidad, sin IVA si es posible' },
  },
  required: ['producto', 'cantidad', 'unidad', 'precio_unitario'],
};

const FACTURA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    proveedor:      { type: 'string' },
    numero_factura: { type: ['string', 'null'] },
    fecha_factura:  { type: ['string', 'null'], description: 'YYYY-MM-DD o null' },
    importe_total:  { type: ['number', 'null'], description: 'Importe total con IVA en EUR' },
    importe_base:   { type: ['number', 'null'], description: 'Base imponible en EUR' },
    iva_porcentaje: { type: ['number', 'null'], description: 'Porcentaje de IVA (ej: 21 para 21%)' },
    concepto:       { type: ['string', 'null'] },
    cif_proveedor:  { type: ['string', 'null'], description: 'CIF/NIF del emisor exactamente como aparece' },
    tipo: {
      type: 'string',
      enum: ['factura', 'albaran', 'ticket'],
      description: 'Tipo de documento',
    },
    tipo_evidencia: {
      type: 'string',
      description: 'Texto literal de la cabecera en el que te basas para clasificar el tipo',
    },
    tipo_confianza: {
      type: 'string',
      enum: ['alta', 'media', 'baja'],
      description: 'Confianza en la clasificación de tipo',
    },
    numero_albaranes: {
      type: 'array',
      description: 'Números de albarán que la factura referencia. Array vacío si no menciona ninguno.',
      items: { type: 'string' },
    },
    lineas: {
      type: 'array',
      description: 'Desglose de líneas de producto de la factura. Array vacío [] si no hay una tabla de productos clara (p.ej. servicios).',
      items: FACTURA_LINEA_SCHEMA,
    },
  },
  required: ['proveedor', 'numero_factura', 'fecha_factura', 'importe_total',
    'importe_base', 'iva_porcentaje', 'concepto', 'cif_proveedor',
    'tipo', 'tipo_evidencia', 'tipo_confianza', 'numero_albaranes'],
};

const FACTURA_PROMPT = 'Extrae los datos de esta factura de proveedor. fecha_factura en YYYY-MM-DD. iva_porcentaje como número (ej: 21). Si no encuentras un campo devuelve null. '
  + 'Además, en "lineas" desglosa cada línea de producto: producto (nombre tal cual), cantidad, unidad de medida en minúsculas (kg, l, ud, caja...) y precio_unitario. '
  + 'Si la factura no tiene una tabla de productos clara (por ejemplo es un servicio), devuelve "lineas" como array vacío []. No inventes líneas ni valores.\n\n'
  + 'Clasifica el documento en "tipo": "factura", "albaran" o "ticket". Criterios por orden de prioridad:\n'
  + '- factura: desglosa base imponible, tipo y cuota de IVA, y lleva número de factura y NIF del receptor.\n'
  + '- ticket: total con IVA incluido pero SIN desglose de base y cuota, y sin NIF del receptor.\n'
  + '- albaran: no desglosa IVA ni muestra total con impuestos, aunque lleve precios unitarios. Suele decir "albarán", "nota de entrega" o "delivery note" en cabecera y llevar espacio para firma.\n'
  + 'Un albarán valorado (con precios pero sin IVA) es albaran, no factura.\n\n'
  + 'Devuelve también:\n'
  + '- "tipo_evidencia": texto literal de la cabecera en que te basas.\n'
  + '- "tipo_confianza": alta | media | baja.\n'
  + '- "numero_albaranes": array con los números de albarán que la factura referencia, vacío si no menciona ninguno.';

// Generoso a propósito: el desglose de líneas + los campos de clasificación
// puede superar fácilmente el límite anterior (1024) y truncar el JSON a
// mitad — origen del bug "Unexpected end of JSON input" visto en producción.
const MAX_TOKENS = 4096;

async function callClaude(buffer, mimeType) {
  const isImage = mimeType.startsWith('image/');
  const fileBlock = isImage
    ? { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } }
    : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };

  return client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: MAX_TOKENS,
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: FACTURA_SCHEMA },
    },
    messages: [{
      role: 'user',
      content: [fileBlock, { type: 'text', text: FACTURA_PROMPT }],
    }],
  });
}

// Marca todas las líneas como sin_tarifa — estado de partida antes de
// intentar comparar, y también el que queda si la comparación falla o no
// aplica (sin cliente, sin NIF, sin proveedor de tarifas para ese NIF).
function lineasSinTarifa(lineas) {
  return (Array.isArray(lineas) ? lineas : []).map(l => ({
    ...l, producto_tarifa: null, precio_pactado: null, desviacion_eur: null, desviacion_pct: null, estado_precio: 'sin_tarifa',
  }));
}

// Extrae los datos de una factura/albarán/ticket subido manualmente. Único
// punto de llamada a Claude para este flujo — Timbol y Comarea comparten el
// mismo esquema y los mismos criterios de clasificación, así no hay dos
// interpretaciones distintas de qué es una factura según el cliente.
// Si la respuesta llega truncada (JSON.parse falla) reintenta una vez la
// llamada completa antes de rendirse con un error legible.
//
// `cliente` es opcional: si se pasa, tras extraer se intenta comparar cada
// línea con la tarifa vigente del proveedor (backend/lib/tarifas.js). La
// comparación es un enriquecimiento OPCIONAL — cualquier fallo ahí (NIF sin
// proveedor, Supabase caído, la llamada de emparejamiento truncada tras su
// propio reintento, lo que sea) se captura y se loguea aquí; la factura se
// devuelve igualmente, con todas las líneas en sin_tarifa. Guardar la
// factura nunca depende de que la comparación funcione.
async function extraerFactura(buffer, mimeType, { cliente } = {}) {
  let res = await callClaude(buffer, mimeType);
  let text = res.content.find(b => b.type === 'text')?.text || '';
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.warn('[extraccion] JSON.parse falló en el primer intento, reintentando:', e.message);
    res = await callClaude(buffer, mimeType);
    text = res.content.find(b => b.type === 'text')?.text || '';
    try {
      data = JSON.parse(text);
    } catch (e2) {
      throw new Error('La IA devolvió una respuesta incompleta al leer el documento. Vuelve a intentar la subida.');
    }
  }

  if (cliente && data.cif_proveedor) {
    try {
      const { lineas, totalSobreprecioEur } = await compararConTarifa({
        cliente,
        cifProveedor: data.cif_proveedor,
        fechaFactura: data.fecha_factura,
        lineas: Array.isArray(data.lineas) ? data.lineas : [],
      });
      data.lineas = lineas;
      data.total_sobreprecio_eur = totalSobreprecioEur;
    } catch (e) {
      console.error('[extraccion] comparación con tarifa falló, se guarda sin comparar:', e.message);
      data.lineas = lineasSinTarifa(data.lineas);
      data.total_sobreprecio_eur = 0;
    }
  } else {
    data.lineas = lineasSinTarifa(data.lineas);
    data.total_sobreprecio_eur = 0;
  }

  return { data, usage: res.usage };
}

// ── Clasificación determinista (punto 3) ────────────────────────────────────
// No nos fiamos solo del modelo: esta función pura decide el tipo final a
// partir de los números ya extraídos y solo cae al criterio del modelo
// cuando esos números no son concluyentes por sí solos. Sin llamadas a
// Claude — testeable de forma aislada y reutilizable por el script de
// migración de datos.
function clasificarTipoFactura({ tipoModelo = null, tipoConfianza = null, importeBase = null, ivaPorcentaje = null } = {}) {
  const base = Number(importeBase) || 0;
  const pct = (ivaPorcentaje === null || ivaPorcentaje === undefined) ? null : Number(ivaPorcentaje);
  const cuotaIva = pct != null ? base * pct / 100 : 0;

  const desglosaIva = base > 0 && cuotaIva > 0;
  const sinIva = base <= 0 && (pct === null || pct === 0);

  let tipoPorNumeros = null;
  if (desglosaIva) tipoPorNumeros = 'factura';
  else if (sinIva) tipoPorNumeros = 'albaran';

  if (tipoConfianza === 'baja') return 'revisar';
  if (tipoPorNumeros && tipoModelo && tipoPorNumeros !== tipoModelo) return 'revisar';
  if (tipoPorNumeros) return tipoPorNumeros;
  return tipoModelo || 'revisar';
}

module.exports = { extraerFactura, clasificarTipoFactura, FACTURA_SCHEMA, FACTURA_PROMPT };
