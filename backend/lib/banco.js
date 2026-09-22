'use strict';
// Extractos bancarios: ingesta (xlsx/csv en formato libre → Claude → vista
// previa → confirmar) y conciliación automática contra facturas y ventas.
// Mismo espíritu que tarifas.js: funciones puras + consultas, sin router
// (eso vive en backend/api/banco.js), para poder testear sin mockear medio
// Express.
const { supabase } = require('./supabase');
const { extraerJson } = require('./claude-json');
const { normalizarTextoProducto, primerDiaSiguienteMes } = require('./tarifas');
const { parsearArchivoTabular, construirBloques, filasATexto } = require('./archivo-tabular');

function offsetDias(iso, dias) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// ── Ingesta ──────────────────────────────────────────────────────────────
// Vista previa: sube xlsx/csv → texto tabular por hoja (archivo-tabular.js)
// → Claude normaliza por bloques de 150 filas. Nada se guarda hasta
// /banco/confirmar. Cada banco exporta distinto (columnas en cualquier
// orden, con o sin cabecera, fecha en cualquier formato) — por eso esto es
// un prompt libre y no un parser de columnas fijas.
const EXTRACTO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    movimientos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fecha:    { type: 'string', description: 'YYYY-MM-DD' },
          concepto: { type: 'string' },
          importe:  { type: 'number', description: 'negativo para cargos/gastos, positivo para ingresos' },
          saldo:    { type: ['number', 'null'], description: 'saldo de la cuenta tras el movimiento, o null si el extracto no lo trae' },
        },
        required: ['fecha', 'concepto', 'importe', 'saldo'],
      },
    },
    dudas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fila:   { type: 'string', description: 'Contenido literal de la fila que no se pudo interpretar' },
          motivo: { type: 'string' },
        },
        required: ['fila', 'motivo'],
      },
    },
  },
  required: ['movimientos', 'dudas'],
};

const EXTRACTO_PROMPT = `Este es un extracto bancario en formato libre (cada banco exporta de forma
distinta: columnas en cualquier orden, con o sin cabecera, fecha en
cualquier formato). Devuelve SOLO un JSON:
{ movimientos: [{ fecha, concepto, importe, saldo }], dudas: [{ fila, motivo }] }
Reglas:
- Detecta tú la fila de cabecera; puede no ser la primera.
- fecha en formato ISO (YYYY-MM-DD), sea cual sea el formato original.
- importe: negativo para cargos/gastos, positivo para ingresos — SIEMPRE con
  ese signo, sea cual sea el signo o el color del archivo original (algunos
  bancos ponen los cargos en positivo con columnas "Debe"/"Haber" separadas).
- saldo: el saldo de la cuenta tras ese movimiento, si el extracto lo trae;
  null si no hay columna de saldo.
- Cualquier fila que no puedas interpretar (totales, cabeceras repetidas,
  líneas en blanco con texto) va a dudas, no la inventes como movimiento.`;

async function extraerBloqueMovimientos(textoTabular, nombreHoja) {
  const contexto = nombreHoja ? `Nombre de la hoja: "${nombreHoja}"\n\n` : '';
  const texto = `${EXTRACTO_PROMPT}\n\n${contexto}${textoTabular}`;
  return extraerJson({
    maxTokens: 4096,
    schema: EXTRACTO_SCHEMA,
    content: [{ type: 'text', text: texto }],
    mensajeError: 'La IA devolvió una respuesta incompleta al leer el extracto bancario.',
  });
}

async function extraerMovimientosDeArchivo(buffer, filename) {
  const hojas = await parsearArchivoTabular(buffer, filename);
  const movimientos = [];
  const dudas = [];
  const usage = { input_tokens: 0, output_tokens: 0 };

  for (const hoja of hojas) {
    for (const bloque of construirBloques(hoja.filas)) {
      const { data, usage: u } = await extraerBloqueMovimientos(filasATexto(bloque), hoja.hoja);
      for (const m of (data.movimientos || [])) movimientos.push(m);
      for (const d of (data.dudas || [])) dudas.push({ ...d, hoja: hoja.hoja });
      usage.input_tokens  += u?.input_tokens  || 0;
      usage.output_tokens += u?.output_tokens || 0;
    }
  }

  return { movimientos, dudas, usage };
}

// ── Confirmar ────────────────────────────────────────────────────────────
function construirFila(cliente, m, origenArchivo) {
  const fecha = m.fecha;
  const concepto = String(m.concepto || '').trim();
  const importe = Number(m.importe);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) throw new Error(`Movimiento con fecha inválida: ${JSON.stringify(m)}`);
  if (!concepto) throw new Error(`Movimiento sin concepto: ${JSON.stringify(m)}`);
  if (!Number.isFinite(importe) || importe === 0) throw new Error(`Movimiento con importe inválido: ${JSON.stringify(m)}`);

  return {
    cliente, fecha, concepto,
    concepto_norm: normalizarTextoProducto(concepto),
    importe,
    saldo: m.saldo != null && Number.isFinite(Number(m.saldo)) ? Number(m.saldo) : null,
    origen_archivo: origenArchivo || null,
    conciliado: false,
    tipo_conciliacion: null,
    referencia_id: null,
  };
}

