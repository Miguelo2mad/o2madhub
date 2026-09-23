'use strict';
// Personal — gastos: nóminas y Seguridad Social como gasto archivado. Sin
// cálculo de nóminas: solo se guarda lo que manda la gestoría. Módulo
// reutilizable parametrizado por cliente, mismo patrón que banco.js —
// importar (vista previa, no guarda nada) → confirmar (guarda + sube a
// Drive). Ver migración 049 para el esquema.
//
// A diferencia de facturas (donde varias páginas subidas juntas son UN
// documento), aquí cada archivo subido es un documento independiente —
// normalmente una nómina de un empleado distinto, o un recibo de SS
// distinto — así que se extraen en paralelo y cada uno da una fila de
// vista previa propia.
const { buildFileBlock, extraerJson } = require('./claude-json');
const { supabase } = require('./supabase');
const { ensureFolderPath, uploadFile, deleteFile } = require('./google');
const { normalizarTextoProducto } = require('./tarifas');
const calc = require('./fichaje-calc');

const GASTO_PERSONAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tipo: {
      type: 'string',
      enum: ['nomina', 'seguridad_social'],
      description: 'nomina si es la nómina individual de un trabajador; seguridad_social si es un documento de cotización/liquidación a la Seguridad Social (RLC, RNT, recibo de liquidación...), normalmente sin desglose por trabajador',
    },
    periodo: { type: ['string', 'null'], description: 'Mes que cubre el documento, en formato YYYY-MM. null si no se puede determinar' },
    nombre_empleado: { type: ['string', 'null'], description: 'Nombre completo del trabajador tal como aparece en el documento. null si es un documento agregado de Seguridad Social sin un trabajador concreto' },
    importe_total: { type: ['number', 'null'], description: 'Importe final del documento en EUR: líquido a percibir en una nómina, o total a ingresar en un documento de Seguridad Social. null si no se encuentra' },
  },
  required: ['tipo', 'periodo', 'nombre_empleado', 'importe_total'],
};

const GASTO_PERSONAL_PROMPT = 'Extrae de este documento SOLO estos datos: tipo de documento (nomina si es la '
  + 'nómina individual de un trabajador; seguridad_social si es un documento de cotización o liquidación a la '
  + 'Seguridad Social, normalmente sin desglose por trabajador), periodo (mes que cubre, en formato YYYY-MM), '
  + 'nombre_empleado (nombre del trabajador tal como aparece en el documento, o null si es un documento agregado '
  + 'de Seguridad Social sin un trabajador concreto) e importe_total (el importe final en EUR: líquido a percibir '
  + 'en una nómina, o total a ingresar en un documento de Seguridad Social). '
  + 'NO extraigas bases de cotización, IRPF, ni ningún otro desglose. Si un campo no aparece devuelve null.';

function origenDeMime(mimeType) {
  return mimeType.startsWith('image/') ? 'foto' : 'pdf';
}

function periodoDesdeMes(mesStr) {
  return /^\d{4}-\d{2}$/.test(mesStr || '') ? `${mesStr}-01` : null;
}

// Busca un empleado activo o no del cliente cuyo nombre normalizado
// coincida EXACTO con el extraído — sin fuzzy matching: un falso positivo
// aquí asigna la nómina de una persona a otra. Si no hay match exacto, la
// vista previa lo deja pendiente para que el usuario lo asigne a mano.
async function emparejarEmpleado(cliente, nombreExtraido) {
  if (!nombreExtraido) return null;
  const { data, error } = await supabase.from('empleados').select('id, nombre').eq('cliente', cliente);
  if (error) throw new Error(`empleados: ${error.message}`);
  const norm = normalizarTextoProducto(nombreExtraido);
  const match = data.find(e => normalizarTextoProducto(e.nombre) === norm);
  return match ? match.id : null;
}

