'use strict';
// Informe PDF de checklists — el registro para Sanidad: todas las
// ejecuciones de un rango de fechas (y opcionalmente un local), con sus
// tareas, valores y una miniatura de cada foto. Descargar cada foto de
// Drive puede fallar (cuota, red, archivo borrado a mano) — nunca aborta
// el informe entero, esa fila simplemente sale sin miniatura.
const PDFDocument = require('pdfkit');
const { supabase } = require('./supabase');
const { drive } = require('./google');

async function descargarFotoDrive(fileId) {
  try {
    const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    return Buffer.from(res.data);
  } catch (e) {
    console.error(`[checklist-informe] no se pudo descargar la foto ${fileId}:`, e.message);
    return null;
  }
}

async function generarInformeChecklistsPDF({ cliente, desde, hasta, localId }) {
  let q = supabase.from('checklist_ejecuciones').select('*').eq('cliente', cliente).gte('fecha', desde).lte('fecha', hasta).order('fecha');
  if (localId) q = q.eq('local_id', localId);
  const { data: ejecuciones, error } = await q;
  if (error) throw new Error(`checklist_ejecuciones: ${error.message}`);

  const checklistIds = [...new Set(ejecuciones.map(e => e.checklist_id))];
  const { data: checklists, error: errC } = checklistIds.length
    ? await supabase.from('checklists').select('id, nombre, turno').in('id', checklistIds)
    : { data: [] };
  if (errC) throw new Error(`checklists: ${errC.message}`);
  const checklistPorId = new Map(checklists.map(c => [c.id, c]));

  const localIds = [...new Set(ejecuciones.map(e => e.local_id))];
  const { data: locales, error: errL } = localIds.length
    ? await supabase.from('locales').select('id, nombre').in('id', localIds)
    : { data: [] };
  if (errL) throw new Error(`locales: ${errL.message}`);
  const localPorId = new Map(locales.map(l => [l.id, l.nombre]));

  const empleadoIds = [...new Set(ejecuciones.map(e => e.empleado_id).filter(Boolean))];
  const { data: empleados, error: errE } = empleadoIds.length
    ? await supabase.from('empleados').select('id, nombre').in('id', empleadoIds)
    : { data: [] };
  if (errE) throw new Error(`empleados: ${errE.message}`);
  const empleadoPorId = new Map(empleados.map(e => [e.id, e.nombre]));

  const { data: tareasTodas, error: errT } = checklistIds.length
    ? await supabase.from('checklist_tareas').select('*').in('checklist_id', checklistIds).order('orden')
    : { data: [] };
  if (errT) throw new Error(`checklist_tareas: ${errT.message}`);
  const tareasPorChecklist = new Map();
  for (const t of tareasTodas) {
    if (!tareasPorChecklist.has(t.checklist_id)) tareasPorChecklist.set(t.checklist_id, []);
    tareasPorChecklist.get(t.checklist_id).push(t);
  }

  const ejecucionIds = ejecuciones.map(e => e.id);
  const { data: respuestas, error: errR } = ejecucionIds.length
    ? await supabase.from('checklist_respuestas').select('*').in('ejecucion_id', ejecucionIds)
    : { data: [] };
  if (errR) throw new Error(`checklist_respuestas: ${errR.message}`);
  const respuestaPorTarea = new Map(respuestas.map(r => [`${r.ejecucion_id}||${r.tarea_id}`, r]));

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const fin = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.fontSize(16).fillColor('#000').text(`Informe de checklists — ${cliente}`);
  doc.fontSize(10).fillColor('#666').text(`${desde} a ${hasta}${localId ? ` · local ${localPorId.get(Number(localId)) || localId}` : ''}`);
  doc.moveDown();

  if (!ejecuciones.length) {
    doc.fillColor('#000').fontSize(11).text('Sin ejecuciones en este periodo.');
  }

  for (const ejecucion of ejecuciones) {
    const checklist = checklistPorId.get(ejecucion.checklist_id);
    if (doc.y > 700) doc.addPage();

    doc.moveDown(0.6);
    doc.fillColor('#000').fontSize(12)
      .text(`${ejecucion.fecha} — ${localPorId.get(ejecucion.local_id) || ''} — ${checklist?.nombre || ''} (${checklist?.turno || ''})`, { underline: true });
    doc.fontSize(10).fillColor('#444')
      .text(`Empleado: ${ejecucion.empleado_id ? (empleadoPorId.get(ejecucion.empleado_id) || '—') : 'sin empezar'} · Estado: ${ejecucion.estado}`);
    doc.moveDown(0.3);

    for (const tarea of (tareasPorChecklist.get(ejecucion.checklist_id) || [])) {
      const r = respuestaPorTarea.get(`${ejecucion.id}||${tarea.id}`);
      let linea = `• ${tarea.titulo} — ${r?.hecho ? 'Hecho' : 'No hecho'}`;
      if (r?.valor != null) linea += ` (${r.valor}${tarea.valor_etiqueta ? ' ' + tarea.valor_etiqueta : ''}${r.fuera_rango ? ' ⚠ fuera de rango' : ''})`;
      doc.fillColor('#000').fontSize(10).text(linea);

      if (r?.foto_drive_id) {
        const buffer = await descargarFotoDrive(r.foto_drive_id);
        if (buffer) {
          try {
            if (doc.y > 620) doc.addPage();
            doc.image(buffer, doc.x + 14, doc.y + 2, { fit: [70, 70] });
            doc.moveDown(4.2);
          } catch (e) {
            console.error('[checklist-informe] no se pudo insertar la miniatura:', e.message);
          }
        }
      }
    }
  }

  doc.end();
  return fin;
}

module.exports = { generarInformeChecklistsPDF };