// Guarda los movimientos ya revisados por el usuario en la vista previa.
// Duplicados exactos (mismo cliente, fecha, concepto_norm, importe — ver
// migración 046) se ignoran vía upsert con ignoreDuplicates en vez de
// fallar la importación entera: .select() tras un upsert así solo devuelve
// las filas realmente insertadas, así que la resta da los saltados.
async function confirmarImportacion(cliente, movimientos, origenArchivo) {
  if (!Array.isArray(movimientos) || !movimientos.length) {
    throw new Error('Se requiere al menos un movimiento');
  }
  const filas = movimientos.map(m => construirFila(cliente, m, origenArchivo));

  const { data: guardados, error } = await supabase
    .from('movimientos_banco')
    .upsert(filas, { onConflict: 'cliente,fecha,concepto_norm,importe', ignoreDuplicates: true })
    .select();
  if (error) throw new Error(`Supabase (guardar movimientos): ${error.message}`);

  const conciliados = await conciliarPendientes(cliente);
  return { guardados: guardados.length, duplicados: filas.length - guardados.length, conciliados };
}

// ── Conciliación automática ──────────────────────────────────────────────
// Tolerancia de importe: exacta, sin margen — el banco no redondea.
const DIAS_VENTANA_FACTURA = 45; // un cargo puede pagar una factura de hasta 45 días antes
const DIAS_VENTANA_VENTA = 3;    // el cobro con tarjeta suele liquidarse 1-2 días después de la venta

// Recorre TODOS los movimientos sin conciliar del cliente (no solo los
// recién importados: una factura puede subirse semanas después que el
// extracto, y así se resuelve sola en la siguiente importación). Nunca
// lanza por un fallo puntual — seguir con el resto importa más que parar.
async function conciliarPendientes(cliente) {
  const tablaFacturas = `${cliente}_facturas`;

  const { data: pendientes, error: errP } = await supabase
    .from('movimientos_banco').select('id, fecha, importe')
    .eq('cliente', cliente).eq('conciliado', false);
  if (errP) throw new Error(`movimientos_banco: ${errP.message}`);
  if (!pendientes.length) return 0;

  const { data: facturas, error: errF } = await supabase
    .from(tablaFacturas).select('id, importe_total, fecha_factura')
    .in('tipo', ['factura', 'ticket'])
    .eq('posible_duplicado', false)
    .not('fecha_factura', 'is', null)
    .not('importe_total', 'is', null);
  if (errF) throw new Error(`${tablaFacturas}: ${errF.message}`);

  const { data: ventas, error: errV } = await supabase
    .from('ventas_diarias').select('id, fecha, total_neto')
    .eq('cliente', cliente)
    .not('total_neto', 'is', null);
  if (errV) throw new Error(`ventas_diarias: ${errV.message}`);

  // Ya usadas por cualquier movimiento conciliado (de esta pasada o de una
  // importación anterior) — una factura o venta nunca concilia dos veces.
  const { data: yaConciliados, error: errC } = await supabase
    .from('movimientos_banco').select('tipo_conciliacion, referencia_id')
    .eq('cliente', cliente).eq('conciliado', true);
  if (errC) throw new Error(`movimientos_banco: ${errC.message}`);

  const facturasUsadas = new Set(yaConciliados.filter(m => m.tipo_conciliacion === 'factura').map(m => m.referencia_id));
  const ventasUsadas = new Set(yaConciliados.filter(m => m.tipo_conciliacion === 'venta').map(m => m.referencia_id));

  // Orden estable por fecha: si dos movimientos del mismo importe compiten
  // por la misma factura, el primero en el tiempo se la queda.
  const pendientesOrdenados = [...pendientes].sort((a, b) => a.fecha.localeCompare(b.fecha));

  let conciliadosEnEstaPasada = 0;
  for (const mov of pendientesOrdenados) {
    const importe = Number(mov.importe);
    let match = null;

    if (importe < 0) {
      const desde = offsetDias(mov.fecha, -DIAS_VENTANA_FACTURA);
      const candidatas = facturas.filter(f =>
        !facturasUsadas.has(f.id) &&
        Number(f.importe_total) === Math.abs(importe) &&
        f.fecha_factura >= desde && f.fecha_factura <= mov.fecha
      );
      if (candidatas.length === 1) match = { tipo: 'factura', id: candidatas[0].id };
    } else if (importe > 0) {
      const desde = offsetDias(mov.fecha, -DIAS_VENTANA_VENTA);
      const candidatas = ventas.filter(v =>
        !ventasUsadas.has(v.id) &&
        Number(v.total_neto) === importe &&
        v.fecha >= desde && v.fecha <= mov.fecha
      );
      if (candidatas.length === 1) match = { tipo: 'venta', id: candidatas[0].id };
    }

    if (!match) continue;

    try {
      const { error: errU } = await supabase
        .from('movimientos_banco')
        .update({ conciliado: true, tipo_conciliacion: match.tipo, referencia_id: match.id })
        .eq('id', mov.id);
      if (errU) throw new Error(errU.message);
      if (match.tipo === 'factura') facturasUsadas.add(match.id); else ventasUsadas.add(match.id);
      conciliadosEnEstaPasada++;
    } catch (e) {
      console.error(`[banco:${cliente}] no se pudo conciliar el movimiento ${mov.id}:`, e.message);
    }
  }

  return conciliadosEnEstaPasada;
}

