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
const { PDFDocument } = require('pdf-lib');
const { supabase } = require('./supabase');
const { extraerJson, buildFileBlock } = require('./claude-json');
const { parsearArchivoTabular, construirBloques, filasATexto } = require('./archivo-tabular');
const { ensureFolderPath, uploadFile } = require('./google');

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

// Familias de unidades convertibles entre sí (a la unidad base de cada
// familia). Usado por el inventario estimado para sumar compras/consumo en
// la unidad de referencia del ingrediente aunque una factura venga en kg y
// el escandallo esté en g. Cerrado a propósito: 'caja', 'pack' y cualquier
// unidad no listada no tienen conversión (no hay forma fiable de saber
// cuánto trae una caja sin mirar la factura), así que nunca se inventan.
const FAMILIA_UNIDAD = {
  kg: { base: 1000 }, g: { base: 1 },
  l: { base: 1000 }, ml: { base: 1 },
  docena: { base: 12 }, ud: { base: 1 },
};
const FAMILIA_DE = { kg: 'peso', g: 'peso', l: 'volumen', ml: 'volumen', docena: 'unidad', ud: 'unidad' };

// Convierte `cantidad` de `desde` a `hasta` si ambas están en la misma
// familia (peso, volumen o unidad); devuelve null si no son convertibles
// entre sí (familias distintas, o alguna unidad fuera de FAMILIA_UNIDAD) —
// el caller decide entonces no sumar en vez de mezclar escalas.
function convertirUnidad(cantidad, desde, hasta) {
  if (desde === hasta) return cantidad;
  const d = FAMILIA_UNIDAD[desde];
  const h = FAMILIA_UNIDAD[hasta];
  if (!d || !h || FAMILIA_DE[desde] !== FAMILIA_DE[hasta]) return null;
  return (cantidad * d.base) / h.base;
}

// Texto de producto (línea de factura o alias): minúsculas, sin acentos,
// espacios colapsados. Es la clave de búsqueda en producto_alias.texto_factura
// — nunca el nombre "bonito" para mostrar en la UI.
function normalizarTextoProducto(raw) {
  if (!raw) return '';
  return quitarAcentos(String(raw).toLowerCase().trim()).replace(/\s+/g, ' ');
}

// ── Envases: se compran por unidad, no por peso/volumen ──────────────────
// Un tamaño de envase en el nombre del producto (70CL, 1L, PET, LATA,
// BOTELLA, CAJA...) significa que el precio es por envase, no por litro o
// kilo — aunque el propio envase contenga un líquido. Compartido por
// tarifas.js (importación de tarifas) y extraccion.js (líneas de factura):
// exportada aquí para que ambos lados corrijan exactamente igual — una
// botella es una unidad tanto en la tarifa pactada como en la factura que
// se compara contra ella.
const PATRONES_ENVASE = [
  /\b\d+([.,]\d+)?\s?(cl|ml)\b/i,   // 70CL, 33 CL, 500ML
  /\b\d+([.,]\d+)?\s?l\b/i,         // 1L, 3L, 1.5L
  /\bl[º°]/i,                       // Lº, L° — abreviatura de "litro" muy habitual en tarifas de bebidas
  /\blitro[s]?\b/i,
  /\bpet\b/i,
  /\blata[s]?\b/i,
  /\bbotella[s]?\b/i,
  /\bcaja\b/i,
];

function extraerTamanoEnvase(texto) {
  for (const patron of PATRONES_ENVASE) {
    const m = String(texto || '').match(patron);
    if (m) return m[0].trim();
  }
  return null;
}

// Corrección determinista tras la extracción (además de pedírselo al
// modelo en el prompt, que no siempre lo respeta): si el nombre del
// producto lleva un tamaño de envase y la unidad detectada es de peso o
// volumen (l, ml — kg/g se dejan: un producto vendido a granel puede
// mencionar un tamaño de referencia sin que eso cambie nada), se corrige a
// 'ud' y el tamaño pasa a notas para no perder el dato.
function corregirUnidadEnvase(item) {
  // Normaliza solo para la comparación — si no es un envase, el item vuelve
  // tal cual llegó (esta función no es responsable de normalizar unidad en
  // general, cada caller ya lo hace donde le corresponde).
  const unidadNorm = normalizarUnidad(item.unidad) || item.unidad;
  if (unidadNorm !== 'l' && unidadNorm !== 'ml') return item;
  const tamano = extraerTamanoEnvase(item.producto);
  if (!tamano) return item;
  return { ...item, unidad: 'ud', notas: [item.notas, tamano].filter(Boolean).join(' · ') };
}

// ── Ingesta de tarifas ───────────────────────────────────────────────────
// Vista previa: sube xlsx/csv → texto tabular por hoja (backend/lib/
// archivo-tabular.js) → Claude normaliza por bloques de 150 filas →
// agrupado por proveedor detectado. Nada se guarda hasta /tarifas/confirmar.

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
- El proveedor es UNO SOLO para todo el documento, salvo que haya una
  columna de proveedor explícita en la tabla, o secciones separadas con su
  propia cabecera de proveedor (nombre y/o NIF). Una marca o fabricante que
  aparece DENTRO del nombre de un producto (Bacardi, Diageo, Osborne, Moya,
  Torres...) NUNCA es el proveedor — es el fabricante de ese producto
  concreto; el proveedor es quien vende/factura el listado completo. Si no
  encuentras el proveedor real, deja proveedor en null, no pongas ahí una
  marca del producto.
- Normaliza unidades a: kg, g, l, ml, ud, caja, pack, docena. Si el nombre
  del producto lleva un tamaño de envase (70CL, 75CL, LITRO, 1L, 3L, PET,
  LATA, 33CL, 20CL, BOTELLA, CAJA 12...), la unidad es 'ud' y el precio es
  por envase — el tamaño va en notas, no cambia la unidad. Usa kg, g, l o
  ml SOLO cuando el precio esté explícitamente marcado por peso o volumen
  (€/kg, €/l, "precio por kilo").
