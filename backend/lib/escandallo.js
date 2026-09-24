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
const {
  normalizarTextoProducto, normalizarUnidad, convertirUnidad,
  contarPaginasPdf, trocearPdf, extraerTamanoEnvase,
} = require('./tarifas');
const { parsearArchivoTabular, construirBloques, filasATexto } = require('./archivo-tabular');

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
      // `producto` (el nombre tal cual) se conserva para detectar si el
      // precio es en realidad de un envase/caja (ver precioFiableParaUnidad)
      // aunque la unidad guardada no lo refleje.
      porProducto.get(norm).push({ producto: p.producto, unidad: normalizarUnidad(p.unidad), precio: Number(p.precio) });
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
      porProducto.set(norm, { producto: l.producto, fecha, unidad: normalizarUnidad(l.unidad), precio: Number(l.precio_unitario) });
    }
  }
  return porProducto;
}

// Un precio de tarifa/factura NO es fiable para una receta en peso o
// volumen (g, kg, ml, l) si el nombre del producto menciona un envase o
// caja (70CL, PET, LATA, CAJA 12...) — puede ser el precio de un envase
// entero mal etiquetado como €/g o €/ml (unidad desactualizada, o el
// detector de envases de tarifas.js no llegó a corregirlo en su momento).
// Sin este filtro, un fallo así puede disparar el coste estimado muy por
// encima del precio de carta. En 'ud' no aplica: ahí sí tiene sentido
// pagar por envase.
function precioFiableParaUnidad(nombreProducto, unidadReceta) {
  const esPesoOVolumen = ['g', 'kg', 'ml', 'l'].includes(unidadReceta);
  if (!esPesoOVolumen) return true;
  return !extraerTamanoEnvase(nombreProducto);
}

// Coste de una línea de escandallo: precio pactado (el más barato entre
// proveedores que convierta a la unidad del escandallo) si hay; si no, el
// último precio facturado convertido; si no, sin_precio (coste null).
// SIEMPRE convierte la cantidad de la receta a la unidad del precio ANTES
// de multiplicar (convertirUnidad) — si no son compatibles (ud vs kg, por
// ejemplo) o el precio parece ser de un envase que no encaja con la unidad
// de la receta, la línea queda sin_precio: nunca se multiplica en crudo.
function costeLinea({ ingrediente_norm, cantidad, unidad }, preciosTarifa, preciosCompra) {
  const candidatosTarifa = (preciosTarifa.get(ingrediente_norm) || [])
    .filter(c => precioFiableParaUnidad(c.producto, unidad));

  let mejor = null;
  for (const c of candidatosTarifa) {
    const cantidadEnUnidadTarifa = convertirUnidad(Number(cantidad), unidad, c.unidad);
    if (cantidadEnUnidadTarifa == null) continue; // no convertible: no se suma, ni se intenta
    const coste = cantidadEnUnidadTarifa * c.precio;
    if (!mejor || coste < mejor.coste) mejor = { coste, precio_usado: c.precio, precio_unidad: c.unidad };
  }
  if (mejor) return { ...mejor, origen: 'tarifa' };

  const ultimaCompra = preciosCompra.get(ingrediente_norm);
  if (ultimaCompra && precioFiableParaUnidad(ultimaCompra.producto, unidad)) {
    const cantidadEnUnidadCompra = convertirUnidad(Number(cantidad), unidad, ultimaCompra.unidad);
    if (cantidadEnUnidadCompra != null) {
      return {
        coste: cantidadEnUnidadCompra * ultimaCompra.precio, origen: 'ultima_compra',
        precio_usado: ultimaCompra.precio, precio_unidad: ultimaCompra.unidad,
      };
    }
  }

  return { coste: null, origen: 'sin_precio', precio_usado: null, precio_unidad: null };
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
      const { coste, origen, precio_usado, precio_unidad } = costeLinea(ing, preciosTarifa, preciosCompra);
      if (coste != null) { costeTotal += coste; algunoConPrecio = true; } else { todosConPrecio = false; }
      return {
        ingrediente: ing.ingrediente, cantidad: Number(ing.cantidad), unidad: ing.unidad,
        coste: coste != null ? Number(coste.toFixed(4)) : null, origen,
        precio_usado, precio_unidad,
      };
    });

    const estado_coste = !algunoConPrecio ? 'sin_precio' : (todosConPrecio ? 'completo' : 'parcial');
    const coste_estimado = algunoConPrecio ? Number(costeTotal.toFixed(4)) : null;
    const precioCarta = p.precio_carta != null ? Number(p.precio_carta) : null;
    const margen_eur = (precioCarta != null && coste_estimado != null) ? Number((precioCarta - coste_estimado).toFixed(2)) : null;
    const margen_pct = (margen_eur != null && precioCarta > 0) ? Number(((margen_eur / precioCarta) * 100).toFixed(1)) : null;
    // Coste por encima del precio de carta casi siempre es un problema de
    // unidades (receta y precio no compatibles, envase mal etiquetado...),
    // no que el plato realmente pierda dinero así de mal — se marca para
    // que salte a la vista en vez de perderse entre los demás platos.
    const alerta_unidades = coste_estimado != null && precioCarta != null && coste_estimado > precioCarta;

    return {
      id: p.id, nombre: p.nombre, precio_carta: precioCarta,
      num_ingredientes: ingredientes.length,
      ingredientes: detalle,
      coste_estimado, estado_coste, margen_eur, margen_pct, alerta_unidades,
    };
  });
}

