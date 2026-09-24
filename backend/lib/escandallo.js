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
const { normalizarTextoProducto, normalizarUnidad, convertirUnidad } = require('./tarifas');

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

// ── Guardado ─────────────────────────────────────────────────────────────
// Upsert del plato + reemplazo completo de sus líneas en una sola
// transacción real (función de Postgres, ver migración 050) — el cliente
// Supabase-JS no tiene transacciones multi-tabla. La normalización
// (ingrediente, unidad) se hace aquí en JS con las mismas funciones que
// tarifas.js; la función SQL solo hace el guardado mecánico.
async function confirmarEscandallo(cliente, { nombre, precio_carta, ingredientes } = {}) {
  if (!nombre || !nombre.trim()) throw new Error('nombre es obligatorio');
  if (!Array.isArray(ingredientes) || !ingredientes.length) throw new Error('Se requiere al menos un ingrediente');

  const filas = ingredientes.map(i => {
    const cantidad = Number(i.cantidad);
    const unidad = normalizarUnidad(i.unidad);
    if (!i.ingrediente || !String(i.ingrediente).trim()) throw new Error('Cada ingrediente necesita nombre');
    if (!Number.isFinite(cantidad) || cantidad <= 0) throw new Error(`Cantidad inválida para "${i.ingrediente}"`);
    if (!unidad) throw new Error(`Unidad inválida para "${i.ingrediente}"`);
    return {
      ingrediente: String(i.ingrediente).trim(),
      ingrediente_norm: normalizarTextoProducto(i.ingrediente),
      cantidad, unidad,
    };
  });

  const precioCarta = (precio_carta !== undefined && precio_carta !== null && precio_carta !== '')
    ? Number(precio_carta) : null;

  const { data: platoId, error } = await supabase.rpc('confirmar_escandallo', {
    p_cliente: cliente,
    p_nombre: nombre.trim(),
    p_nombre_norm: normalizarTextoProducto(nombre),
    p_precio_carta: precioCarta,
    p_ingredientes: filas,
  });
  if (error) throw new Error(`Supabase (confirmar escandallo): ${error.message}`);

  return { plato_id: platoId };
}

// Edición ligera de metadatos (nombre, precio_carta, activo) — reemplazar
// los ingredientes de un plato va siempre por confirmarEscandallo(), tanto
// desde "Nuevo plato con foto" como desde el panel de edición del listado.
async function actualizarPlato(cliente, platoId, { nombre, precio_carta, activo } = {}) {
  const updates = {};
  if (nombre !== undefined) {
    if (!nombre || !nombre.trim()) throw new Error('nombre no puede quedar vacío');
    updates.nombre = nombre.trim();
    updates.nombre_norm = normalizarTextoProducto(nombre);
  }
  if (precio_carta !== undefined) updates.precio_carta = (precio_carta === null || precio_carta === '') ? null : Number(precio_carta);
  if (activo !== undefined) updates.activo = !!activo;
  if (!Object.keys(updates).length) throw new Error('Nada que actualizar');

  const { data, error } = await supabase
    .from('platos').update(updates).eq('cliente', cliente).eq('id', platoId).select().maybeSingle();
  if (error) throw new Error(`platos: ${error.message}`);
  if (!data) throw new Error('Plato no encontrado');
  return data;
}

// escandallo y plato_alias caen en cascada (on delete cascade, migración 042).
async function borrarPlato(cliente, platoId) {
  const { error } = await supabase.from('platos').delete().eq('cliente', cliente).eq('id', platoId);
  if (error) throw new Error(`platos: ${error.message}`);
}

// ── Coste estimado y margen ──────────────────────────────────────────────
// Precios pactados VIGENTES de todos los proveedores del cliente, agrupados
// por producto normalizado — un ingrediente puede coincidir con más de un
// proveedor; costeLinea() se queda con el más barato que sea convertible a
// la unidad del escandallo.
async function preciosPactadosVigentes(cliente) {
  const { data: tarifas, error } = await supabase
    .from('tarifas')
    .select('id, tarifa_productos(producto, unidad, precio)')
    .eq('cliente', cliente)
    .is('vigente_hasta', null);
  if (error) throw new Error(`tarifas: ${error.message}`);

  const porProducto = new Map();
  for (const t of tarifas) {
    for (const p of (t.tarifa_productos || [])) {
      const norm = normalizarTextoProducto(p.producto);
      if (!norm) continue;
      if (!porProducto.has(norm)) porProducto.set(norm, []);
      porProducto.get(norm).push({ unidad: normalizarUnidad(p.unidad), precio: Number(p.precio) });
    }
  }
  return porProducto;
}

