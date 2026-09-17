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

const VENTA_PROMPT = 'Esto es el cierre de caja de un restaurante (informe Z y/o informe de ventas por artículo). '
  + 'fecha en YYYY-MM-DD: si hay varias fechas visibles, usa la del cierre/turno, no la de impresión del ticket. '
  + 'desglose_pago con los importes por forma de pago tal como aparezcan: efectivo, tarjeta, y suma en "otros" '
  + 'cualquier forma de pago que no sea efectivo ni tarjeta (bizum, vales, etc.). '
  + 'En "lineas" desglosa cada artículo vendido: producto (nombre tal cual), cantidad, importe (total de ese '
  + 'artículo, no el precio unitario) y familia si el documento la indica. '
  + 'Si el documento solo trae totales por familia y no por artículo, devuelve las familias como líneas '
  + '(producto = nombre de la familia) y marca detalle_por_articulo: false. '
  + 'Si hay varias imágenes o páginas, trátalas como partes del MISMO cierre — no dupliques una línea que '
  + 'aparezca en más de una página/imagen. '
  + 'Cualquier dato que no puedas leer con confianza anótalo en "dudas" en vez de inventarlo.';

// Extrae un cierre de caja a partir de una o varias imágenes/PDF (todas del
// mismo día). Devuelve el JSON tal cual lo entrega el modelo — es una
// VISTA PREVIA, nada se guarda aquí.
async function extraerVentaDiaria(archivos) {
  const fileBlocks = archivos.map(a => buildFileBlock(a.buffer, a.mimeType));
  return extraerJson({
    maxTokens: 4096,
    schema: VENTA_SCHEMA,
    content: [...fileBlocks, { type: 'text', text: VENTA_PROMPT }],
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

module.exports = { extraerVentaDiaria, guardarVentaDiaria };