// Extrae un único documento. Nunca lanza: si Claude falla o la respuesta
// llega truncada tras su propio reintento (ver claude-json.js), la fila de
// vista previa sale con error y el usuario la rellena a mano en vez de que
// un documento roto tumbe la subida entera.
async function extraerUnGasto(cliente, archivo) {
  const base = {
    archivo_nombre: archivo.nombre,
    archivo_mime: archivo.mimeType,
    archivo_base64: archivo.buffer.toString('base64'),
    origen: origenDeMime(archivo.mimeType),
  };
  try {
    const { data } = await extraerJson({
      maxTokens: 512,
      schema: GASTO_PERSONAL_SCHEMA,
      content: [buildFileBlock(archivo.buffer, archivo.mimeType), { type: 'text', text: GASTO_PERSONAL_PROMPT }],
      mensajeError: 'La IA no pudo leer este documento. Complétalo a mano o vuelve a intentar la subida.',
    });
    const periodo = periodoDesdeMes(data.periodo);
    const empleado_id = await emparejarEmpleado(cliente, data.nombre_empleado);
    return {
      ...base,
      tipo: data.tipo,
      periodo,
      importe: data.importe_total,
      nombre_extraido: data.nombre_empleado,
      empleado_id,
      requiere_revision: !periodo || data.importe_total == null || (data.tipo === 'nomina' && !empleado_id),
      error: null,
    };
  } catch (e) {
    console.error(`[gastos-personal:${cliente}] extracción de "${archivo.nombre}" falló:`, e.message);
    return {
      ...base,
      tipo: null, periodo: null, importe: null, nombre_extraido: null, empleado_id: null,
      requiere_revision: true,
      error: e.message,
    };
  }
}

async function construirPreview(cliente, archivos) {
  return Promise.all(archivos.map(a => extraerUnGasto(cliente, a)));
}

// Guarda las filas ya revisadas por el usuario (vista previa editada) y sube
// cada documento a Drive en cliente/personal/AAAA-MM/ — mismo árbol que
// checklist-fotos.js (cliente/checklists/AAAA-MM/), no el de facturas. Los
// `items` vienen tal cual del frontend: mismo shape que devuelve
// construirPreview, con tipo/periodo/empleado_id/importe ya corregidos a
// mano si hacía falta.
async function confirmarGastos(cliente, items) {
  if (!Array.isArray(items) || !items.length) throw new Error('Se requiere al menos un gasto');

  const guardados = [];
  const errores = [];

  for (const item of items) {
    try {
      if (!['nomina', 'seguridad_social'].includes(item.tipo)) throw new Error('tipo debe ser nomina o seguridad_social');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item.periodo || '')) throw new Error('periodo inválido');
      const importe = Number(item.importe);
      if (!Number.isFinite(importe) || importe <= 0) throw new Error('importe inválido');

      let drive_file_id = null;
      if (item.archivo_base64) {
        const folderId = await ensureFolderPath([cliente, 'personal', item.periodo.slice(0, 7)]);
        const ext = item.archivo_mime === 'application/pdf' ? 'pdf' : 'jpg';
        const fileName = (item.archivo_nombre || `gasto-${Date.now()}`).replace(/[/\\:*?"<>|]/g, '-');
        const uploaded = await uploadFile(`${fileName}.${ext}`, Buffer.from(item.archivo_base64, 'base64'), folderId, item.archivo_mime);
        drive_file_id = uploaded.id;
      }

      const { data, error } = await supabase.from('gastos_personal').insert({
        cliente,
        tipo: item.tipo,
        empleado_id: item.empleado_id || null,
        periodo: item.periodo,
        importe,
        drive_file_id,
        origen: item.origen || (item.archivo_base64 ? origenDeMime(item.archivo_mime) : 'manual'),
      }).select().single();
      if (error) throw new Error(error.code === '23505' ? 'Ya existe una nómina de este empleado para este periodo' : error.message);
      guardados.push(data);
    } catch (e) {
      console.error(`[gastos-personal:${cliente}] no se pudo guardar "${item.archivo_nombre || item.nombre_extraido}":`, e.message);
      errores.push({ archivo_nombre: item.archivo_nombre || null, nombre_extraido: item.nombre_extraido || null, error: e.message });
    }
  }

  return { guardados: guardados.length, errores };
}

async function altaManual(cliente, { tipo, periodo, empleado_id, importe }) {
  if (!['nomina', 'seguridad_social'].includes(tipo)) throw new Error('tipo debe ser nomina o seguridad_social');
  const periodoIso = periodoDesdeMes(periodo) || (/^\d{4}-\d{2}-\d{2}$/.test(periodo || '') ? periodo : null);
  if (!periodoIso) throw new Error('periodo inválido (usa YYYY-MM)');
  const importeNum = Number(importe);
  if (!Number.isFinite(importeNum) || importeNum <= 0) throw new Error('importe debe ser un número mayor que 0');

  const { data, error } = await supabase.from('gastos_personal').insert({
    cliente, tipo, empleado_id: empleado_id || null, periodo: periodoIso, importe: importeNum,
    drive_file_id: null, origen: 'manual',
  }).select().single();
  if (error) throw new Error(error.code === '23505' ? 'Ya existe una nómina de este empleado para este periodo' : error.message);
  return data;
}

