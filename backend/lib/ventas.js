// Ventas diarias (cierre de caja) — compartido por Timbol, Comarea y
// cualquier cliente futuro (mismo patrón multi-cliente que tarifas.js:
// tablas únicas + columna `cliente`). La entrada por foto vive aquí; la
// interfaz de TPV (backend/lib/pos/) reutiliza guardarVentaDiaria() para
// que el guardado sea idéntico venga de donde venga el dato.
const { supabase } = require('./supabase');
const { buildFileBlock, extraerJson } = require('./claude-json');
const { normalizarTextoProducto } = require('./tarifas');

// ── Extracción por foto ──────────────────────────────────────────────────

const VENTA_LINEA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    producto: { type: 'string' },
    cantidad: { type: ['number', 'null'] },
    importe:  { type: ['number', 'null'] },
    familia:  { type: ['string', 'null'] },
  },
  required: ['producto', 'cantidad', 'importe', 'familia'],
};

const VENTA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fecha:        { type: ['string', 'null'], description: 'Fecha del cierre en YYYY-MM-DD' },
    total_bruto:  { type: ['number', 'null'] },
    total_neto:   { type: ['number', 'null'] },
    num_tickets:  { type: ['number', 'null'] },
    desglose_pago: {
      type: 'object',
      additionalProperties: false,
      properties: {
        efectivo: { type: ['number', 'null'] },
        tarjeta:  { type: ['number', 'null'] },
        otros:    { type: ['number', 'null'] },
      },
      required: ['efectivo', 'tarjeta', 'otros'],
    },
    detalle_por_articulo: { type: 'boolean', description: 'false si el documento solo trae totales por familia, no por artículo' },
    lineas: {
      type: 'array',
      description: 'Un artículo (o familia si detalle_por_articulo=false) por línea',
      items: VENTA_LINEA_SCHEMA,
    },
    dudas: {
      type: 'array',
      description: 'Datos que no se puedan leer con confianza — nunca inventarlos',
      items: { type: 'string' },
    },
  },
  required: ['fecha', 'total_bruto', 'total_neto', 'num_tickets', 'desglose_pago',
    'detalle_por_articulo', 'lineas', 'dudas'],
};

const VENTA_PROMPT_BASE = 'Esto es el cierre de caja de un restaurante (informe Z y/o informe de ventas por artículo). '
  + 'fecha en YYYY-MM-DD: si hay varias fechas visibles, usa la del cierre/turno, no la de impresión del ticket. '
  + 'desglose_pago con los importes por forma de pago tal como aparezcan: efectivo, tarjeta, y suma en "otros" '
  + 'cualquier forma de pago que no sea efectivo ni tarjeta (bizum, vales, etc.). '
  + 'En "lineas" desglosa cada artículo vendido: producto (nombre tal cual), cantidad, importe (total de ese '
  + 'artículo, no el precio unitario) y familia si el documento la indica. '
  + 'Si el documento solo trae totales por familia y no por artículo, devuelve las familias como líneas '
  + '(producto = nombre de la familia) y marca detalle_por_articulo: false. '
  + 'Cualquier dato que no puedas leer con confianza anótalo en "dudas" en vez de inventarlo.';

// Un ticket térmico largo llega como varias fotos consecutivas (ver
// frontend/pages/ventas-shared.js: captura secuencial de arriba abajo, con
// solape deliberado entre una foto y la siguiente para no perder líneas en
// el corte). Solo se añade cuando llega más de una imagen — con una sola
// imagen no hay nada que reconstruir ni tramos que puedan faltar.
const ventaPromptMultiImagen = (n) => `Estas ${n} imágenes son segmentos consecutivos de UN ÚNICO ticket de `
  + 'cierre de caja, fotografiado de arriba abajo en este orden. Las imágenes pueden solaparse: si las últimas '
  + 'líneas de una imagen aparecen también al principio de la siguiente, son las mismas líneas y deben contarse '
  + 'una sola vez. Reconstruye el documento completo antes de extraer. Si detectas que falta un tramo (por '
  + 'ejemplo, el total final no aparece en ninguna imagen), indícalo en dudas con el motivo "posible tramo '
  + 'faltante".';

// Extrae un cierre de caja a partir de una o varias imágenes/PDF (todas del
// mismo día). Devuelve el JSON tal cual lo entrega el modelo — es una
// VISTA PREVIA, nada se guarda aquí.
//
// El orden de `archivos` se respeta tal cual llega del frontend (arriba
// abajo del ticket) — nunca se reordena, ni aquí ni al construir los
// bloques de contenido: el modelo necesita ese orden para reconstruir el
// documento y detectar el solape entre fotos consecutivas.
async function extraerVentaDiaria(archivos) {
  const fileBlocks = archivos.map(a => buildFileBlock(a.buffer, a.mimeType));
  const prompt = archivos.length > 1
    ? `${ventaPromptMultiImagen(archivos.length)}\n\n${VENTA_PROMPT_BASE}`
    : VENTA_PROMPT_BASE;
  return extraerJson({
    maxTokens: 4096,
    schema: VENTA_SCHEMA,
    content: [...fileBlocks, { type: 'text', text: prompt }],
    mensajeError: 'La IA devolvió una respuesta incompleta al leer el cierre de caja. Vuelve a intentar la subida.',
  });
}

