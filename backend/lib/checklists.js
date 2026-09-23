'use strict';
// Checklists de turno: generación diaria de ejecuciones + tareas del día +
// guardado de respuestas. Sin fotos aquí (ver checklist-fotos.js, que este
// módulo llama para no acoplar Drive/EXIF/Claude al resto de la lógica).
const { DateTime } = require('luxon');
const { supabase } = require('./supabase');
const { ZONA, claveDia } = require('./fichaje-calc');
const checklistFotos = require('./checklist-fotos');
const { PLANTILLAS } = require('./checklist-plantillas');

const DIA_CODIGOS = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'];

function hoyMadrid() {
  return DateTime.now().setZone(ZONA);
}

function codigoDia(dt) {
  return DIA_CODIGOS[dt.weekday - 1];
}

// ── Generación diaria ────────────────────────────────────────────────────
// Idempotente por el unique(checklist_id, fecha) de la migración 047: se
// puede llamar tantas veces como haga falta (cron de las 05:00 y, además,
// bajo demanda si un empleado abre su pantalla antes o el cron falló) sin
// duplicar nada — un upsert con ignoreDuplicates simplemente no hace nada
// en las que ya existen.
async function generarEjecucionesDelDia(cliente, fechaIso) {
  const dt = fechaIso ? DateTime.fromISO(fechaIso, { zone: ZONA }) : hoyMadrid();
  const fecha = dt.toISODate();
  const codigoHoy = codigoDia(dt);

  const { data: locales, error: errL } = await supabase
    .from('locales').select('id, dias_apertura')
    .eq('cliente', cliente).eq('activo', true);
  if (errL) throw new Error(`locales: ${errL.message}`);

  const localesAbiertos = locales.filter(l => (l.dias_apertura || []).includes(codigoHoy));
  if (!localesAbiertos.length) return { creadas: 0 };

  const localIds = localesAbiertos.map(l => l.id);
  const { data: checklists, error: errC } = await supabase
    .from('checklists').select('id, local_id, dias_semana')
    .in('local_id', localIds).eq('activo', true);
  if (errC) throw new Error(`checklists: ${errC.message}`);

  const aplicables = checklists.filter(c => !c.dias_semana || c.dias_semana.includes(codigoHoy));
  if (!aplicables.length) return { creadas: 0 };

  const filas = aplicables.map(c => ({
    cliente, local_id: c.local_id, checklist_id: c.id, fecha, estado: 'pendiente',
  }));

  const { data: creadas, error: errI } = await supabase
    .from('checklist_ejecuciones')
    .upsert(filas, { onConflict: 'checklist_id,fecha', ignoreDuplicates: true })
    .select();
  if (errI) throw new Error(`checklist_ejecuciones: ${errI.message}`);

  return { creadas: creadas.length };
}

