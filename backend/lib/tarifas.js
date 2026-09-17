// Tarifas pactadas por proveedor: normalización compartida por Timbol,
// Comarea y cualquier cliente futuro. Este módulo empieza solo con las
// funciones de normalización (base de la que depende todo lo demás); la
// ingesta de tarifas y la comparación en la extracción se añaden aquí en
// los siguientes commits.
//
// Las tres normalizaciones son puras (sin I/O) a propósito: se aplican
// tanto al escribir (importar tarifa, confirmar alias) como al leer
// (buscar proveedor, buscar alias) — si alguna vez divergen, el join deja
// de casar en silencio y todo cae a sin_tarifa sin que nadie sepa por qué.

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

module.exports = { normalizarNif, normalizarUnidad, normalizarTextoProducto };
