'use strict';
// Escandallo asistido: propone un borrador de escandallo (ingredientes +
// cantidades por ración) a partir del nombre de un plato y, opcionalmente,
// una foto — apoyándose en lo que el cliente realmente compra
// (${cliente}_factura_lineas, mismo criterio que backend/lib/inventario.js)
// y en sus escandallos ya confirmados como ejemplo de estilo/cantidades.
// Solo propone: no escribe en platos/escandallo — eso lo hace el endpoint
// de confirmación cuando exista la pestaña Escandallo (ver database/
// migrations/042 y 045 para el esquema de esas tablas).
const { supabase } = require('./supabase');
const { buildFileBlock, extraerJson } = require('./claude-json');
const { normalizarTextoProducto, normalizarUnidad } = require('./tarifas');

const DIAS_HISTORICO_COMPRAS = 90;
const MAX_EJEMPLOS = 8;

function offsetDias(iso, dias) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// Valor más frecuente de una lista (ignora vacíos) — desempate por orden de
// aparición. Genérica: sirve tanto para elegir el nombre "de cara" de un
// producto como su unidad de compra habitual.
function masFrecuente(valores) {
  const conteo = new Map();
  for (const v of valores) {
    if (!v) continue;
    conteo.set(v, (conteo.get(v) || 0) + 1);
  }
  let mejor = null, mejorCount = 0;
  for (const [v, c] of conteo) {
    if (c > mejorCount) { mejor = v; mejorCount = c; }
  }
  return mejor;
}

// Productos distintos que el cliente ha comprado en los últimos 90 días,
// con su nombre más habitual tal cual aparece en factura (no el
// normalizado) y su unidad de compra más habitual.
async function productosComprados(cliente) {
  const tablaFacturas = `${cliente}_facturas`;
  const tablaLineas = `${cliente}_factura_lineas`;
  const desde = offsetDias(new Date().toISOString().slice(0, 10), -DIAS_HISTORICO_COMPRAS);

  const { data: facturas, error: errF } = await supabase
    .from(tablaFacturas).select('id').gte('fecha_factura', desde);
  if (errF) throw new Error(`${tablaFacturas}: ${errF.message}`);
  if (!facturas.length) return [];

  const { data: lineas, error: errL } = await supabase
    .from(tablaLineas).select('producto, unidad')
    .in('factura_id', facturas.map(f => f.id))
    .not('producto', 'is', null);
  if (errL) throw new Error(`${tablaLineas}: ${errL.message}`);

  const porNorm = new Map(); // producto_norm -> { nombres: [], unidades: [] }
  for (const l of lineas) {
    const norm = normalizarTextoProducto(l.producto);
    if (!norm) continue;
    if (!porNorm.has(norm)) porNorm.set(norm, { nombres: [], unidades: [] });
    const entrada = porNorm.get(norm);
    entrada.nombres.push(l.producto);
    entrada.unidades.push(normalizarUnidad(l.unidad));
  }

  return [...porNorm.values()]
    .map(e => ({ nombre: masFrecuente(e.nombres), unidad: masFrecuente(e.unidades) }))
    .filter(p => p.nombre)
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}

// Hasta MAX_EJEMPLOS escandallos ya confirmados, los platos más recientes
// primero — como ejemplo del estilo y las cantidades con que trabaja este
// restaurante (no todos los platos dados de alta tienen ya un escandallo,
// de ahí el margen al pedir platos antes de filtrar).
async function ejemplosEscandallo(cliente) {
  const { data: platos, error: errP } = await supabase
    .from('platos').select('id, nombre').eq('cliente', cliente)
    .order('created_at', { ascending: false })
    .limit(40);
  if (errP) throw new Error(`platos: ${errP.message}`);
  if (!platos.length) return [];

  const { data: lineas, error: errE } = await supabase
    .from('escandallo').select('plato_id, ingrediente, cantidad, unidad')
    .in('plato_id', platos.map(p => p.id));
  if (errE) throw new Error(`escandallo: ${errE.message}`);

  const lineasPorPlato = new Map();
  for (const l of lineas) {
    if (!lineasPorPlato.has(l.plato_id)) lineasPorPlato.set(l.plato_id, []);
    lineasPorPlato.get(l.plato_id).push({ ingrediente: l.ingrediente, cantidad: Number(l.cantidad), unidad: l.unidad });
  }

  const ejemplos = [];
  for (const plato of platos) {
    const ingredientes = lineasPorPlato.get(plato.id);
    if (!ingredientes || !ingredientes.length) continue;
    ejemplos.push({ plato: plato.nombre, ingredientes });
    if (ejemplos.length >= MAX_EJEMPLOS) break;
  }
  return ejemplos;
}

