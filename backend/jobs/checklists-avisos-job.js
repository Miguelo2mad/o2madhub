'use strict';
// Avisos de tareas con hora límite vencida — cron cada 15 min (ver
// index.js). Un aviso por tarea y ejecución (= por tarea y día, ya que hay
// una ejecución por checklist y día): el unique(ejecucion_id, tarea_id) de
// checklist_avisos (migración 047) es la red de seguridad; el Set en
// memoria evita además volver a intentarlo dentro de la misma pasada.
const { DateTime } = require('luxon');
const { supabase } = require('../lib/supabase');
const { ZONA } = require('../lib/fichaje-calc');
const { enviarAvisoWhatsapp } = require('../api/notifications');

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
    .from('locales').select('id, nombre, numero_whatsapp_avisos').in('id', localIds);
  if (errL) throw new Error(`locales: ${errL.message}`);
  const localPorId = new Map(locales.map(l => [l.id, l]));

  let registrados = 0;
  for (const ejecucion of ejecuciones) {
    for (const tarea of (tareasPorChecklist.get(ejecucion.checklist_id) || [])) {
      const key = `${ejecucion.id}||${tarea.id}`;
      if (hechoSet.has(key) || avisadoSet.has(key)) continue;

      const limite = DateTime.fromISO(`${ejecucion.fecha}T${tarea.hora_limite}`, { zone: ZONA });
      if (limite > ahora) continue;

      const local = localPorId.get(ejecucion.local_id);
      const numero = local?.numero_whatsapp_avisos || null;

      let resultadoEnvio = { enviado: false };
      try {
        resultadoEnvio = await enviarAvisoWhatsapp({
          numero,
          mensaje: `⚠ ${local?.nombre || ejecucion.cliente}: la tarea "${tarea.titulo}" no se ha completado (hora límite ${tarea.hora_limite}).`,
        });
      } catch (e) {
        console.error(`[checklists-avisos] envío falló (ejecución ${ejecucion.id}, tarea ${tarea.id}):`, e.message);
      }

      const { error: errIns } = await supabase.from('checklist_avisos').insert({
        ejecucion_id: ejecucion.id, tarea_id: tarea.id,
        canal: resultadoEnvio.enviado ? 'whatsapp' : 'pendiente',
        destinatario: numero,
      });
      if (errIns) { console.error('[checklists-avisos] no se pudo registrar el aviso:', errIns.message); continue; }
      avisadoSet.add(key);
      registrados++;
    }
  }

  console.log(`[checklists-avisos] ${registrados} aviso(s) registrado(s)`);
  return { avisos: registrados };
}

module.exports = { runChecklistsAvisos };