// Último precio_unitario facturado por producto normalizado (con su
// unidad) — mismo espíritu que backend/lib/inventario.js, pero solo el más
// reciente en vez de todo el histórico.
async function ultimosPreciosFacturados(cliente) {
  const tablaFacturas = `${cliente}_facturas`;
  const tablaLineas = `${cliente}_factura_lineas`;

  const { data: facturas, error: errF } = await supabase
    .from(tablaFacturas).select('id, fecha_factura').not('fecha_factura', 'is', null);
  if (errF) throw new Error(`${tablaFacturas}: ${errF.message}`);
  if (!facturas.length) return new Map();
  const fechaPorFactura = new Map(facturas.map(f => [f.id, f.fecha_factura]));

  const { data: lineas, error: errL } = await supabase
    .from(tablaLineas).select('factura_id, producto, unidad, precio_unitario')
    .in('factura_id', facturas.map(f => f.id))
    .not('producto', 'is', null)
    .not('precio_unitario', 'is', null);
  if (errL) throw new Error(`${tablaLineas}: ${errL.message}`);

  const porProducto = new Map();
  for (const l of lineas) {
    const norm = normalizarTextoProducto(l.producto);
    if (!norm) continue;
    const fecha = fechaPorFactura.get(l.factura_id);
    const actual = porProducto.get(norm);
    if (!actual || fecha > actual.fecha) {
      porProducto.set(norm, { fecha, unidad: normalizarUnidad(l.unidad), precio: Number(l.precio_unitario) });
    }
  }
  return porProducto;
}

// Coste de una línea de escandallo: precio pactado (el más barato entre
// proveedores que convierta a la unidad del escandallo) si hay; si no, el
// último precio facturado convertido; si no, sin_precio (coste null).
function costeLinea({ ingrediente_norm, cantidad, unidad }, preciosTarifa, preciosCompra) {
  const candidatosTarifa = preciosTarifa.get(ingrediente_norm) || [];
  let mejorCoste = null;
  for (const c of candidatosTarifa) {
    const cantidadEnUnidadTarifa = convertirUnidad(Number(cantidad), unidad, c.unidad);
    if (cantidadEnUnidadTarifa == null) continue;
    const coste = cantidadEnUnidadTarifa * c.precio;
    if (mejorCoste == null || coste < mejorCoste) mejorCoste = coste;
  }
  if (mejorCoste != null) return { coste: mejorCoste, origen: 'tarifa' };

  const ultimaCompra = preciosCompra.get(ingrediente_norm);
  if (ultimaCompra) {
    const cantidadEnUnidadCompra = convertirUnidad(Number(cantidad), unidad, ultimaCompra.unidad);
    if (cantidadEnUnidadCompra != null) return { coste: cantidadEnUnidadCompra * ultimaCompra.precio, origen: 'ultima_compra' };
  }

  return { coste: null, origen: 'sin_precio' };
}

// GET /escandallo: platos con nº de ingredientes, precio de carta, coste
// estimado y margen. estado_coste: 'completo' (todos los ingredientes con
// precio), 'parcial' (alguno sin precio) o 'sin_precio' (ninguno).
async function listarEscandallo(cliente) {
  const { data: platos, error: errP } = await supabase
    .from('platos').select('id, nombre, precio_carta, activo, created_at')
    .eq('cliente', cliente).eq('activo', true)
    .order('nombre');
  if (errP) throw new Error(`platos: ${errP.message}`);
  if (!platos.length) return [];

  const { data: lineas, error: errE } = await supabase
    .from('escandallo').select('plato_id, ingrediente, ingrediente_norm, cantidad, unidad')
    .in('plato_id', platos.map(p => p.id));
  if (errE) throw new Error(`escandallo: ${errE.message}`);

  const [preciosTarifa, preciosCompra] = await Promise.all([
    preciosPactadosVigentes(cliente),
    ultimosPreciosFacturados(cliente),
  ]);

  const lineasPorPlato = new Map();
  for (const l of lineas) {
    if (!lineasPorPlato.has(l.plato_id)) lineasPorPlato.set(l.plato_id, []);
    lineasPorPlato.get(l.plato_id).push(l);
  }

  return platos.map(p => {
    const ingredientes = lineasPorPlato.get(p.id) || [];
    let costeTotal = 0;
    let algunoConPrecio = false;
    let todosConPrecio = true;

    const detalle = ingredientes.map(ing => {
      const { coste, origen } = costeLinea(ing, preciosTarifa, preciosCompra);
      if (coste != null) { costeTotal += coste; algunoConPrecio = true; } else { todosConPrecio = false; }
      return { ingrediente: ing.ingrediente, cantidad: Number(ing.cantidad), unidad: ing.unidad, coste, origen };
    });

    const estado_coste = !algunoConPrecio ? 'sin_precio' : (todosConPrecio ? 'completo' : 'parcial');
    const coste_estimado = algunoConPrecio ? Number(costeTotal.toFixed(4)) : null;
    const precioCarta = p.precio_carta != null ? Number(p.precio_carta) : null;
    const margen_eur = (precioCarta != null && coste_estimado != null) ? Number((precioCarta - coste_estimado).toFixed(2)) : null;
    const margen_pct = (margen_eur != null && precioCarta > 0) ? Number(((margen_eur / precioCarta) * 100).toFixed(1)) : null;

    return {
      id: p.id, nombre: p.nombre, precio_carta: precioCarta,
      num_ingredientes: ingredientes.length,
      ingredientes: detalle,
      coste_estimado, estado_coste, margen_eur, margen_pct,
    };
  });
}

module.exports = {
  proponerEscandallo, confirmarEscandallo, actualizarPlato, borrarPlato, listarEscandallo,
};