const ESCANDALLO_INGREDIENTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ingrediente: { type: 'string' },
    cantidad:    { type: 'number' },
    unidad:      { type: 'string', enum: ['g', 'ml', 'ud'] },
    visible:     { type: 'boolean', description: 'false si el ingrediente no se ve en la foto pero el plato lo lleva (aceite, caldo, sofrito, especias...)' },
    confianza:   { type: 'string', enum: ['alta', 'media', 'baja'] },
    nota:        { type: ['string', 'null'], description: 'Breve, solo si la cantidad es muy incierta' },
  },
  required: ['ingrediente', 'cantidad', 'unidad', 'visible', 'confianza', 'nota'],
};

const ESCANDALLO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ingredientes:  { type: 'array', items: ESCANDALLO_INGREDIENTE_SCHEMA },
    raciones:      { type: 'number' },
    observaciones: { type: ['string', 'null'] },
  },
  required: ['ingredientes', 'raciones', 'observaciones'],
};

function construirPrompt({ nombrePlato, descripcion, precioCarta, productos, ejemplos }) {
  let prompt = 'Propón el escandallo de este plato para UNA ración, en peso crudo de compra (no cocinado). '
    + 'Usa preferentemente productos de la lista de compras del cliente, con su nombre exacto. '
    + 'Incluye los ingredientes que no se ven en la foto pero que el plato lleva (aceite, caldo, sofrito, especias), '
    + 'marcados con visible: false. Para cada ingrediente devuelve cantidad, unidad (g, ml, ud), confianza '
    + '(alta | media | baja) y una nota breve si la cantidad es muy incierta.\n\n';

  prompt += `Plato: ${nombrePlato}\n`;
  if (descripcion) prompt += `Descripción: ${descripcion}\n`;
  if (precioCarta != null) prompt += `Precio de carta: ${precioCarta} EUR\n`;

  prompt += '\nProductos que este cliente compra (usa este nombre exacto cuando el ingrediente coincida):\n';
  prompt += productos.length
    ? productos.map(p => `- ${p.nombre}${p.unidad ? ` (se compra en ${p.unidad})` : ''}`).join('\n')
    : '(sin compras registradas todavía)';

  if (ejemplos.length) {
    prompt += '\n\nEscandallos ya confirmados de este cliente, como ejemplo del estilo y las cantidades con que '
      + 'trabaja este restaurante:\n';
    prompt += ejemplos.map(e =>
      `- ${e.plato}: ${e.ingredientes.map(i => `${i.ingrediente} ${i.cantidad}${i.unidad}`).join(', ')}`
    ).join('\n');
  }

  return prompt;
}

// `foto` es opcional: { buffer, mimeType }. Nunca guarda nada — el borrador
// se confirma aparte.
async function proponerEscandallo(cliente, { nombrePlato, descripcion, precioCarta, foto } = {}) {
  if (!nombrePlato || !nombrePlato.trim()) throw new Error('nombre_plato es obligatorio');

  const [productos, ejemplos] = await Promise.all([
    productosComprados(cliente),
    ejemplosEscandallo(cliente),
  ]);

  const content = [];
  if (foto) content.push(buildFileBlock(foto.buffer, foto.mimeType));
  content.push({ type: 'text', text: construirPrompt({ nombrePlato: nombrePlato.trim(), descripcion, precioCarta, productos, ejemplos }) });

  const { data } = await extraerJson({
    maxTokens: 2048,
    schema: ESCANDALLO_SCHEMA,
    content,
    mensajeError: 'La IA no pudo proponer el escandallo. Vuelve a intentarlo o complétalo a mano.',
  });

  return {
    nombre_plato: nombrePlato.trim(),
    descripcion: descripcion || null,
    precio_carta: precioCarta != null ? Number(precioCarta) : null,
    ingredientes: data.ingredientes,
    raciones: data.raciones || 1,
    observaciones: data.observaciones || null,
  };
}

module.exports = { proponerEscandallo };
