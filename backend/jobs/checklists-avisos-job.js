'use strict';
// Avisos de tareas con hora límite vencida — cron cada 15 min (ver
// index.js). Un email por checklist (ejecución) con TODAS sus tareas
// vencidas y aún sin avisar en esta pasada, no uno por tarea — para no
// bombardear al dueño con un email por cada tarea suelta. El "nunca dos
// veces" sigue siendo por tarea: el unique(ejecucion_id, tarea_id) de
// checklist_avisos (migración 047) es la red de seguridad; el Set en
// memoria evita además volver a intentarlo dentro de la misma pasada.
const { DateTime } = require('luxon');
const { supabase } = require('../lib/supabase');
const { ZONA } = require('../lib/fichaje-calc');
const { enviarAvisoChecklist } = require('../api/notifications');

async function runChecklistsAvisos() {
  const ahora = DateTime.now().setZone(ZONA);
  const hoy = ahora.toISODate();

  const { data: ejecuciones, error: errE } = await supabase
    .from('checklist_ejecuciones').select('id, cliente, local_id, checklist_id, fecha').eq('fecha', hoy);
  if (errE) throw new Error(`checklist_ejecuciones: ${errE.message}`);
  if (!ejecuciones.length) return { avisos: 0 };

  const checklistIds = [...new Set(ejecuciones.map(e => e.checklist_id))];
  const { data: tareas, error: errT } = await supabase
    .from('checklist_tareas').select('id, checklist_id, titulo, hora_limite')
    .in('checklist_id', checklistIds).eq('activo', true).not('hora_limite', 'is', null);
  if (errT) throw new Error(`checklist_tareas: ${errT.message}`);
  if (!tareas.length) return { avisos: 0 };

  const { data: checklists, error: errC } = await supabase
    .from('checklists').select('id, nombre').in('id', checklistIds);
  if (errC) throw new Error(`checklists: ${errC.message}`);
  const nombrePorChecklist = new Map(checklists.map(c => [c.id, c.nombre]));

  const tareasPorChecklist = new Map();
  for (const t of tareas) {
    if (!tareasPorChecklist.has(t.checklist_id)) tareasPorChecklist.set(t.checklist_id, []);
    tareasPorChecklist.get(t.checklist_id).push(t);
  }

  const ejecucionIds = ejecuciones.map(e => e.id);
  const { data: respuestas, error: errR } = await supabase
    .from('checklist_respuestas').select('ejecucion_id, tarea_id, hecho').in('ejecucion_id', ejecucionIds);
  if (errR) throw new Error(`checklist_respuestas: ${errR.message}`);
  const hechoSet = new Set(respuestas.filter(r => r.hecho).map(r => `${r.ejecucion_id}||${r.tarea_id}`));

  const { data: avisosExistentes, error: errAv } = await supabase
    .from('checklist_avisos').select('ejecucion_id, tarea_id').in('ejecucion_id', ejecucionIds);
  if (errAv) throw new Error(`checklist_avisos: ${errAv.message}`);
  const avisadoSet = new Set(avisosExistentes.map(a => `${a.ejecucion_id}||${a.tarea_id}`));

  const localIds = [...new Set(ejecuciones.map(e => e.local_id))];
  const { data: locales, error: errL } = await supabase
    .from('locales').select('id, nombre').in('id', localIds);
  if (errL) throw new Error(`locales: ${errL.message}`);
  const nombrePorLocal = new Map(locales.map(l => [l.id, l.nombre]));

  let registrados = 0;
  for (const ejecucion of ejecuciones) {
    const pendientes = (tareasPorChecklist.get(ejecucion.checklist_id) || []).filter(t => {
      const key = `${ejecucion.id}||${t.id}`;
      if (hechoSet.has(key) || avisadoSet.has(key)) return false;
      const limite = DateTime.fromISO(`${ejecucion.fecha}T${t.hora_limite}`, { zone: ZONA });
      return limite <= ahora;
    });
    if (!pendientes.length) continue;

    let resultadoEnvio = { enviado: false, destinatario: null };
    try {
      resultadoEnvio = await enviarAvisoChecklist({
        cliente: ejecucion.cliente,
        local: nombrePorLocal.get(ejecucion.local_id) || ejecucion.cliente,
        checklistNombre: nombrePorChecklist.get(ejecucion.checklist_id) || '(sin nombre)',
        tareas: pendientes.map(t => ({ titulo: t.titulo, hora_limite: t.hora_limite })),
      });
    } catch (e) {
      console.error(`[checklists-avisos] envío falló (ejecución ${ejecucion.id}):`, e.message);
    }

    const canal = resultadoEnvio.enviado ? 'email' : 'pendiente';
    const filas = pendientes.map(t => ({
      ejecucion_id: ejecucion.id, tarea_id: t.id, canal, destinatario: resultadoEnvio.destinatario || null,
    }));
    // upsert con ignoreDuplicates en vez de insert simple: si dos pasadas
    // del cron se solaparan, una tarea ya registrada por la otra no debe
    // tumbar el resto de filas de este mismo lote.
    const { error: errIns } = await supabase
      .from('checklist_avisos').upsert(filas, { onConflict: 'ejecucion_id,tarea_id', ignoreDuplicates: true });
    if (errIns) { console.error(`[checklists-avisos] no se pudo registrar el aviso (ejecución ${ejecucion.id}):`, errIns.message); continue; }
    for (const t of pendientes) avisadoSet.add(`${ejecucion.id}||${t.id}`);
    registrados += filas.length;
  }

  console.log(`[checklists-avisos] ${registrados} aviso(s) registrado(s)`);
  return { avisos: registrados };
}

module.exports = { runChecklistsAvisos };