// ── Tareas de hoy (empleado) ─────────────────────────────────────────────
async function tareasDeHoy(empleadoId) {
  const { data: empleado, error: errE } = await supabase
    .from('empleados').select('id, cliente, local_id').eq('id', empleadoId).maybeSingle();
  if (errE) throw new Error(`empleados: ${errE.message}`);
  if (!empleado) throw new Error('Empleado no encontrado');
  if (!empleado.local_id) return { turnos: [] }; // sin local asignado, nada que mostrar

  await generarEjecucionesDelDia(empleado.cliente);
  const fecha = hoyMadrid().toISODate();

  const { data: asignaciones, error: errA } = await supabase
    .from('checklist_asignaciones').select('checklist_id').eq('empleado_id', empleadoId);
  if (errA) throw new Error(`checklist_asignaciones: ${errA.message}`);
  if (!asignaciones.length) return { turnos: [] };

  const checklistIds = asignaciones.map(a => a.checklist_id);
  const { data: checklists, error: errC } = await supabase
    .from('checklists').select('id, nombre, turno, local_id')
    .in('id', checklistIds).eq('local_id', empleado.local_id).eq('activo', true);
  if (errC) throw new Error(`checklists: ${errC.message}`);
  if (!checklists.length) return { turnos: [] };

  const { data: ejecuciones, error: errEj } = await supabase
    .from('checklist_ejecuciones').select('id, checklist_id, estado, empleado_id')
    .in('checklist_id', checklists.map(c => c.id)).eq('fecha', fecha);
  if (errEj) throw new Error(`checklist_ejecuciones: ${errEj.message}`);
  const ejecucionPorChecklist = new Map(ejecuciones.map(e => [e.checklist_id, e]));

  const { data: tareas, error: errT } = await supabase
    .from('checklist_tareas').select('*')
    .in('checklist_id', checklists.map(c => c.id)).eq('activo', true)
    .order('orden', { ascending: true });
  if (errT) throw new Error(`checklist_tareas: ${errT.message}`);

  const ejecucionIds = ejecuciones.map(e => e.id);
  let respuestas = [];
  if (ejecucionIds.length) {
    const { data, error: errR } = await supabase
      .from('checklist_respuestas').select('*').in('ejecucion_id', ejecucionIds);
    if (errR) throw new Error(`checklist_respuestas: ${errR.message}`);
    respuestas = data;
  }
  const respuestaPorTarea = new Map(respuestas.map(r => [`${r.ejecucion_id}||${r.tarea_id}`, r]));

  const turnos = checklists.map(c => {
    const ejecucion = ejecucionPorChecklist.get(c.id) || null;
    const tareasChecklist = tareas
      .filter(t => t.checklist_id === c.id)
      .map(t => ({
        id: t.id,
        titulo: t.titulo,
        descripcion: t.descripcion,
        requiere_foto: t.requiere_foto,
        requiere_valor: t.requiere_valor,
        valor_etiqueta: t.valor_etiqueta,
        valor_min: t.valor_min,
        valor_max: t.valor_max,
        hora_limite: t.hora_limite,
        respuesta: ejecucion ? respuestaPorTarea.get(`${ejecucion.id}||${t.id}`) || null : null,
      }));
    return {
      checklist: { id: c.id, nombre: c.nombre, turno: c.turno },
      ejecucion: ejecucion ? { id: ejecucion.id, estado: ejecucion.estado } : null,
      tareas: tareasChecklist,
    };
  });

  return { turnos };
}

