// Tarifas pactadas por proveedor: compartido por Timbol, Comarea y
// cualquier cliente futuro (mismo espíritu que backend/api/fichaje.js:
// tablas únicas con columna `cliente`, una fábrica de router por módulo
// consumidor). La comparación en la extracción se añade aquí en el
// siguiente commit.
//
// Las tres normalizaciones son puras (sin I/O) a propósito: se aplican
// tanto al escribir (importar tarifa, confirmar alias) como al leer
// (buscar proveedor, buscar alias) — si alguna vez divergen, el join deja
// de casar en silencio y todo cae a sin_tarifa sin que nadie sepa por qué.
const ExcelJS = require('exceljs');
const { parse: parseCsv } = require('csv-parse/sync');
const { supabase } = require('./supabase');
const { client } = require('./claude');

// NIF/CIF de proveedor: "B-12345678", "ES B12345678", "b12345678", con o
// sin espacios, todos deben normalizar al mismo valor para que el join con
// proveedores.nif funcione. Quita todo lo que no sea letra o dígito y, si
// queda un prefijo "ES" (formato NIF-IVA intracomunitario), lo quita.
function normalizarNif(raw) {
  if (!raw) return '';
  let s = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('ES') && s.length > 2) s = s.slice(2);
  return s;
}

// Unidades tal como llegan de facturas y tarifas en texto libre → forma
// canónica. Lista cerrada a propósito (kg, g, l, ml, ud, caja, pack,
// docena, unidad de servicio "-") — lo que no se reconoce se deja
// normalizado (minúsculas, sin puntos/espacios) en vez de perderse, para
// que quede visible como unidad "rara" en vez de forzarla a una canónica.
const UNIDAD_MAP = {
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogramo: 'kg', kilogramos: 'kg',
  g: 'g', gr: 'g', grs: 'g', gramo: 'g', gramos: 'g',
  l: 'l', lt: 'l', lts: 'l', litro: 'l', litros: 'l',
  ml: 'ml', mililitro: 'ml', mililitros: 'ml',
  ud: 'ud', uds: 'ud', u: 'ud', unid: 'ud', unids: 'ud', unidad: 'ud', unidades: 'ud', und: 'ud', unds: 'ud',
  caja: 'caja', cajas: 'caja', cj: 'caja',
  pack: 'pack', packs: 'pack', pk: 'pack',
  docena: 'docena', docenas: 'docena', doc: 'docena', dc: 'docena',
};

function quitarAcentos(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizarUnidad(raw) {
  if (!raw) return null;
  const key = quitarAcentos(String(raw).toLowerCase().trim()).replace(/[.\s]+/g, '');
  if (!key) return null;
  return UNIDAD_MAP[key] || key;
}

// Texto de producto (línea de factura o alias): minúsculas, sin acentos,
// espacios colapsados. Es la clave de búsqueda en producto_alias.texto_factura
// — nunca el nombre "bonito" para mostrar en la UI.
function normalizarTextoProducto(raw) {
  if (!raw) return '';
  return quitarAcentos(String(raw).toLowerCase().trim()).replace(/\s+/g, ' ');
}

// ── Ingesta de tarifas ───────────────────────────────────────────────────
// Vista previa: sube xlsx/csv → texto tabular por hoja → Claude normaliza
// por bloques de 150 filas → agrupado por proveedor detectado. Nada se
// guarda hasta /tarifas/confirmar.

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
async function parsearArchivoTarifas(buffer, filename) {
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

const TARIFA_IMPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    productos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          proveedor: { type: ['string', 'null'], description: 'Nombre del proveedor si se identifica' },
          producto:  { type: 'string' },
          unidad:    { type: 'string', description: 'kg | g | l | ml | ud | caja | pack | docena' },
          precio:    { type: 'number' },
          notas:     { type: ['string', 'null'] },
        },
        required: ['proveedor', 'producto', 'unidad', 'precio', 'notas'],
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
  required: ['productos', 'dudas'],
};

const TARIFA_IMPORT_PROMPT = `Este es un listado de precios pactados de un restaurante con sus
proveedores, en formato libre. Devuelve SOLO un JSON:
{ productos: [{ proveedor, producto, unidad, precio, notas }],
  dudas: [{ fila, motivo }] }
Reglas:
- Detecta tú la fila de cabecera; puede no ser la primera.
- Si el proveedor no está en las columnas, puede estar en el nombre de la
  hoja o en una fila de título. Si no lo encuentras, deja proveedor en null.
- Normaliza unidades a: kg, g, l, ml, ud, caja, pack, docena. Si el precio
  es por caja, indica en notas cuántas unidades o kilos trae.
- Precios en formato español (1.234,56). Devuelve número.
- Cualquier fila que no puedas interpretar va a dudas, no la inventes.`;