// ── Listado y conciliación manual ────────────────────────────────────────
async function listarMovimientos(cliente, { desde, hasta, estado } = {}) {
  let q = supabase.from('movimientos_banco').select('*').eq('cliente', cliente).order('fecha', { ascending: false });
  if (desde) q = q.gte('fecha', desde);
  if (hasta) q = q.lte('fecha', hasta);
  if (estado === 'conciliados') q = q.eq('conciliado', true);
  if (estado === 'sin_conciliar') q = q.eq('conciliado', false);
  const { data, error } = await q;
  if (error) throw new Error(`movimientos_banco: ${error.message}`);
  return data;
}

const TIPOS_CONCILIACION = ['factura', 'venta', 'nomina', 'otro'];

// Conciliación manual de lo que el automático no resolvió. 'nomina' y
// 'otro' siempre guardan referencia_id null: el módulo de personal
// (gastos_personal) todavía no existe, así que 'nomina' es, por ahora,
// solo una etiqueta sin registro al que apuntar.
async function conciliarManual(cliente, id, { tipo_conciliacion, referencia_id } = {}) {
  if (!TIPOS_CONCILIACION.includes(tipo_conciliacion)) {
    throw new Error(`tipo_conciliacion debe ser uno de: ${TIPOS_CONCILIACION.join(', ')}`);
  }
  const requiereReferencia = tipo_conciliacion === 'factura' || tipo_conciliacion === 'venta';
  const refId = requiereReferencia ? Number(referencia_id) : null;
  if (requiereReferencia && !Number.isFinite(refId)) {
    throw new Error('referencia_id es obligatorio para tipo_conciliacion factura o venta');
  }

  const { data, error } = await supabase
    .from('movimientos_banco')
    .update({ conciliado: true, tipo_conciliacion, referencia_id: refId })
    .eq('id', id).eq('cliente', cliente)
    .select().maybeSingle();
  if (error) throw new Error(`Supabase (conciliar): ${error.message}`);
  if (!data) throw new Error('Movimiento no encontrado');
  return data;
}

async function desconciliar(cliente, id) {
  const { data, error } = await supabase
    .from('movimientos_banco')
    .update({ conciliado: false, tipo_conciliacion: null, referencia_id: null })
    .eq('id', id).eq('cliente', cliente)
    .select().maybeSingle();
  if (error) throw new Error(`Supabase (desconciliar): ${error.message}`);
  if (!data) throw new Error('Movimiento no encontrado');
  return data;
}

// ── Resumen (GET /analytics/banco-resumen) ──────────────────────────────
async function calcularResumen(cliente, mes) {
  let q = supabase.from('movimientos_banco').select('fecha, importe, saldo, conciliado').eq('cliente', cliente);
  if (/^\d{4}-\d{2}$/.test(mes || '')) {
    const fin = primerDiaSiguienteMes(mes);
    q = q.gte('fecha', `${mes}-01`).lt('fecha', fin);
  }
  const { data, error } = await q.order('fecha', { ascending: true });
  if (error) throw new Error(`movimientos_banco: ${error.message}`);

  const totalIngresos = data.filter(m => Number(m.importe) > 0).reduce((s, m) => s + Number(m.importe), 0);
  const totalGastos = data.filter(m => Number(m.importe) < 0).reduce((s, m) => s + Number(m.importe), 0);
  const conciliados = data.filter(m => m.conciliado).length;

  // Saldo final: el del último movimiento del periodo que traiga saldo —
  // no todos los extractos lo incluyen por línea.
  const conSaldo = data.filter(m => m.saldo != null);
  const saldoFinal = conSaldo.length ? Number(conSaldo[conSaldo.length - 1].saldo) : null;

  return {
    cliente,
    mes: mes || null,
    total_ingresos: Number(totalIngresos.toFixed(2)),
    total_gastos: Number(totalGastos.toFixed(2)),
    saldo_final: saldoFinal,
    num_movimientos: data.length,
    num_conciliados: conciliados,
    pct_conciliado: data.length ? Number(((conciliados / data.length) * 100).toFixed(1)) : null,
  };
}

module.exports = {
  extraerMovimientosDeArchivo, confirmarImportacion, conciliarPendientes,
  listarMovimientos, conciliarManual, desconciliar, calcularResumen,
};