// ── Guardar una respuesta ────────────────────────────────────────────────
// Sin foto en esta función a propósito — checklist-fotos.js se encarga de
// subir y verificar, y llama a esta función ya con foto_drive_id resuelto.
// Un valor fuera de rango se guarda igual (fuera_rango=true): el checklist
// nunca bloquea, solo avisa. La foto (si llega) se sube a Drive de forma
// SÍNCRONA (hace falta el foto_drive_id antes de guardar la respuesta),
// pero la verificación con Claude es asíncrona — nunca se espera para
// responder al empleado; si falla, la respuesta ya quedó guardada y es
// revisable a mano (PATCH /respuestas/:id/validar).
async function guardarRespuesta(tareaId, empleadoId, { hecho, valor, fotoBuffer, fotoMime } = {}) {
  const { data: tarea, error: errT } = await supabase
    .from('checklist_tareas').select('*').eq('id', tareaId).maybeSingle();
  if (errT) throw new Error(`checklist_tareas: ${errT.message}`);
  if (!tarea) throw new Error('Tarea no encontrada');

  const { data: checklist, error: errCl } = await supabase
    .from('checklists').select('id, cliente, local_id').eq('id', tarea.checklist_id).maybeSingle();
  if (errCl) throw new Error(`checklists: ${errCl.message}`);
  if (!checklist) throw new Error('Checklist no encontrado');

  const fecha = hoyMadrid().toISODate();
  await generarEjecucionesDelDia(checklist.cliente);
  const { data: ejecucion, error: errE } = await supabase
    .from('checklist_ejecuciones').select('id, checklist_id, estado, empleado_id')
    .eq('checklist_id', tarea.checklist_id).eq('fecha', fecha).maybeSingle();
  if (errE) throw new Error(`checklist_ejecuciones: ${errE.message}`);
  if (!ejecucion) throw new Error('No hay ejecución de hoy para este checklist (¿el local no abre hoy?)');

  let fueraRango = false;
  if (tarea.requiere_valor && valor != null) {
    if (tarea.valor_min != null && Number(valor) < Number(tarea.valor_min)) fueraRango = true;
    if (tarea.valor_max != null && Number(valor) > Number(tarea.valor_max)) fueraRango = true;
  }

  let fotoInfo = { foto_drive_id: null, foto_tomada_at: null, foto_verificacion: null };
  if (fotoBuffer) {
    try {
      const { foto_drive_id, foto_tomada_at, foto_antigua } = await checklistFotos.subirFotoTarea({
        cliente: checklist.cliente, fecha, tareaId, buffer: fotoBuffer, mimeType: fotoMime,
      });
      fotoInfo = { foto_drive_id, foto_tomada_at, foto_verificacion: { foto_antigua } };
    } catch (e) {
      // Subir a Drive puede fallar (cuota, red...): la respuesta se guarda
      // igual, sin foto, en vez de perder que la tarea se marcó hecha.
      console.error(`[checklists] subida de foto falló (tarea ${tareaId}):`, e.message);
    }
  }

  const { data: respuesta, error: errR } = await supabase
    .from('checklist_respuestas')
    .upsert({
      ejecucion_id: ejecucion.id, tarea_id: tareaId, empleado_id: empleadoId,
      hecho: !!hecho, valor: valor ?? null,
      ...fotoInfo,
      fuera_rango: fueraRango, respondido_at: new Date().toISOString(),
    }, { onConflict: 'ejecucion_id,tarea_id' })
    .select().single();
  if (errR) throw new Error(`checklist_respuestas: ${errR.message}`);

  if (fotoBuffer && fotoInfo.foto_drive_id) {
    checklistFotos.verificarFoto(fotoBuffer, fotoMime, tarea.descripcion || tarea.titulo)
      .then(async (verificacion) => {
        const { error: errV } = await supabase
          .from('checklist_respuestas')
          .update({ foto_verificacion: { ...fotoInfo.foto_verificacion, ...verificacion } })
          .eq('id', respuesta.id);
        if (errV) console.error(`[checklists] no se pudo guardar la verificación (respuesta ${respuesta.id}):`, errV.message);
      })
      .catch(e => console.error(`[checklists] verificación de foto falló (respuesta ${respuesta.id}):`, e.message));
  }

  await actualizarEstadoEjecucion(ejecucion, empleadoId);

  return { respuesta, fuera_rango: fueraRango };
}

// Pendiente → en_curso en la primera respuesta (fija empleado_id);
// → completado cuando ya no queda ninguna tarea activa sin responder.
async function actualizarEstadoEjecucion(ejecucion, empleadoId) {
  const { data: tareas, error: errT } = await supabase
    .from('checklist_tareas').select('id').eq('checklist_id', ejecucion.checklist_id).eq('activo', true);
  if (errT) throw new Error(`checklist_tareas: ${errT.message}`);

  const { data: respuestas, error: errR } = await supabase
    .from('checklist_respuestas').select('tarea_id').eq('ejecucion_id', ejecucion.id);
  if (errR) throw new Error(`checklist_respuestas: ${errR.message}`);
  const respondidas = new Set(respuestas.map(r => r.tarea_id));
  const completo = tareas.every(t => respondidas.has(t.id));

  const patch = { estado: completo ? 'completado' : 'en_curso' };
  if (!ejecucion.empleado_id) patch.empleado_id = empleadoId;
  if (!ejecucion.iniciado_at && ejecucion.estado === 'pendiente') patch.iniciado_at = new Date().toISOString();
  if (completo) patch.completado_at = new Date().toISOString();

  const { error: errU } = await supabase.from('checklist_ejecuciones').update(patch).eq('id', ejecucion.id);
  if (errU) throw new Error(`checklist_ejecuciones: ${errU.message}`);
}