async function extraerBloqueTarifa(textoTabular, nombreHoja) {
  const contexto = nombreHoja ? `Nombre de la hoja: "${nombreHoja}"\n\n` : '';
  const texto = `${TARIFA_IMPORT_PROMPT}\n\n${contexto}${textoTabular}`;

  const llamar = () => client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 4096,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: TARIFA_IMPORT_SCHEMA } },
    messages: [{ role: 'user', content: [{ type: 'text', text: texto }] }],
  });

  let res = await llamar();
  let out = res.content.find(b => b.type === 'text')?.text || '';
  try {
    return { data: JSON.parse(out), usage: res.usage };
  } catch (e) {
    console.warn('[tarifas] JSON.parse falló en un bloque, reintentando:', e.message);
  }

  res = await llamar();
  out = res.content.find(b => b.type === 'text')?.text || '';
  try {
    return { data: JSON.parse(out), usage: res.usage };
  } catch (e) {
    throw new Error('La IA devolvió una respuesta incompleta al leer el listado de precios.');
  }
}

// Agrupa por (hoja, proveedor detectado) para que la vista previa se
// presente como bloques editables — el usuario asigna el NIF/proveedor
// real por bloque antes de confirmar.
function agruparPorProveedor(productos) {
  const grupos = new Map();
  for (const p of productos) {
    const key = `${p.hoja || ''}||${p.proveedor || ''}`;
    if (!grupos.has(key)) {
      grupos.set(key, { hoja: p.hoja || null, proveedor_detectado: p.proveedor || null, productos: [] });
    }
    grupos.get(key).productos.push({ producto: p.producto, unidad: p.unidad, precio: p.precio, notas: p.notas || null });
  }
  return [...grupos.values()];
}

async function extraerTarifasDeArchivo(buffer, filename) {
  const hojas = await parsearArchivoTarifas(buffer, filename);
  const productos = [];
  const dudas = [];
  const usage = { input_tokens: 0, output_tokens: 0 };

  for (const hoja of hojas) {
    for (const bloque of construirBloques(hoja.filas)) {
      const { data, usage: u } = await extraerBloqueTarifa(filasATexto(bloque), hoja.hoja);
      for (const p of (data.productos || [])) productos.push({ ...p, hoja: hoja.hoja });
      for (const d of (data.dudas || [])) dudas.push({ ...d, hoja: hoja.hoja });
      usage.input_tokens  += u?.input_tokens  || 0;
      usage.output_tokens += u?.output_tokens || 0;
    }
  }

  // Defensa en profundidad: el prompt ya le pide al modelo normalizar la
  // unidad, pero no nos fiamos a ciegas — se re-normaliza aquí y otra vez
  // al confirmar, por si el usuario edita el valor en la vista previa.
  for (const p of productos) p.unidad = normalizarUnidad(p.unidad) || p.unidad;

  return { grupos: agruparPorProveedor(productos), dudas, usage };
}

// ── Persistencia ─────────────────────────────────────────────────────────

// Un proveedor por (cliente, nif normalizado). Crea si no existe; si ya
// existe, lo reutiliza tal cual — cambiar nombre/tolerancia es cosa de
// PATCH /proveedores/:id, no de re-importar una tarifa.
async function buscarOCrearProveedor(cliente, nif, nombre) {
  const nifNorm = normalizarNif(nif);
  if (!nifNorm) throw new Error(`Falta el NIF del proveedor "${nombre || '(sin nombre)'}"`);

  const { data: existente, error: errBuscar } = await supabase
    .from('proveedores').select('id, nombre, tolerancia_pct')
    .eq('cliente', cliente).eq('nif', nifNorm).maybeSingle();
  if (errBuscar) throw new Error(`Supabase (buscar proveedor): ${errBuscar.message}`);
  if (existente) return { proveedor: existente, creado: false };

  const { data: creado, error: errCrear } = await supabase
    .from('proveedores')
    .insert({ cliente, nif: nifNorm, nombre: nombre || nifNorm })
    .select().single();
  if (errCrear) throw new Error(`Supabase (crear proveedor): ${errCrear.message}`);
  return { proveedor: creado, creado: true };
}