- Precios en formato español (1.234,56). Devuelve número.
- Cualquier fila que no puedas interpretar va a dudas, no la inventes.`;

// 16000 para todas las llamadas de tarifas (bloques de Excel, PDF, imagen):
// mismo motivo que en extraccion.js — un catálogo denso (~90 productos en
// pocas páginas, caso real: tarifa de Cuinanatural) supera de sobra los
// 4096 de antes y la respuesta se corta a mitad de JSON.
const TARIFA_MAX_TOKENS = 16000;

async function extraerBloqueTarifa(textoTabular, nombreHoja) {
  const contexto = nombreHoja ? `Nombre de la hoja: "${nombreHoja}"\n\n` : '';
  const texto = `${TARIFA_IMPORT_PROMPT}\n\n${contexto}${textoTabular}`;
  return extraerJson({
    maxTokens: TARIFA_MAX_TOKENS,
    schema: TARIFA_IMPORT_SCHEMA,
    content: [{ type: 'text', text: texto }],
    mensajeError: 'La IA devolvió una respuesta incompleta al leer el listado de precios.',
  });
}

// ── Ingesta desde PDF/foto (además de xlsx/csv) ──────────────────────────
// Mismo esquema y prompt que el listado tabular; para PDF se añade una
// instrucción extra porque un documento de verdad (a diferencia de una
// hoja de cálculo) suele traer cabeceras/pies repetidos, código de
// artículo y columnas de precio ambiguas.
const TARIFA_IMPORT_PROMPT_PDF_EXTRA = 'Ignora cabeceras y pies de página repetidos, códigos de artículo y '
  + 'columnas que no sean el nombre del producto, la unidad y el precio de venta al restaurante. Si hay varias '
  + 'columnas de precio, usa la marcada como tarifa del cliente o, si no está claro, la primera.';

// Hasta este nº de páginas, todo el PDF en una sola llamada. Más allá, se
// trocea (ver trocearPdf) porque una sola llamada con un documento largo
// pierde precisión y es más fácil que trunque la respuesta. 2 páginas por
// grupo por defecto (antes 5: seguía cortándose con catálogos densos); si
// un grupo devuelve más de DENSIDAD_UMBRAL_PRODUCTOS, señal de catálogo
// denso, los grupos siguientes bajan a 1 página.
const PDF_MAX_PAGINAS_SIN_TROCEAR = 6;
const PDF_PAGINAS_POR_GRUPO = 2;
const DENSIDAD_UMBRAL_PRODUCTOS = 60;
// Salvaguarda del reintento por bloques de 40 (ver extraerPaginaPorBloques):
// nunca más de esta vueltas, para no encadenar llamadas sin fin si una
// página está genuinamente rota.
const MAX_BLOQUES_DE_40 = 6;

// Exportadas (ver module.exports): backend/lib/escandallo.js las reutiliza
// para la importación de escandallos desde PDF/foto — es la misma
// necesidad genérica ("trocear un PDF largo en grupos de páginas para
// mandarlos a Claude por separado"), sin nada específico de tarifas.
async function contarPaginasPdf(buffer) {
  const doc = await PDFDocument.load(buffer);
  return doc.getPageCount();
}

// Recorta el PDF original a solo las páginas de `indices` (0-based). Se
// parte siempre del buffer ORIGINAL, nunca de un recorte previo — así el
// reintento inteligente (partir un grupo en dos mitades) puede recortar
// cualquier rango de páginas sin arrastrar pérdidas de una recompresión
// anterior.
async function recortarPaginasPdf(buffer, indices) {
  const doc = await PDFDocument.load(buffer);
  const nuevo = await PDFDocument.create();
  const paginas = await nuevo.copyPages(doc, indices);
  paginas.forEach(p => nuevo.addPage(p));
  return Buffer.from(await nuevo.save());
}

// Trocea un PDF en grupos de `paginasPorGrupo` páginas consecutivas,
// devolviendo un PDF (buffer) independiente por grupo — pdf-lib es la única
// librería del repo que sabe recortar páginas (pdfkit, ya presente, solo
// genera PDFs nuevos, no edita uno existente).
async function trocearPdf(buffer, paginasPorGrupo) {
  const total = await contarPaginasPdf(buffer);
  const grupos = [];
  for (let inicio = 0; inicio < total; inicio += paginasPorGrupo) {
    const fin = Math.min(inicio + paginasPorGrupo, total);
    const indices = Array.from({ length: fin - inicio }, (_, k) => inicio + k);
    grupos.push({ buffer: await recortarPaginasPdf(buffer, indices), desde: inicio + 1, hasta: fin });
  }
  return grupos;
}

// `fileBlock` es un bloque de imagen o documento ya construido con
// buildFileBlock(). `proveedorContexto` es el nombre de proveedor detectado
// en un grupo de páginas anterior del mismo PDF — la cabecera con el
// nombre del proveedor suele estar solo en la página 1, así que sin esto
// los grupos siguientes devolverían proveedor: null.
async function extraerTarifaDeArchivoVisual(fileBlock, { proveedorContexto, esPdf } = {}) {
  let texto = TARIFA_IMPORT_PROMPT;
  if (esPdf) texto += `\n${TARIFA_IMPORT_PROMPT_PDF_EXTRA}`;
  if (proveedorContexto) {
    texto += `\n\nProveedor ya detectado en una página anterior de este mismo documento: `
      + `"${proveedorContexto}". Si esta página no repite su nombre pero es evidente que sigue siendo la misma `
      + `tarifa, usa este proveedor en vez de null.`;
  }
  return extraerJson({
    maxTokens: TARIFA_MAX_TOKENS,
    schema: TARIFA_IMPORT_SCHEMA,
    content: [fileBlock, { type: 'text', text: texto }],
    mensajeError: 'La IA devolvió una respuesta incompleta al leer el documento de tarifas.',
  });
}

// Último recurso cuando ni una sola página cabe en una respuesta (catálogo
// realmente muy denso): se pide por bloques de 40 productos, cada vez
// "los siguientes 40 a partir de <último producto>" para no repetir ni
// saltarse nada, acumulando hasta que un bloque devuelva menos de 40 (la
// página se agotó) o dos intentos seguidos fallen (se rinde con lo que
// haya, nunca lanza "respuesta incompleta" al usuario).
async function extraerPaginaPorBloques(paginaBuffer, { desde, proveedorContexto }) {
  const productos = [];
  const dudas = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let ultimoProducto = null;

  for (let vuelta = 1; vuelta <= MAX_BLOQUES_DE_40; vuelta++) {
    let texto = `${TARIFA_IMPORT_PROMPT}\n${TARIFA_IMPORT_PROMPT_PDF_EXTRA}`;
    if (proveedorContexto) texto += `\n\nProveedor ya detectado en una página anterior: "${proveedorContexto}".`;
    texto += ultimoProducto
      ? `\n\nEsta página es muy densa y ya se han extraído productos de ella. Devuelve SOLO los siguientes 40 `
        + `productos a partir de "${ultimoProducto}" (sin repetirlo), en el mismo orden en que aparecen en la `
        + `página. Si no quedan 40 más, devuelve los que falten.`
      : '\n\nEsta página es muy densa. Devuelve SOLO los primeros 40 productos de la página, en el orden en que aparecen.';

    let data, u;
    try {
      ({ data, usage: u } = await extraerJson({
        maxTokens: TARIFA_MAX_TOKENS,
        schema: TARIFA_IMPORT_SCHEMA,
        content: [buildFileBlock(paginaBuffer, 'application/pdf'), { type: 'text', text: texto }],
        mensajeError: 'La IA devolvió una respuesta incompleta al leer el documento de tarifas.',
      }));
    } catch (e) {
      console.error(`[tarifas] página ${desde}, bloque de 40 nº${vuelta}: sigue cortándose (${e.message}) — se para con lo acumulado`);
      break;
    }

    const nuevos = data.productos || [];
    for (const d of (data.dudas || [])) dudas.push(d);
    usage.input_tokens  += u?.input_tokens  || 0;
    usage.output_tokens += u?.output_tokens || 0;
    console.log(`[tarifas] página ${desde}, bloque de 40 nº${vuelta}: ${nuevos.length} producto(s), ${u?.output_tokens || 0} tokens de salida`);

    if (!nuevos.length) break;
    productos.push(...nuevos);
    ultimoProducto = nuevos[nuevos.length - 1].producto;
    if (nuevos.length < 40) break; // menos de 40 = la página ya no da más
  }

  return { productos, dudas, usage };
}

// Extrae un rango de páginas [desde, hasta] (1-based, inclusive) del PDF
// ORIGINAL, con reintento inteligente: si extraerTarifaDeArchivoVisual
// lanza (JSON truncado incluso tras su propio reintento interno), el rango
// se parte en dos mitades y cada una se reintenta por separado — de forma
// recursiva, hasta llegar a una sola página. Si una sola página aún se
// corta, cae a extraerPaginaPorBloques(). Nunca deja escapar el error al
// caller: siempre devuelve lo que haya podido extraer.
async function extraerRangoPdfConReintento(buffer, { desde, hasta, totalPaginas, proveedorContexto, onProgreso }) {
  const indices = Array.from({ length: hasta - desde + 1 }, (_, k) => desde - 1 + k);
  const rangoBuffer = await recortarPaginasPdf(buffer, indices);

  if (onProgreso) {
    onProgreso(desde === 1 && hasta === totalPaginas
      ? `Leyendo ${totalPaginas} página${totalPaginas !== 1 ? 's' : ''}…`
      : `Leyendo páginas ${desde}-${hasta} de ${totalPaginas}`);
  }

  try {
    const { data, usage } = await extraerTarifaDeArchivoVisual(
      buildFileBlock(rangoBuffer, 'application/pdf'),
      { proveedorContexto, esPdf: true }
    );
    const productos = data.productos || [];
    const dudas = data.dudas || [];
    console.log(`[tarifas] páginas ${desde}-${hasta}: ${productos.length} producto(s), ${usage?.output_tokens || 0} tokens de salida`);
    return { productos, dudas, usage: usage || { input_tokens: 0, output_tokens: 0 } };
  } catch (e) {
    if (hasta > desde) {
      const finPrimeraMitad = desde + Math.floor((hasta - desde + 1) / 2) - 1;
      console.warn(`[tarifas] páginas ${desde}-${hasta} truncadas (${e.message}) — partiendo en ${desde}-${finPrimeraMitad} y ${finPrimeraMitad + 1}-${hasta}`);
      const primera = await extraerRangoPdfConReintento(buffer, { desde, hasta: finPrimeraMitad, totalPaginas, proveedorContexto, onProgreso });
      const contextoTrasPrimera = proveedorContexto || primera.productos.find(p => p.proveedor)?.proveedor || null;
      const segunda = await extraerRangoPdfConReintento(buffer, { desde: finPrimeraMitad + 1, hasta, totalPaginas, proveedorContexto: contextoTrasPrimera, onProgreso });
      return {
        productos: [...primera.productos, ...segunda.productos],
        dudas: [...primera.dudas, ...segunda.dudas],
        usage: {
          input_tokens:  primera.usage.input_tokens  + segunda.usage.input_tokens,
          output_tokens: primera.usage.output_tokens + segunda.usage.output_tokens,
        },
      };
    }
    console.warn(`[tarifas] página ${desde} truncada (${e.message}) incluso sola — pidiendo por bloques de 40 productos`);
    return extraerPaginaPorBloques(rangoBuffer, { desde, proveedorContexto });
  }
}

async function extraerProductosDePdf(buffer, { onProgreso } = {}) {
  const totalPaginas = await contarPaginasPdf(buffer);
  const productos = [];
  const dudas = [];
  const usage = { input_tokens: 0, output_tokens: 0 };

  let proveedorContexto = null;
  let paginasPorGrupo = totalPaginas <= PDF_MAX_PAGINAS_SIN_TROCEAR ? totalPaginas : PDF_PAGINAS_POR_GRUPO;
  let inicio = 1;

  while (inicio <= totalPaginas) {
    const fin = Math.min(inicio + paginasPorGrupo - 1, totalPaginas);
    const r = await extraerRangoPdfConReintento(buffer, { desde: inicio, hasta: fin, totalPaginas, proveedorContexto, onProgreso });

    for (const p of r.productos) productos.push({ ...p, hoja: null });
    for (const d of r.dudas) dudas.push({ ...d, hoja: null });
    usage.input_tokens  += r.usage.input_tokens;
    usage.output_tokens += r.usage.output_tokens;

    // Solo se toma mientras no haya uno ya fijado — el primer grupo con
    // proveedor detectado es el que más probablemente lleva la cabecera.
    if (!proveedorContexto) {
      const detectado = r.productos.find(p => p.proveedor)?.proveedor;
      if (detectado) proveedorContexto = detectado;
    }

    // Catálogo denso (>60 productos en este grupo): de aquí en adelante,
    // páginas sueltas — un grupo de 2 páginas sería casi tan denso como la
    // que ya falló, mejor no repetir el mismo problema.
    if (r.productos.length > DENSIDAD_UMBRAL_PRODUCTOS) paginasPorGrupo = 1;

    inicio = fin + 1;
  }

  return { productos, dudas, usage };
}

async function extraerProductosDeImagen(buffer, mimeType) {
  const { data, usage } = await extraerTarifaDeArchivoVisual(buildFileBlock(buffer, mimeType), { esPdf: false });
  return {
    productos: (data.productos || []).map(p => ({ ...p, hoja: null })),
    dudas: (data.dudas || []).map(d => ({ ...d, hoja: null })),
    usage,
  };
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

// `mimeType` decide la vía: xlsx/csv (tabular, como siempre), PDF (una
// llamada si tiene pocas páginas, trociado si no) o imagen (una foto = una
// tarifa, igual que una foto de cierre de caja). `onProgreso(mensaje)` es
// opcional — solo lo usa el trociado de PDFs largos para avisar por qué
// grupo de páginas va la lectura.
async function extraerTarifasDeArchivo(buffer, filename, cliente, mimeType, { onProgreso } = {}) {
  const ext = (filename || '').toLowerCase().split('.').pop();
  const esPdf = mimeType === 'application/pdf' || ext === 'pdf';
  const esImagen = (mimeType && mimeType.startsWith('image/')) || ['jpg', 'jpeg', 'png'].includes(ext);

  let productos = [];
  let dudas = [];
  const usage = { input_tokens: 0, output_tokens: 0 };

  if (esPdf) {
    const r = await extraerProductosDePdf(buffer, { onProgreso });
    productos = r.productos; dudas = r.dudas;
    usage.input_tokens += r.usage.input_tokens; usage.output_tokens += r.usage.output_tokens;
  } else if (esImagen) {
    const r = await extraerProductosDeImagen(buffer, mimeType || (ext === 'png' ? 'image/png' : 'image/jpeg'));
    productos = r.productos; dudas = r.dudas;
    usage.input_tokens += r.usage.input_tokens; usage.output_tokens += r.usage.output_tokens;
  } else {
    const hojas = await parsearArchivoTabular(buffer, filename);
    for (const hoja of hojas) {
      for (const bloque of construirBloques(hoja.filas)) {
        const { data, usage: u } = await extraerBloqueTarifa(filasATexto(bloque), hoja.hoja);
        for (const p of (data.productos || [])) productos.push({ ...p, hoja: hoja.hoja });
        for (const d of (data.dudas || [])) dudas.push({ ...d, hoja: hoja.hoja });
        usage.input_tokens  += u?.input_tokens  || 0;
        usage.output_tokens += u?.output_tokens || 0;
      }
    }
  }

  // Defensa en profundidad: el prompt ya le pide al modelo normalizar la
  // unidad, pero no nos fiamos a ciegas — se re-normaliza aquí y otra vez
  // al confirmar, por si el usuario edita el valor en la vista previa.
  // corregirUnidadEnvase después: aunque el modelo ya normalizó, un envase
  // (70CL, PET, LATA...) que se haya colado como l/ml se corrige a ud aquí,
  // determinista, sin depender de que el prompt se cumpla siempre.
  productos = productos
    .map(p => ({ ...p, unidad: normalizarUnidad(p.unidad) || p.unidad }))
    .map(corregirUnidadEnvase);

  const { lista: proveedoresFacturados, productosPorProveedor } = await datosProveedoresFacturados(cliente);
  const grupos = agruparPorProveedor(productos).map(g => ({
    ...g,
    sugerencia: sugerirProveedorParaGrupo(g, { lista: proveedoresFacturados, productosPorProveedor }),
  }));

  return { grupos, dudas, proveedores_facturados: proveedoresFacturados, usage };
}

// ── Cruce con compras ya registradas (vista previa de importación) ───────
// Nombres de producto tal cual aparecen en las facturas ya subidas de un
// proveedor (por NIF, sin filtro de fecha: aquí interesa "¿le hemos
// comprado esto alguna vez?", no un periodo concreto). cif_proveedor se
// guarda tal cual lo extrajo Claude (sin normalizar), así que el filtro se
// hace en JS tras traer los candidatos — mismo motivo por el que
// compararConTarifa normaliza antes de comparar.
async function productosCompradosDeProveedor(cliente, nif) {
  const nifNorm = normalizarNif(nif);
  if (!nifNorm) return [];

  const tablaFacturas = `${cliente}_facturas`;
  const tablaLineas = `${cliente}_factura_lineas`;

  const { data: facturas, error: errF } = await supabase
    .from(tablaFacturas).select('id, cif_proveedor').not('cif_proveedor', 'is', null);
  if (errF) throw new Error(`${tablaFacturas}: ${errF.message}`);
  const facturaIds = facturas.filter(f => normalizarNif(f.cif_proveedor) === nifNorm).map(f => f.id);
  if (!facturaIds.length) return [];

  const { data: lineas, error: errL } = await supabase
    .from(tablaLineas).select('producto').in('factura_id', facturaIds).not('producto', 'is', null);
  if (errL) throw new Error(`${tablaLineas}: ${errL.message}`);

  return [...new Set(lineas.map(l => l.producto).filter(Boolean))];
}

function tokenizarProducto(texto) {
  return normalizarTextoProducto(texto).split(' ').filter(t => t.length > 1);
}

// Coincidencia parcial de palabras: ni exacta (el nombre de una tarifa casi
// nunca coincide letra a letra con el de una factura del mismo producto,
// ej. "Pechuga de pollo" vs "Pechuga pollo fileteada") ni por substring
// (demasiados falsos positivos con nombres genéricos cortos). Se queda con
// que al menos el 60% de las palabras del nombre más corto aparezcan tal
// cual en el más largo — umbral elegido a ojo, ajustar aquí si en la
// práctica marca de más o de menos.
const UMBRAL_COINCIDENCIA_PARCIAL = 0.6;

function coincidenParcialmente(a, b) {
  const tokensA = tokenizarProducto(a);
  const tokensB = tokenizarProducto(b);
  if (!tokensA.length || !tokensB.length) return false;
  const [cortos, largos] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  const setLargos = new Set(largos);
  const comunes = cortos.filter(t => setLargos.has(t)).length;
  return (comunes / cortos.length) >= UMBRAL_COINCIDENCIA_PARCIAL;
}

// Para la vista previa de importación de tarifas: qué productos extraídos
// ya se le han comprado a este proveedor. `tiene_historial: false` cuando
// el proveedor no tiene ninguna factura todavía — el caller (frontend)
// marca todo para importar en ese caso, igual que hacía antes de esto.
async function verificarProductosComprados(cliente, { nif, productos } = {}) {
  const comprados = await productosCompradosDeProveedor(cliente, nif);
  if (!comprados.length) {
    return { tiene_historial: false, resultado: (productos || []).map(p => ({ producto: p, comprado: true })) };
  }
  return {
    tiene_historial: true,
    resultado: (productos || []).map(p => ({ producto: p, comprado: comprados.some(c => coincidenParcialmente(p, c)) })),
  };
}

// Valor más frecuente de una lista (ignora vacíos) — desempate por orden de
// aparición. Para elegir el nombre/NIF "de cara" de un proveedor entre
// varias facturas suyas, que rara vez vienen escritos exactamente igual.
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

// Todos los proveedores que el cliente ya tiene en sus facturas (con NIF),
// más los productos comprados a cada uno — una sola pasada por
// ${cliente}_facturas/_factura_lineas para armar el desplegable "Proveedor"
// de la vista previa de importación y la sugerencia automática por
// coincidencia de productos, en vez de una consulta por proveedor.
async function datosProveedoresFacturados(cliente) {
  const tablaFacturas = `${cliente}_facturas`;
  const tablaLineas = `${cliente}_factura_lineas`;

  const { data: facturas, error: errF } = await supabase
    .from(tablaFacturas).select('id, proveedor, cif_proveedor').not('cif_proveedor', 'is', null);
  if (errF) throw new Error(`${tablaFacturas}: ${errF.message}`);

  const porNif = new Map(); // nifNorm -> { nifs: [], nombres: [], facturaIds: [] }
  for (const f of facturas) {
    const nifNorm = normalizarNif(f.cif_proveedor);
    if (!nifNorm) continue;
    if (!porNif.has(nifNorm)) porNif.set(nifNorm, { nifs: [], nombres: [], facturaIds: [] });
    const entrada = porNif.get(nifNorm);
    entrada.nifs.push(f.cif_proveedor);
    if (f.proveedor) entrada.nombres.push(f.proveedor);
    entrada.facturaIds.push(f.id);
  }

  const facturaAProveedor = new Map();
  for (const [nifNorm, e] of porNif) for (const fid of e.facturaIds) facturaAProveedor.set(fid, nifNorm);

  const todosLosIds = [...facturaAProveedor.keys()];
  const { data: lineas, error: errL } = todosLosIds.length
    ? await supabase.from(tablaLineas).select('factura_id, producto').in('factura_id', todosLosIds).not('producto', 'is', null)
    : { data: [] };
  if (errL) throw new Error(`${tablaLineas}: ${errL.message}`);

  const productosPorProveedor = new Map(); // nifNorm -> string[]
  for (const l of lineas) {
    const nifNorm = facturaAProveedor.get(l.factura_id);
    if (!nifNorm) continue;
    if (!productosPorProveedor.has(nifNorm)) productosPorProveedor.set(nifNorm, []);
    productosPorProveedor.get(nifNorm).push(l.producto);
  }

  const lista = [...porNif.entries()]
    .map(([nifNorm, e]) => ({ nif_norm: nifNorm, nif: masFrecuente(e.nifs), nombre: masFrecuente(e.nombres) || nifNorm }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  return { lista, productosPorProveedor };
}

// Sugerencia de proveedor para un bloque de la vista previa de importación:
// 1. Si la IA detectó un nombre de proveedor y coincide (normalizado) con
//    uno ya facturado, se usa directamente — es la comprobación que pide
//    el punto "incluso cuando se detecta", sin necesidad de comparar
//    productos.
// 2. Si no, se compara cada producto extraído contra los productos ya
//    comprados a CADA proveedor facturado (misma coincidencia parcial de
//    palabras que verificarProductosComprados) y se toma el proveedor con
//    más coincidencias — solo si supera 2 productos; si no, no hay
//    sugerencia y el desplegable queda vacío para que el usuario elija.
function sugerirProveedorParaGrupo(grupo, { lista, productosPorProveedor }) {
  if (grupo.proveedor_detectado) {
    const nombreNorm = normalizarTextoProducto(grupo.proveedor_detectado);
    const porNombre = lista.find(p => normalizarTextoProducto(p.nombre) === nombreNorm);
    if (porNombre) return { nif_norm: porNombre.nif_norm, tipo: 'nombre', coincidencias: null };
  }

  const nombresProductos = (grupo.productos || []).map(p => p.producto).filter(Boolean);
  if (!nombresProductos.length) return null;

  let mejor = null;
  for (const proveedor of lista) {
    const comprados = productosPorProveedor.get(proveedor.nif_norm);
    if (!comprados || !comprados.length) continue;
    const coincidencias = nombresProductos.filter(p => comprados.some(c => coincidenParcialmente(p, c))).length;
    if (coincidencias > 0 && (!mejor || coincidencias > mejor.coincidencias)) {
      mejor = { nif_norm: proveedor.nif_norm, coincidencias };
    }
  }
  if (mejor && mejor.coincidencias > 2) return { nif_norm: mejor.nif_norm, tipo: 'productos', coincidencias: mejor.coincidencias };
  return null;
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

// ── Trazabilidad del archivo de origen ───────────────────────────────────
function detectarOrigenTipo(filename, mimeType) {
  const ext = (filename || '').toLowerCase().split('.').pop();
  if (mimeType === 'application/pdf' || ext === 'pdf') return 'pdf';
  if ((mimeType && mimeType.startsWith('image/')) || ['jpg', 'jpeg', 'png'].includes(ext)) return 'imagen';
  if (ext === 'csv') return 'csv';
  return 'xlsx';
}

// Sube el archivo de tarifa original a Drive en cliente/tarifas/AAAA-MM/ —
// mismo árbol que checklist-fotos.js/gastos-personal.js (cliente/<módulo>/
// AAAA-MM/), no el de facturas. `mes` es el mes de vigente_desde del
// primer grupo del confirm (o el mes actual si no hay ninguno) — el mismo
// archivo puede dar varios grupos/proveedores en un solo /confirmar, así
// que se sube UNA vez y todos comparten el mismo origen_drive_id.
async function subirArchivoOrigenTarifa(cliente, mes, { buffer, mimeType, nombre }) {
  const folderId = await ensureFolderPath([cliente, 'tarifas', mes]);
  const safeName = (nombre || `tarifa-${Date.now()}`).replace(/[/\\:*?"<>|]/g, '-');
  return uploadFile(safeName, buffer, folderId, mimeType || 'application/octet-stream');
}

// Guarda una tarifa nueva por proveedor: cierra la anterior (vigente_hasta
// = el día antes de que empiece esta) sin borrarla, crea la tarifa y sus
// productos. No hay transacción entre proveedores de un mismo /confirmar —
// si uno falla a mitad, los anteriores ya guardados quedan guardados; el
// backend corta y reporta el error, el usuario puede reintentar el resto.
// `archivoOriginal` es opcional: { buffer, mimeType } del archivo tal cual
// se subió — si viene, se guarda una vez en Drive y todas las tarifas de
// este confirm comparten el mismo origen_drive_id/origen_tipo.
async function confirmarTarifas(cliente, grupos, origenArchivo, archivoOriginal) {
  const resumen = { proveedores_creados: 0, proveedores_existentes: 0, tarifas_creadas: 0, productos_guardados: 0 };

  let origenDriveId = null;
  let origenTipo = null;
  if (archivoOriginal && archivoOriginal.buffer) {
    origenTipo = detectarOrigenTipo(origenArchivo, archivoOriginal.mimeType);
    const primerVigenteDesde = grupos.find(g => g.vigente_desde)?.vigente_desde || new Date().toISOString().slice(0, 10);
    try {
      const subido = await subirArchivoOrigenTarifa(cliente, primerVigenteDesde.slice(0, 7), {
        buffer: archivoOriginal.buffer, mimeType: archivoOriginal.mimeType, nombre: origenArchivo,
      });
      origenDriveId = subido.id;
    } catch (e) {
      console.error('[tarifas] no se pudo subir el archivo de origen a Drive, se guarda sin enlace:', e.message);
    }
  }

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
        origen_drive_id: origenDriveId,
        origen_tipo: origenTipo,
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
    .select('id, proveedor_id, nombre, vigente_desde, origen_archivo, origen_drive_id, origen_tipo, tarifa_productos(count)')
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
        origen_archivo: t.origen_archivo, origen_drive_id: t.origen_drive_id, origen_tipo: t.origen_tipo,
      } : null,
    };
  });
}

// ── Recalcular facturas tras reasignar/eliminar una tarifa ──────────────
// Vuelve a comparar TODAS las facturas ya guardadas de un proveedor (por
// NIF, igual que datosProveedoresFacturados) contra su tarifa vigente
// ACTUAL y persiste el resultado en sus líneas — mismo cálculo que al
// subir (compararConTarifa), pero sobre facturas ya en BD en vez de sobre
// una extracción recién hecha. Se usa después de mover una tarifa a otro
// proveedor o de borrarla: las facturas de ese NIF pasan a comparar contra
// lo que haya ahora (otra tarifa, o sin_tarifa si no queda ninguna).
async function recalcularFacturasDeProveedor(cliente, nif) {
  const nifNorm = normalizarNif(nif);
  if (!nifNorm) return { recalculadas: 0 };

  const tablaFacturas = `${cliente}_facturas`;
  const tablaLineas = `${cliente}_factura_lineas`;

  const { data: facturas, error: errF } = await supabase
    .from(tablaFacturas).select('id, cif_proveedor, fecha_factura').not('cif_proveedor', 'is', null);
  if (errF) throw new Error(`${tablaFacturas}: ${errF.message}`);
  const afectadas = facturas.filter(f => normalizarNif(f.cif_proveedor) === nifNorm);
  if (!afectadas.length) return { recalculadas: 0 };

  let recalculadas = 0;
  for (const factura of afectadas) {
    const { data: lineas, error: errL } = await supabase
      .from(tablaLineas).select('*').eq('factura_id', factura.id);
    if (errL) { console.error(`[tarifas] no se pudieron leer las líneas de la factura ${factura.id}:`, errL.message); continue; }
    if (!lineas.length) continue;

    try {
      const { lineas: lineasRecalculadas, totalSobreprecioEur } = await compararConTarifa({
        cliente, cifProveedor: factura.cif_proveedor, fechaFactura: factura.fecha_factura, lineas,
      });
      for (const l of lineasRecalculadas) {
        const { error: errUpdLinea } = await supabase.from(tablaLineas).update({
          producto_tarifa: l.producto_tarifa ?? null,
          precio_pactado:  l.precio_pactado ?? null,
          desviacion_eur:  l.desviacion_eur ?? null,
          desviacion_pct:  l.desviacion_pct ?? null,
          estado_precio:   l.estado_precio ?? null,
        }).eq('id', l.id);
        if (errUpdLinea) console.error(`[tarifas] no se pudo actualizar la línea ${l.id}:`, errUpdLinea.message);
      }
      const { error: errUpdFactura } = await supabase
        .from(tablaFacturas).update({ total_sobreprecio_eur: totalSobreprecioEur }).eq('id', factura.id);
      if (errUpdFactura) console.error(`[tarifas] no se pudo actualizar el total de la factura ${factura.id}:`, errUpdFactura.message);
      recalculadas++;
    } catch (e) {
      console.error(`[tarifas] no se pudo recalcular la factura ${factura.id}:`, e.message);
    }
  }
  return { recalculadas };
}

// "Cambiar de proveedor": mueve la tarifa VIGENTE de `proveedorActualId` a
// `nuevoProveedorId`, sin reimportar nada. Borra los alias de
// emparejamiento del proveedor de origen (aprendidos en el contexto de esa
// asignación, ya no válidos) y recalcula las facturas de AMBOS NIF: las
// del proveedor de origen (que se quedan sin esta tarifa) y las del nuevo
// (que a partir de ahora sí la tienen).
async function reasignarProveedorTarifa(cliente, proveedorActualId, nuevoProveedorId) {
  if (String(proveedorActualId) === String(nuevoProveedorId)) throw new Error('Elige un proveedor distinto');

  const tarifa = await tarifaVigente(cliente, proveedorActualId);
  if (!tarifa) throw new Error('Este proveedor no tiene una tarifa vigente que reasignar');

  const { data: proveedorActual, error: errPA } = await supabase
    .from('proveedores').select('id, nif').eq('cliente', cliente).eq('id', proveedorActualId).maybeSingle();
  if (errPA) throw new Error(`Supabase (proveedor actual): ${errPA.message}`);

  const { data: nuevoProveedor, error: errNP } = await supabase
    .from('proveedores').select('id, nif').eq('cliente', cliente).eq('id', nuevoProveedorId).maybeSingle();
  if (errNP) throw new Error(`Supabase (proveedor destino): ${errNP.message}`);
  if (!nuevoProveedor) throw new Error('Proveedor destino no encontrado');

  const { error: errUpd } = await supabase.from('tarifas').update({ proveedor_id: nuevoProveedorId }).eq('id', tarifa.id);
  if (errUpd) throw new Error(`Supabase (reasignar tarifa): ${errUpd.message}`);

  const { error: errDelAlias } = await supabase
    .from('producto_alias').delete().eq('cliente', cliente).eq('proveedor_id', proveedorActualId);
  if (errDelAlias) console.error('[tarifas] no se pudieron borrar los alias del proveedor de origen:', errDelAlias.message);

  const [recalculoAnterior, recalculoNuevo] = await Promise.all([
    proveedorActual ? recalcularFacturasDeProveedor(cliente, proveedorActual.nif) : Promise.resolve({ recalculadas: 0 }),
    recalcularFacturasDeProveedor(cliente, nuevoProveedor.nif),
  ]);

  return {
    proveedor_anterior_nif: proveedorActual?.nif || null,
    proveedor_nuevo_nif: nuevoProveedor.nif,
    facturas_recalculadas: recalculoAnterior.recalculadas + recalculoNuevo.recalculadas,
  };
}

// "Eliminar tarifa": borra la tarifa vigente de un proveedor (sus
// tarifa_productos caen en cascada, migración 041) y sus alias de
// emparejamiento, y recalcula sus facturas — quedan sin_tarifa, ya que no
// queda ninguna tarifa vigente para ese proveedor.
async function eliminarTarifaProveedor(cliente, proveedorId) {
  const { data: proveedor, error: errP } = await supabase
    .from('proveedores').select('id, nif').eq('cliente', cliente).eq('id', proveedorId).maybeSingle();
  if (errP) throw new Error(`Supabase (proveedor): ${errP.message}`);
  if (!proveedor) throw new Error('Proveedor no encontrado');

  const tarifa = await tarifaVigente(cliente, proveedorId);
  if (!tarifa) throw new Error('Este proveedor no tiene una tarifa vigente que eliminar');

  const { error: errDelTarifa } = await supabase.from('tarifas').delete().eq('id', tarifa.id);
  if (errDelTarifa) throw new Error(`Supabase (eliminar tarifa): ${errDelTarifa.message}`);

  const { error: errDelAlias } = await supabase
    .from('producto_alias').delete().eq('cliente', cliente).eq('proveedor_id', proveedorId);
  if (errDelAlias) console.error('[tarifas] no se pudieron borrar los alias:', errDelAlias.message);

  const { recalculadas } = await recalcularFacturasDeProveedor(cliente, proveedor.nif);
  return { facturas_actualizadas: recalculadas };
}

// Primer día del mes siguiente a "YYYY-MM", para filtros de rango
// [inicio, fin) por mes. Reutilizado por /analytics/sobreprecios de Timbol
// y Comarea — evita duplicar la aritmética de fechas en los dos.
function primerDiaSiguienteMes(mesStr) {
  const m = /^(\d{4})-(\d{2})$/.exec(mesStr || '');
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]), 1)).toISOString().slice(0, 10);
}

// ── Comparación en la extracción ─────────────────────────────────────────

// Estado de una línea YA emparejada con un producto de la tarifa (no
// decide sin_tarifa — eso lo hace el caller cuando no hay producto_tarifa
// en absoluto). Pura y testeada aparte: confianza baja es la prioridad más
// alta porque comparar precio/unidad contra un emparejamiento en el que ni
// el propio modelo confía no aporta nada, solo ruido.
function calcularEstadoLinea({ precioLinea, cantidadLinea, unidadLinea, precioPactado, unidadPactada, confianza, toleranciaPct }) {
  if (confianza === 'baja') {
    return { estado: 'revisar', desviacionPct: null, desviacionEur: null };
  }
  if (unidadLinea && unidadPactada && unidadLinea !== unidadPactada) {
    return { estado: 'unidad_distinta', desviacionPct: null, desviacionEur: null };
  }

  const pPactado = Number(precioPactado);
  const pLinea = Number(precioLinea);
  if (!(pPactado > 0) || !Number.isFinite(pLinea)) {
    return { estado: 'revisar', desviacionPct: null, desviacionEur: null };
  }

  const desviacionPct = ((pLinea - pPactado) / pPactado) * 100;
  const tolerancia = Math.abs(Number(toleranciaPct) || 0);
  const cantidad = Number(cantidadLinea) || 0;
  const desviacionEur = Number(((pLinea - pPactado) * cantidad).toFixed(2));

  let estado;
  if (Math.abs(desviacionPct) <= tolerancia) estado = 'ok';
  else if (desviacionPct > tolerancia) estado = 'sobreprecio';
  else estado = 'bajo_precio';

  return { estado, desviacionPct: Number(desviacionPct.toFixed(2)), desviacionEur };
}

const EMPAREJAMIENTO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    emparejamientos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          linea:           { type: 'integer', description: 'Índice de la línea, tal cual en la lista de líneas' },
          producto_tarifa: { type: ['string', 'null'], description: 'Nombre EXACTO del producto de la tarifa que mejor casa, o null si ninguno' },
          confianza:       { type: 'string', enum: ['alta', 'media', 'baja'] },
        },
        required: ['linea', 'producto_tarifa', 'confianza'],
      },
    },
  },
  required: ['emparejamientos'],
};

// Segunda llamada, corta: una sola por factura para TODAS las líneas sin
// alias, no una por línea. Puede lanzar (truncado tras el reintento) — el
// caller (compararConTarifa) decide qué hacer.
async function emparejarLineas({ lineas, indices, productosTarifa }) {
  const listaProductos = productosTarifa.map(p => `- ${p.producto} (${p.unidad})`).join('\n');
  const listaLineas = lineas.map((l, k) => `${indices[k]}: ${l.producto || '(sin nombre)'} — ${l.cantidad ?? '?'} ${l.unidad || ''}`).join('\n');
  const texto = `Empareja cada línea de factura con el producto de la tarifa que mejor corresponda.