// ── Importación desde Excel ──────────────────────────────────────────────
// Plantilla con dos hojas: "Platos" (nombre, precio_carta) y "Escandallo"
// (plato, ingrediente, cantidad, unidad). Un CSV solo trae una hoja sin
// nombre — se trata como "Escandallo" sola, sin precio de carta.
const PLATO_IMPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    platos: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { nombre: { type: 'string' }, precio_carta: { type: ['number', 'null'] } },
        required: ['nombre', 'precio_carta'],
      },
    },
    dudas: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { fila: { type: 'string' }, motivo: { type: 'string' } },
        required: ['fila', 'motivo'],
      },
    },
  },
  required: ['platos', 'dudas'],
};

const PLATO_IMPORT_PROMPT = 'Esta es la hoja "Platos" de una plantilla de escandallo, en formato libre. '
  + 'Devuelve SOLO un JSON: { platos: [{ nombre, precio_carta }], dudas: [{ fila, motivo }] }\n'
  + '- Detecta tú la fila de cabecera; puede no ser la primera.\n'
  + '- precio_carta en EUR, o null si no aparece.\n'
  + '- Cualquier fila que no puedas interpretar va a dudas, no la inventes.';

const ESCANDALLO_IMPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lineas: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          plato:       { type: 'string' },
          ingrediente: { type: 'string' },
          cantidad:    { type: 'number' },
          unidad:      { type: 'string', description: 'kg | g | l | ml | ud | caja | pack | docena' },
        },
        required: ['plato', 'ingrediente', 'cantidad', 'unidad'],
      },
    },
    dudas: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { fila: { type: 'string' }, motivo: { type: 'string' } },
        required: ['fila', 'motivo'],
      },
    },
  },
  required: ['lineas', 'dudas'],
};

const ESCANDALLO_IMPORT_PROMPT = 'Esta es la hoja "Escandallo" de una plantilla de recetas de un restaurante, '
  + 'en formato libre: cada fila es un ingrediente de un plato. Devuelve SOLO un JSON: '
  + '{ lineas: [{ plato, ingrediente, cantidad, unidad }], dudas: [{ fila, motivo }] }\n'
  + '- Detecta tú la fila de cabecera; puede no ser la primera.\n'
  + '- plato es el nombre del plato al que pertenece esa línea (puede repetirse en varias filas seguidas).\n'
  + '- Normaliza unidad a: kg, g, l, ml, ud, caja, pack, docena.\n'
  + '- Cualquier fila que no puedas interpretar va a dudas, no la inventes.';

async function extraerBloquePlatos(textoTabular) {
  return extraerJson({
    maxTokens: 2048,
    schema: PLATO_IMPORT_SCHEMA,
    content: [{ type: 'text', text: `${PLATO_IMPORT_PROMPT}\n\n${textoTabular}` }],
    mensajeError: 'La IA devolvió una respuesta incompleta al leer la hoja de Platos.',
  });
}