// ── Alta/edición completa de un checklist (panel único del dueño) ───────
function normalizarTarea(t) {
  return {
    titulo: String(t.titulo || '').trim(),
    descripcion: t.descripcion || null,
    requiere_foto: !!t.requiere_foto,
    hora_limite: t.hora_limite || null,
    requiere_valor: !!t.requiere_valor,
    valor_etiqueta: t.requiere_valor ? (t.valor_etiqueta || null) : null,
    valor_min: t.requiere_valor && t.valor_min !== '' && t.valor_min != null ? Number(t.valor_min) : null,
    valor_max: t.requiere_valor && t.valor_max !== '' && t.valor_max != null ? Number(t.valor_max) : null,
  };
}

function validarChecklistCompleto({ nombre, local_id, turno, tareas }) {
  if (!nombre || !String(nombre).trim()) throw new Error('Falta el nombre del checklist');
  if (!local_id) throw new Error('Falta el local');
  if (!['apertura', 'tarde', 'cierre', 'libre'].includes(turno)) throw new Error('Turno inválido');
  for (const t of (tareas || [])) {
    if (!t.titulo || !String(t.titulo).trim()) throw new Error('Cada tarea necesita un título');
  }
}

// Crea checklist + tareas + asignaciones en un solo alta. No es una
// transacción real de base de datos (Supabase-js no las ofrece a través de
// varias tablas) — es mejor esfuerzo: si tareas o asignaciones fallan tras
// crear el checklist, se borra ese checklist recién creado en vez de
// dejarlo huérfano y vacío en el listado.
async function crearChecklistCompleto(cliente, datos) {
  validarChecklistCompleto(datos);
  const { nombre, local_id, turno, tareas = [], empleado_ids = [] } = datos;

  const { data: checklist, error: errC } = await supabase
    .from('checklists').insert({ cliente, local_id, nombre: nombre.trim(), turno, dias_semana: null })
    .select().single();
  if (errC) throw new Error(`checklists: ${errC.message}`);

  try {
    if (tareas.length) {
      const filas = tareas.map((t, i) => ({ checklist_id: checklist.id, orden: i + 1, ...normalizarTarea(t) }));
      const { error: errT } = await supabase.from('checklist_tareas').insert(filas);
      if (errT) throw new Error(`checklist_tareas: ${errT.message}`);
    }
    if (empleado_ids.length) {
      const filas = empleado_ids.map(empleado_id => ({ checklist_id: checklist.id, empleado_id }));
      const { error: errA } = await supabase.from('checklist_asignaciones').insert(filas);
      if (errA) throw new Error(`checklist_asignaciones: ${errA.message}`);
    }
  } catch (e) {
    await supabase.from('checklists').delete().eq('id', checklist.id);
    throw e;
  }

  return checklist;
}