Devuelve SOLO { emparejamientos: [{ linea, producto_tarifa, confianza }] }, uno por cada línea, en el
mismo orden. "linea" es el índice tal cual aparece en la lista. "producto_tarifa" debe ser el nombre
EXACTO tal como aparece en la lista de productos de la tarifa, o null si ninguno corresponde
razonablemente. "confianza": alta | media | baja.

Productos de la tarifa:
${listaProductos}

Líneas de la factura a emparejar:
${listaLineas}`;

  const { data } = await extraerJson({
    maxTokens: 2048,
    effort: 'low',
    schema: EMPAREJAMIENTO_SCHEMA,
    content: [{ type: 'text', text: texto }],
    mensajeError: 'La IA devolvió una respuesta incompleta al emparejar líneas con la tarifa.',
  });
  return data.emparejamientos || [];
}

function lineaSinTarifa(l) {
  return { ...l, producto_tarifa: null, precio_pactado: null, desviacion_eur: null, desviacion_pct: null, estado_precio: 'sin_tarifa' };
}

// Compara las líneas de una factura recién extraída con la tarifa vigente
// del proveedor (por NIF del emisor) a la fecha de la factura. A propósito
// PUEDE LANZAR — es extraccion.js quien decide, al llamarla, que un fallo
// aquí nunca debe bloquear el guardado de la factura; esta función no se
// traga errores en silencio, para que se puedan depurar de verdad.
async function compararConTarifa({ cliente, cifProveedor, fechaFactura, lineas }) {
  const nifNorm = normalizarNif(cifProveedor);
  if (!nifNorm) return { lineas: lineas.map(lineaSinTarifa), totalSobreprecioEur: 0 };

  const { data: proveedor, error: errProv } = await supabase
    .from('proveedores').select('id, tolerancia_pct')
    .eq('cliente', cliente).eq('nif', nifNorm).maybeSingle();
  if (errProv) throw new Error(`Supabase (buscar proveedor): ${errProv.message}`);
  if (!proveedor) return { lineas: lineas.map(lineaSinTarifa), totalSobreprecioEur: 0 };

  const tarifa = await tarifaVigente(cliente, proveedor.id, fechaFactura);
  if (!tarifa || !tarifa.tarifa_productos?.length) {
    return { lineas: lineas.map(lineaSinTarifa), totalSobreprecioEur: 0 };
  }
  const productosTarifa = tarifa.tarifa_productos;
  const buscarProducto = (nombre) => {
    const norm = normalizarTextoProducto(nombre);
    return productosTarifa.find(p => normalizarTextoProducto(p.producto) === norm) || null;
  };

  // 1. Alias ya confirmados — sin llamar al modelo.
  const resueltos = new Map(); // índice de línea -> { productoTarifa, confianza }
  const sinAlias = [];
  for (let i = 0; i < lineas.length; i++) {
    const texto = normalizarTextoProducto(lineas[i].producto);
    if (!texto) { sinAlias.push(i); continue; }
    const { data: alias, error: errAlias } = await supabase
      .from('producto_alias').select('producto_tarifa')
      .eq('cliente', cliente).eq('proveedor_id', proveedor.id).eq('texto_factura', texto).maybeSingle();
    if (errAlias) throw new Error(`Supabase (buscar alias): ${errAlias.message}`);
    if (alias) resueltos.set(i, { productoTarifa: alias.producto_tarifa, confianza: 'alta' });
    else sinAlias.push(i);
  }

  // 2. Líneas sin alias: una sola llamada de emparejamiento para toda la factura.
  if (sinAlias.length) {
    const emparejamientos = await emparejarLineas({
      lineas: sinAlias.map(i => lineas[i]),
      indices: sinAlias,
      productosTarifa,
    });
    for (const e of emparejamientos) {
      if (typeof e.linea === 'number') resueltos.set(e.linea, { productoTarifa: e.producto_tarifa || null, confianza: e.confianza || 'baja' });
    }
  }

  // 3. Estado por línea + total de sobreprecio de la factura.
  let totalSobreprecioEur = 0;
  const lineasEnriquecidas = lineas.map((l, i) => {
    const r = resueltos.get(i);
    if (!r || !r.productoTarifa) return lineaSinTarifa(l);

    const productoTarifa = buscarProducto(r.productoTarifa);
    if (!productoTarifa) return { ...lineaSinTarifa(l), producto_tarifa: r.productoTarifa };

    const { estado, desviacionPct, desviacionEur } = calcularEstadoLinea({
      precioLinea:   l.precio_unitario,
      cantidadLinea: l.cantidad,
      unidadLinea:   normalizarUnidad(l.unidad),
      precioPactado: productoTarifa.precio,
      unidadPactada: productoTarifa.unidad,
      confianza:     r.confianza,
      toleranciaPct: proveedor.tolerancia_pct,
    });
    if (estado === 'sobreprecio' && desviacionEur > 0) totalSobreprecioEur += desviacionEur;

    return {
      ...l,
      producto_tarifa: productoTarifa.producto,
      precio_pactado:  productoTarifa.precio,
      desviacion_eur:  desviacionEur,
      desviacion_pct:  desviacionPct,
      estado_precio:   estado,
    };
  });

  return { lineas: lineasEnriquecidas, totalSobreprecioEur: Number(totalSobreprecioEur.toFixed(2)) };
}

// Corrección manual de un emparejamiento desde la UI (PATCH .../emparejar).
// Recalcula contra la tarifa vigente EN LA FECHA DE LA FACTURA (no hoy) y
// confirma el alias para que futuras facturas casen solas. A diferencia de
// compararConTarifa, aquí un fallo SÍ debe verse — es una acción explícita
// del usuario, no el flujo automático de subida.
async function corregirEmparejamiento({ cliente, cifProveedor, fechaFactura, linea, productoTarifa }) {
  const nifNorm = normalizarNif(cifProveedor);
  if (!nifNorm) throw new Error('La factura no tiene NIF de proveedor reconocible');

  const { data: proveedor, error: errProv } = await supabase
    .from('proveedores').select('id, tolerancia_pct').eq('cliente', cliente).eq('nif', nifNorm).maybeSingle();
  if (errProv) throw new Error(`Supabase (buscar proveedor): ${errProv.message}`);
  if (!proveedor) throw new Error('No hay proveedor de tarifas para el NIF de esta factura');

  const tarifa = await tarifaVigente(cliente, proveedor.id, fechaFactura);
  const productoResuelto = tarifa?.tarifa_productos?.find(
    p => normalizarTextoProducto(p.producto) === normalizarTextoProducto(productoTarifa)
  );
  if (!productoResuelto) throw new Error(`"${productoTarifa}" no existe en la tarifa vigente de este proveedor`);

  const { estado, desviacionPct, desviacionEur } = calcularEstadoLinea({
    precioLinea:   linea.precio_unitario,
    cantidadLinea: linea.cantidad,
    unidadLinea:   normalizarUnidad(linea.unidad),
    precioPactado: productoResuelto.precio,
    unidadPactada: productoResuelto.unidad,
    confianza:     'alta', // corrección manual: máxima confianza
    toleranciaPct: proveedor.tolerancia_pct,
  });

  const texto = normalizarTextoProducto(linea.producto);
  if (texto) {
    const { error: errAlias } = await supabase
      .from('producto_alias')
      .upsert(
        { cliente, proveedor_id: proveedor.id, texto_factura: texto, producto_tarifa: productoResuelto.producto },
        { onConflict: 'cliente,proveedor_id,texto_factura' }
      );
    if (errAlias) throw new Error(`Supabase (guardar alias): ${errAlias.message}`);
  }

  return {
    producto_tarifa: productoResuelto.producto,
    precio_pactado:  productoResuelto.precio,
    desviacion_eur:  desviacionEur,
    desviacion_pct:  desviacionPct,
    estado_precio:   estado,
  };
}

module.exports = {
  normalizarNif, normalizarUnidad, convertirUnidad, normalizarTextoProducto,
  extraerTarifasDeArchivo, confirmarTarifas, tarifaVigente, listarProveedores,
  calcularEstadoLinea, compararConTarifa, corregirEmparejamiento, primerDiaSiguienteMes,
  verificarProductosComprados, contarPaginasPdf, trocearPdf, corregirUnidadEnvase,
  reasignarProveedorTarifa, eliminarTarifaProveedor, extraerTamanoEnvase,
};