async function extraerBloqueEscandallo(textoTabular) {
  return extraerJson({
    maxTokens: 4096,
    schema: ESCANDALLO_IMPORT_SCHEMA,
    content: [{ type: 'text', text: `${ESCANDALLO_IMPORT_PROMPT}\n\n${textoTabular}` }],
    mensajeError: 'La IA devolvió una respuesta incompleta al leer la hoja de Escandallo.',
  });
}

// ── Importación desde PDF/foto de una receta escrita ─────────────────────
// No es una plantilla tabular (sin hojas "Platos"/"Escandallo"): una foto o
// PDF de una receta a mano o a máquina. Mismo esquema que la hoja
// "Escandallo" (lineas: plato/ingrediente/cantidad/unidad + dudas) — así la
// agrupación por plato al final es una sola implementación para las dos
// vías. precio_carta no sale de aquí, se completa a mano en la vista
// previa como cualquier plato sin precio de carta detectado.
const RECETA_IMPORT_PROMPT = 'Esto es una foto o documento de una receta de un restaurante, escrita a mano o a '
  + 'máquina (no una hoja de cálculo). Devuelve SOLO un JSON: '
  + '{ lineas: [{ plato, ingrediente, cantidad, unidad }], dudas: [{ fila, motivo }] }\n'
  + '- plato es el nombre del plato de la receta; si el documento tiene varias recetas, usa el nombre de cada una '
  + 'para las líneas que le correspondan.\n'
  + '- ingrediente, cantidad y unidad tal como aparecen en la receta — no inventes una cantidad que no esté escrita.\n'
  + '- Normaliza unidad a: kg, g, l, ml, ud, caja, pack, docena.\n'
  + '- Ignora lo que no sea ingredientes (pasos de preparación, tiempos, temperatura de horno, notas de emplatado...).\n'
  + '- Cualquier línea que no puedas interpretar va a dudas, no la inventes.';

async function extraerBloqueReceta(fileBlock) {
  return extraerJson({
    maxTokens: 4096,
    schema: ESCANDALLO_IMPORT_SCHEMA,
    content: [fileBlock, { type: 'text', text: RECETA_IMPORT_PROMPT }],
    mensajeError: 'La IA devolvió una respuesta incompleta al leer la receta.',
  });
}

// Igual que el trociado de PDFs largos en tarifas.js: hasta este nº de
// páginas, todo en una llamada; más allá, grupos de 5. A diferencia de una
// tarifa (un proveedor, cabecera solo en la página 1), un PDF de recetas
// puede traer varias recetas distintas por página, así que no se arrastra
// contexto de un grupo al siguiente — cada uno se lee independiente y se
// concatenan los resultados.
const PDF_MAX_PAGINAS_SIN_TROCEAR = 6;
const PDF_PAGINAS_POR_GRUPO = 5;

async function extraerLineasDePdf(buffer, { onProgreso } = {}) {
  const totalPaginas = await contarPaginasPdf(buffer);
  const lineas = [];
  const dudas = [];

  const grupos = totalPaginas <= PDF_MAX_PAGINAS_SIN_TROCEAR
    ? [{ buffer, desde: 1, hasta: totalPaginas }]
    : await trocearPdf(buffer, PDF_PAGINAS_POR_GRUPO);

  for (const grupo of grupos) {
    if (onProgreso) {
      onProgreso(grupos.length > 1
        ? `Leyendo páginas ${grupo.desde}-${grupo.hasta} de ${totalPaginas}`
        : `Leyendo ${totalPaginas} página${totalPaginas !== 1 ? 's' : ''}…`);
    }
    const { data } = await extraerBloqueReceta(buildFileBlock(grupo.buffer, 'application/pdf'));
    for (const l of (data.lineas || [])) lineas.push(l);
    for (const d of (data.dudas || [])) dudas.push({ ...d, hoja: 'Receta' });
  }

  return { lineas, dudas };
}

async function extraerLineasDeImagen(buffer, mimeType) {
  const { data } = await extraerBloqueReceta(buildFileBlock(buffer, mimeType));
  return {
    lineas: data.lineas || [],
    dudas: (data.dudas || []).map(d => ({ ...d, hoja: 'Receta' })),
  };
}

