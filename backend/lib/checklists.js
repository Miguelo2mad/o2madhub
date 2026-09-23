'use strict';
// Checklists de turno: generación diaria de ejecuciones + tareas del día +
// guardado de respuestas. Sin fotos aquí (ver checklist-fotos.js, que este
// módulo llama para no acoplar Drive/EXIF/Claude al resto de la lógica).
const { DateTime } = require('luxon');
const { supabase } = require('./supabase');
const { ZONA, claveDia } = require('./fichaje-calc');

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
// nunca bloquea, solo avisa.
async function guardarRespuesta(tareaId, empleadoId, { hecho, valor, foto_drive_id, foto_tomada_at, foto_verificacion } = {}) {
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

  const { data: respuesta, error: errR } = await supabase
    .from('checklist_respuestas')
    .upsert({
      ejecucion_id: ejecucion.id, tarea_id: tareaId, empleado_id: empleadoId,
      hecho: !!hecho, valor: valor ?? null,
      foto_drive_id: foto_drive_id ?? null, foto_tomada_at: foto_tomada_at ?? null,
      foto_verificacion: foto_verificacion ?? null,
      fuera_rango: fueraRango, respondido_at: new Date().toISOString(),
    }, { onConflict: 'ejecucion_id,tarea_id' })
    .select().single();
  if (errR) throw new Error(`checklist_respuestas: ${errR.message}`);

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

module.exports = { generarEjecucionesDelDia, tareasDeHoy, guardarRespuesta, DIA_CODIGOS, codigoDia, hoyMadrid };