// ── Persistencia ─────────────────────────────────────────────────────────

// Guarda un cierre diario ya revisado por el usuario (o venido del cron de
// TPV — ver backend/lib/pos/). Un cierre por (cliente, fecha): si ya había
// uno, se archiva en ventas_diarias_historico (nunca se borra sin rastro)
// antes de reemplazarlo. Usado tanto por POST /ventas/confirmar como por
// el cron de sincronización de TPV, para que el guardado sea idéntico
// venga la venta de una foto o de una API.
async function guardarVentaDiaria(cliente, venta) {
  if (!venta.fecha) throw new Error('Falta la fecha del cierre');

  const { data: existente, error: errBuscar } = await supabase
    .from('ventas_diarias').select('*')
    .eq('cliente', cliente).eq('fecha', venta.fecha).maybeSingle();
  if (errBuscar) throw new Error(`Supabase (buscar cierre existente): ${errBuscar.message}`);

  if (existente) {
    const { error: errHist } = await supabase.from('ventas_diarias_historico').insert({
      venta_id_original:    existente.id,
      cliente:              existente.cliente,
      fecha:                existente.fecha,
      total_bruto:          existente.total_bruto,
      total_neto:           existente.total_neto,
      num_tickets:          existente.num_tickets,
      desglose_pago:        existente.desglose_pago,
      origen:               existente.origen,
      origen_ref:           existente.origen_ref,
      detalle_por_articulo: existente.detalle_por_articulo,
      created_at:           existente.created_at,
    });
    if (errHist) throw new Error(`Supabase (archivar cierre anterior): ${errHist.message}`);

    // El delete se lleva por cascade las líneas del cierre anterior; el
    // cierre en sí ya quedó a salvo en el histórico justo arriba.
    const { error: errDel } = await supabase.from('ventas_diarias').delete().eq('id', existente.id);
    if (errDel) throw new Error(`Supabase (sustituir cierre anterior): ${errDel.message}`);
  }

  const { data: saved, error: errInsert } = await supabase
    .from('ventas_diarias')
    .insert({
      cliente,
      fecha:                venta.fecha,
      total_bruto:          venta.total_bruto ?? null,
      total_neto:           venta.total_neto ?? null,
      num_tickets:          venta.num_tickets ?? null,
      desglose_pago:        venta.desglose_pago || {},
      origen:               venta.origen,
      origen_ref:           venta.origen_ref || null,
      detalle_por_articulo: venta.detalle_por_articulo !== false,
    })
    .select().single();
  if (errInsert) throw new Error(`Supabase (guardar cierre): ${errInsert.message}`);

  const lineas = (Array.isArray(venta.lineas) ? venta.lineas : []).map(l => ({
    venta_id:      saved.id,
    cliente,
    producto:      l.producto ?? null,
    producto_norm: l.producto ? normalizarTextoProducto(l.producto) : null,
    cantidad:      l.cantidad ?? null,
    importe:       l.importe ?? null,
    familia:       l.familia ?? null,
  }));
  if (lineas.length) {
    const { error: errLineas } = await supabase.from('ventas_lineas').insert(lineas);
    if (errLineas) throw new Error(`Supabase (guardar líneas de venta): ${errLineas.message}`);
  }

  return { ...saved, lineas };
}

// ── Analytics fase 1 ─────────────────────────────────────────────────────

// Food cost diario y acumulado a partir de compras (ya filtradas a tipo
// factura/ticket, sin albaranes) y ventas netas, ambos agregados por
// fecha. Pura — sin Supabase — para no duplicar esta aritmética entre
// Timbol y Comarea, que sí necesitan cada uno su propio fetch porque las
// tablas de facturas se llaman distinto por cliente.
function calcularFoodcost(comprasPorFecha, ventasPorFecha, fechas) {
  const dias = fechas.map(fecha => {
    const compras = comprasPorFecha.get(fecha) || 0;
    const ventasNeto = ventasPorFecha.get(fecha) || 0;
    const foodcostPct = ventasNeto > 0 ? Number(((compras / ventasNeto) * 100).toFixed(2)) : null;
    return { fecha, compras, ventas_neto: ventasNeto, foodcost_pct: foodcostPct };
  });

  for (let i = 0; i < dias.length; i++) {
    const ventana = dias.slice(Math.max(0, i - 6), i + 1).map(d => d.foodcost_pct).filter(v => v != null);
    dias[i].media_movil_7d = ventana.length
      ? Number((ventana.reduce((s, v) => s + v, 0) / ventana.length).toFixed(2)) : null;
  }

  const totalCompras = dias.reduce((s, d) => s + d.compras, 0);
  const totalVentas = dias.reduce((s, d) => s + d.ventas_neto, 0);
  const acumuladoPct = totalVentas > 0 ? Number(((totalCompras / totalVentas) * 100).toFixed(2)) : null;

  return { dias, acumulado: { compras: totalCompras, ventas_neto: totalVentas, foodcost_pct: acumuladoPct } };
}

module.exports = { extraerVentaDiaria, guardarVentaDiaria, calcularFoodcost };