// Agrupa las líneas ya extraídas (de la hoja "Escandallo", de un PDF o de
// una foto de receta — mismo shape en los tres casos) por nombre de plato
// normalizado, con el precio_carta de `platosInfo` si coincide (vacío en
// PDF/foto, que no tienen hoja "Platos" — el plato sale igual, sin precio,
// para completarlo a mano).
function agruparLineasEscandallo(lineasInfo, platosInfo, dudas) {
  const precioCartaPorNorm = new Map(platosInfo.map(p => [normalizarTextoProducto(p.nombre), p.precio_carta]));

  const grupos = new Map(); // nombre_norm -> { nombre, precio_carta, ingredientes }
  for (const l of lineasInfo) {
    const norm = normalizarTextoProducto(l.plato);
    if (!norm) { dudas.push({ fila: JSON.stringify(l), motivo: 'Fila de escandallo sin nombre de plato', hoja: 'Escandallo' }); continue; }
    if (!grupos.has(norm)) {
      grupos.set(norm, {
        nombre: l.plato,
        precio_carta: precioCartaPorNorm.has(norm) ? precioCartaPorNorm.get(norm) : null,
        ingredientes: [],
      });
    }
    grupos.get(norm).ingredientes.push({
      ingrediente: l.ingrediente,
      cantidad: l.cantidad,
      unidad: normalizarUnidad(l.unidad) || l.unidad,
    });
  }

  // Platos de la hoja "Platos" sin ninguna línea en "Escandallo" — se
  // muestran igual, vacíos, para completarlos a mano en vez de que
  // desaparezcan en silencio.
  for (const p of platosInfo) {
    const norm = normalizarTextoProducto(p.nombre);
    if (!grupos.has(norm)) grupos.set(norm, { nombre: p.nombre, precio_carta: p.precio_carta, ingredientes: [] });
  }

  return [...grupos.values()];
}

// `mimeType` decide la vía: xlsx/csv (plantilla de dos hojas, como
// siempre), PDF (una llamada si tiene pocas páginas, trociado si no) o
// imagen (una foto de una receta = un plato, como una foto de cierre de
// caja). `onProgreso(mensaje)` es opcional — solo lo usa el trociado de
// PDFs largos.
async function extraerEscandallosDeArchivo(buffer, filename, mimeType, { onProgreso } = {}) {
  const ext = (filename || '').toLowerCase().split('.').pop();
  const esPdf = mimeType === 'application/pdf' || ext === 'pdf';
  const esImagen = (mimeType && mimeType.startsWith('image/')) || ['jpg', 'jpeg', 'png'].includes(ext);

  const platosInfo = [];
  let lineasInfo = [];
  let dudas = [];

  if (esPdf) {
    const r = await extraerLineasDePdf(buffer, { onProgreso });
    lineasInfo = r.lineas; dudas = r.dudas;
  } else if (esImagen) {
    const r = await extraerLineasDeImagen(buffer, mimeType || (ext === 'png' ? 'image/png' : 'image/jpeg'));
    lineasInfo = r.lineas; dudas = r.dudas;
  } else {
    const hojas = await parsearArchivoTabular(buffer, filename);
    for (const hoja of hojas) {
      const esHojaPlatos = !!(hoja.hoja && /platos/i.test(hoja.hoja));
      for (const bloque of construirBloques(hoja.filas)) {
        const texto = filasATexto(bloque);
        if (esHojaPlatos) {
          const { data } = await extraerBloquePlatos(texto);
          for (const p of (data.platos || [])) platosInfo.push(p);
          for (const d of (data.dudas || [])) dudas.push({ ...d, hoja: hoja.hoja });
        } else {
          const { data } = await extraerBloqueEscandallo(texto);
          for (const l of (data.lineas || [])) lineasInfo.push(l);
          for (const d of (data.dudas || [])) dudas.push({ ...d, hoja: hoja.hoja || 'Escandallo' });
        }
      }
    }
  }

  return { platos: agruparLineasEscandallo(lineasInfo, platosInfo, dudas), dudas };
}

module.exports = {
  proponerEscandallo, confirmarEscandallo, actualizarPlato, borrarPlato,
  listarEscandallo, extraerEscandallosDeArchivo,
};