async function listarGastos(cliente, { mes } = {}) {
  let q = supabase.from('gastos_personal').select('*').eq('cliente', cliente).order('periodo', { ascending: false });
  if (mes) {
    const periodoIso = periodoDesdeMes(mes);
    if (!periodoIso) throw new Error('mes inválido (usa YYYY-MM)');
    q = q.eq('periodo', periodoIso);
  }
  const { data, error } = await q;
  if (error) throw new Error(`gastos_personal: ${error.message}`);

  const empleadoIds = [...new Set(data.map(g => g.empleado_id).filter(Boolean))];
  const { data: empleados, error: errE } = empleadoIds.length
    ? await supabase.from('empleados').select('id, nombre').in('id', empleadoIds)
    : { data: [] };
  if (errE) throw new Error(`empleados: ${errE.message}`);
  const nombrePorId = new Map(empleados.map(e => [e.id, e.nombre]));

  return data.map(g => ({ ...g, empleado_nombre: g.empleado_id ? (nombrePorId.get(g.empleado_id) || null) : null }));
}

async function borrarGasto(cliente, id) {
  const { data: gasto, error: errG } = await supabase
    .from('gastos_personal').select('id, drive_file_id').eq('cliente', cliente).eq('id', id).maybeSingle();
  if (errG) throw new Error(`gastos_personal: ${errG.message}`);
  if (!gasto) throw new Error('Gasto no encontrado');

  let driveDeleted = false;
  if (gasto.drive_file_id) {
    try {
      await deleteFile(gasto.drive_file_id);
      driveDeleted = true;
    } catch (e) {
      console.warn(`[gastos-personal:${cliente}] no se pudo borrar el archivo de Drive (${gasto.drive_file_id}): ${e.message}`);
    }
  }

  const { error } = await supabase.from('gastos_personal').delete().eq('cliente', cliente).eq('id', id);
  if (error) throw new Error(`gastos_personal: ${error.message}`);
  return { driveDeleted };
}

// ── Analytics ────────────────────────────────────────────────────────────
// Coste de personal de un mes: nóminas + Seguridad Social ya archivadas +
// coste de horas extra del fichaje (backend/lib/fichaje-calc.js), con la
// misma fórmula por empleado que el informe mensual de fichaje
// (totalExtras * precio_hora_extra — ver backend/api/fichaje.js).
async function calcularCosteMes(cliente, mesInput) {
  const mes = /^\d{4}-\d{2}$/.test(mesInput || '') ? mesInput : new Date().toISOString().slice(0, 7);
  const gastos = await listarGastos(cliente, { mes });
  const nominas = gastos.filter(g => g.tipo === 'nomina');
  const seguridadSocial = gastos.filter(g => g.tipo === 'seguridad_social');
  const totalNominas = nominas.reduce((s, g) => s + Number(g.importe), 0);
  const totalSeguridadSocial = seguridadSocial.reduce((s, g) => s + Number(g.importe), 0);

  const [year, month] = mes.split('-').map(Number);
  const { data: empleados, error: errE } = await supabase
    .from('empleados').select('id, nombre, horas_semana, precio_hora_extra').eq('cliente', cliente);
  if (errE) throw new Error(`empleados: ${errE.message}`);

  const empleadoIds = empleados.map(e => e.id);
  const { data: fichajes, error: errF } = empleadoIds.length
    ? await supabase.from('fichajes').select('empleado_id, entrada_at, salida_at, incidencia').in('empleado_id', empleadoIds)
    : { data: [] };
  if (errF) throw new Error(`fichajes: ${errF.message}`);

  const ahora = new Date();
  const horasExtra = empleados.map(emp => {
    const propios = fichajes.filter(f => f.empleado_id === emp.id && !f.incidencia);
    const { totalExtras } = calc.calcularExtrasMes(propios, Number(emp.horas_semana), year, month, ahora);
    return { empleado_id: emp.id, empleado_nombre: emp.nombre, horas_extra: totalExtras, importe: totalExtras * Number(emp.precio_hora_extra) };
  }).filter(h => h.horas_extra > 0);
  const totalHorasExtra = horasExtra.reduce((s, h) => s + h.importe, 0);

  return {
    mes,
    nominas: { detalle: nominas, total: totalNominas },
    seguridad_social: { detalle: seguridadSocial, total: totalSeguridadSocial },
    horas_extra: { detalle: horasExtra, total: totalHorasExtra },
    total: totalNominas + totalSeguridadSocial + totalHorasExtra,
  };
}

module.exports = {
  construirPreview, confirmarGastos, altaManual, listarGastos, borrarGasto,
  periodoDesdeMes, calcularCosteMes, GASTO_PERSONAL_SCHEMA,
};