// Edición: actualiza el checklist, hace upsert de tareas por id (las que ya
// no vienen se desactivan, NUNCA se borran — checklist_respuestas.tarea_id
// no tiene on delete cascade a propósito, así que una tarea con historial
// no se puede borrar sin perder ese historial) y reemplaza asignaciones
// (sin historial que perder, esas sí se borran/insertan sin más).
async function actualizarChecklistCompleto(cliente, checklistId, datos) {
  validarChecklistCompleto(datos);
  const { nombre, local_id, turno, tareas = [], empleado_ids = [] } = datos;

  const { data: checklist, error: errC } = await supabase
    .from('checklists').update({ nombre: nombre.trim(), local_id, turno })
    .eq('id', checklistId).eq('cliente', cliente)
    .select().maybeSingle();
  if (errC) throw new Error(`checklists: ${errC.message}`);
  if (!checklist) throw new Error('Checklist no encontrado');

  const { data: tareasExistentes, error: errTE } = await supabase
    .from('checklist_tareas').select('id').eq('checklist_id', checklistId);
  if (errTE) throw new Error(`checklist_tareas: ${errTE.message}`);
  const idsExistentes = new Set(tareasExistentes.map(t => t.id));
  const idsEnviados = new Set(tareas.filter(t => t.id).map(t => t.id));

  for (let i = 0; i < tareas.length; i++) {
    const datosT = { ...normalizarTarea(tareas[i]), orden: i + 1, activo: true };
    if (tareas[i].id) {
      const { error } = await supabase.from('checklist_tareas').update(datosT).eq('id', tareas[i].id);
      if (error) throw new Error(`checklist_tareas: ${error.message}`);
    } else {
      const { error } = await supabase.from('checklist_tareas').insert({ ...datosT, checklist_id: checklistId });
      if (error) throw new Error(`checklist_tareas: ${error.message}`);
    }
  }
  const idsABorrar = [...idsExistentes].filter(id => !idsEnviados.has(id));
  if (idsABorrar.length) {
    const { error } = await supabase.from('checklist_tareas').update({ activo: false }).in('id', idsABorrar);
    if (error) throw new Error(`checklist_tareas: ${error.message}`);
  }

  const { data: asignacionesActuales, error: errAE } = await supabase
    .from('checklist_asignaciones').select('id, empleado_id').eq('checklist_id', checklistId);
  if (errAE) throw new Error(`checklist_asignaciones: ${errAE.message}`);
  const empleadosActuales = new Set(asignacionesActuales.map(a => a.empleado_id));
  const empleadosNuevos = new Set(empleado_ids);
  const aQuitar = asignacionesActuales.filter(a => !empleadosNuevos.has(a.empleado_id)).map(a => a.id);
  const aAnadir = empleado_ids.filter(id => !empleadosActuales.has(id));
  if (aQuitar.length) {
    const { error } = await supabase.from('checklist_asignaciones').delete().in('id', aQuitar);
    if (error) throw new Error(`checklist_asignaciones: ${error.message}`);
  }
  if (aAnadir.length) {
    const { error } = await supabase.from('checklist_asignaciones').insert(aAnadir.map(empleado_id => ({ checklist_id: checklistId, empleado_id })));
    if (error) throw new Error(`checklist_asignaciones: ${error.message}`);
  }

  return checklist;
}

// Duplica un checklist (con sus tareas, sin asignaciones — un empleado de
// un local no tiene por qué serlo del local destino) a otro local, para
// "pasar Apertura cocina a otro local" sin escribirlo de cero.
async function duplicarChecklist(cliente, checklistId, localDestinoId) {
  const { data: original, error: errO } = await supabase
    .from('checklists').select('*').eq('id', checklistId).eq('cliente', cliente).maybeSingle();
  if (errO) throw new Error(`checklists: ${errO.message}`);
  if (!original) throw new Error('Checklist no encontrado');

  const { data: tareas, error: errT } = await supabase
    .from('checklist_tareas').select('*').eq('checklist_id', checklistId).eq('activo', true).order('orden');
  if (errT) throw new Error(`checklist_tareas: ${errT.message}`);

  return crearChecklistCompleto(cliente, {
    nombre: `${original.nombre} (copia)`,
    local_id: localDestinoId || original.local_id,
    turno: original.turno,
    tareas: tareas.map(t => ({ ...t, id: undefined })),
    empleado_ids: [],
  });
}

// Plantillas en un clic: crea un checklist completo con las tareas típicas
// para un local, asignado a todos sus empleados activos.
async function crearDesdeePlantilla(cliente, localId, nombrePlantilla) {
  const plantilla = PLANTILLAS.find(p => p.nombre === nombrePlantilla);
  if (!plantilla) throw new Error(`Plantilla desconocida: "${nombrePlantilla}"`);

  const { data: empleados, error: errE } = await supabase
    .from('empleados').select('id').eq('cliente', cliente).eq('local_id', localId).eq('activo', true);
  if (errE) throw new Error(`empleados: ${errE.message}`);

  return crearChecklistCompleto(cliente, {
    nombre: plantilla.nombre,
    local_id: localId,
    turno: plantilla.turno,
    tareas: plantilla.tareas,
    empleado_ids: empleados.map(e => e.id),
  });
}

module.exports = {
  generarEjecucionesDelDia, tareasDeHoy, guardarRespuesta, DIA_CODIGOS, codigoDia, hoyMadrid,
  crearChecklistCompleto, actualizarChecklistCompleto, duplicarChecklist, crearDesdeePlantilla,
};