// Guarda una tarifa nueva por proveedor: cierra la anterior (vigente_hasta
// = el día antes de que empiece esta) sin borrarla, crea la tarifa y sus
// productos. No hay transacción entre proveedores de un mismo /confirmar —
// si uno falla a mitad, los anteriores ya guardados quedan guardados; el
// backend corta y reporta el error, el usuario puede reintentar el resto.
async function confirmarTarifas(cliente, grupos, origenArchivo) {
  const resumen = { proveedores_creados: 0, proveedores_existentes: 0, tarifas_creadas: 0, productos_guardados: 0 };

  for (const grupo of grupos) {
    if (!Array.isArray(grupo.productos) || !grupo.productos.length) continue;

    const { proveedor, creado } = await buscarOCrearProveedor(cliente, grupo.nif, grupo.nombre || grupo.proveedor_detectado);
    resumen[creado ? 'proveedores_creados' : 'proveedores_existentes']++;

    const vigenteDesde = grupo.vigente_desde || new Date().toISOString().slice(0, 10);
    const diaAntes = new Date(vigenteDesde);
    diaAntes.setDate(diaAntes.getDate() - 1);
    const vigenteHastaAnterior = diaAntes.toISOString().slice(0, 10);

    const { error: errCerrar } = await supabase
      .from('tarifas')
      .update({ vigente_hasta: vigenteHastaAnterior })
      .eq('cliente', cliente).eq('proveedor_id', proveedor.id).is('vigente_hasta', null);
    if (errCerrar) throw new Error(`Supabase (cerrar tarifa anterior de ${grupo.nif}): ${errCerrar.message}`);

    const { data: tarifa, error: errTarifa } = await supabase
      .from('tarifas')
      .insert({
        cliente, proveedor_id: proveedor.id,
        nombre: grupo.nombre_tarifa || null,
        vigente_desde: vigenteDesde,
        origen_archivo: origenArchivo || null,
      })
      .select().single();
    if (errTarifa) throw new Error(`Supabase (crear tarifa de ${grupo.nif}): ${errTarifa.message}`);
    resumen.tarifas_creadas++;

    const filas = grupo.productos
      .filter(p => p.producto && p.precio != null)
      .map(p => ({
        tarifa_id: tarifa.id,
        producto:  String(p.producto).trim(),
        unidad:    normalizarUnidad(p.unidad) || 'ud',
        precio:    Number(p.precio),
        notas:     p.notas || null,
      }));
    if (filas.length) {
      const { error: errProductos } = await supabase.from('tarifa_productos').insert(filas);
      if (errProductos) throw new Error(`Supabase (guardar productos de ${grupo.nif}): ${errProductos.message}`);
      resumen.productos_guardados += filas.length;
    }
  }

  return resumen;
}

function fechaValida(f) {
  return typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f);
}

// Tarifa vigente de un proveedor a una fecha dada (hoy por defecto), con
// sus productos. Usado por el admin (GET /tarifas/:proveedorId) y, en el
// siguiente commit, por la comparación en la extracción.
async function tarifaVigente(cliente, proveedorId, fecha) {
  const f = fechaValida(fecha) ? fecha : new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('tarifas')
    .select('*, tarifa_productos(*)')
    .eq('cliente', cliente).eq('proveedor_id', proveedorId)
    .lte('vigente_desde', f)
    .or(`vigente_hasta.is.null,vigente_hasta.gte.${f}`)
    .order('vigente_desde', { ascending: false })
    .limit(1).maybeSingle();
  if (error) throw new Error(`Supabase (tarifa vigente): ${error.message}`);
  return data;
}

// Proveedores de un cliente con el resumen de su tarifa vigente, para el
// listado de GET /tarifas.
async function listarProveedores(cliente) {
  const { data: proveedores, error } = await supabase
    .from('proveedores').select('id, nif, nombre, tolerancia_pct, created_at')
    .eq('cliente', cliente).order('nombre');
  if (error) throw new Error(`Supabase (listar proveedores): ${error.message}`);
  if (!proveedores.length) return [];

  const { data: tarifas, error: errT } = await supabase
    .from('tarifas')
    .select('id, proveedor_id, nombre, vigente_desde, tarifa_productos(count)')
    .eq('cliente', cliente).is('vigente_hasta', null);
  if (errT) throw new Error(`Supabase (listar tarifas vigentes): ${errT.message}`);

  const tarifaPorProveedor = new Map(tarifas.map(t => [t.proveedor_id, t]));
  return proveedores.map(p => {
    const t = tarifaPorProveedor.get(p.id);
    return {
      ...p,
      tarifa_vigente: t ? {
        id: t.id, nombre: t.nombre, vigente_desde: t.vigente_desde,
        num_productos: t.tarifa_productos?.[0]?.count ?? 0,
      } : null,
    };
  });
}

module.exports = {
  normalizarNif, normalizarUnidad, normalizarTextoProducto,
  extraerTarifasDeArchivo, confirmarTarifas, tarifaVigente, listarProveedores,
};
