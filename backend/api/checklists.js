// Checklists de turno — configuración y tablero para el dueño (gestor/
// admin). Módulo reutilizable parametrizado por cliente, mismo patrón que
// tarifas.js/ventas.js/inventario.js/banco.js. La generación diaria, las
// tareas del empleado y el guardado de respuestas viven en
// backend/lib/checklists.js (compartido con los endpoints públicos de
// backend/api/fichaje.js); este router es solo la parte de configuración
// y consulta del dueño.
const express = require('express');
const { supabase } = require('../lib/supabase');
const { DIA_CODIGOS } = require('../lib/checklists');
const { generarInformeChecklistsPDF } = require('../lib/checklist-informe');
const { DateTime } = require('luxon');

function createChecklistsRouter({ cliente, requireAuth, requireRole }) {
  const router = express.Router();

  // ── Locales ──────────────────────────────────────────────────────────
  router.get('/locales', requireAuth, async (_req, res) => {
    const { data, error } = await supabase.from('locales').select('*').eq('cliente', cliente).order('nombre');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  router.post('/locales', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    const { nombre, dias_apertura, numero_whatsapp_avisos } = req.body || {};
    if (!nombre) return res.status(400).json({ error: 'Falta el nombre del local' });
    const dias = Array.isArray(dias_apertura) && dias_apertura.length ? dias_apertura : DIA_CODIGOS;
    try {
      const { data, error } = await supabase
        .from('locales').insert({ cliente, nombre, dias_apertura: dias, numero_whatsapp_avisos: numero_whatsapp_avisos || null })
        .select().single();
      if (error) throw new Error(error.message);
      res.status(201).json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.patch('/locales/:id', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    const { nombre, dias_apertura, numero_whatsapp_avisos, activo } = req.body || {};
    const patch = {};
    if (nombre !== undefined) patch.nombre = nombre;
    if (dias_apertura !== undefined) patch.dias_apertura = dias_apertura;
    if (numero_whatsapp_avisos !== undefined) patch.numero_whatsapp_avisos = numero_whatsapp_avisos || null;
    if (activo !== undefined) patch.activo = !!activo;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nada que actualizar' });
    try {
      const { data, error } = await supabase
        .from('locales').update(patch).eq('id', req.params.id).eq('cliente', cliente).select().maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return res.status(404).json({ error: 'Local no encontrado' });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Checklists ───────────────────────────────────────────────────────
  router.get('/checklists', requireAuth, async (_req, res) => {
    try {
      const { data: locales, error: errL } = await supabase.from('locales').select('id, nombre').eq('cliente', cliente);
      if (errL) throw new Error(errL.message);
      const nombrePorLocal = new Map(locales.map(l => [l.id, l.nombre]));

      const { data: checklists, error } = await supabase
        .from('checklists').select('*').eq('cliente', cliente).order('nombre');
      if (error) throw new Error(error.message);
      res.json(checklists.map(c => ({ ...c, local_nombre: nombrePorLocal.get(c.local_id) || null })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/checklists', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    const { local_id, nombre, turno, dias_semana } = req.body || {};
    if (!local_id || !nombre || !turno) return res.status(400).json({ error: 'Faltan local_id, nombre o turno' });
    try {
      const { data, error } = await supabase
        .from('checklists').insert({ cliente, local_id, nombre, turno, dias_semana: dias_semana || null })
        .select().single();
      if (error) throw new Error(error.message);
      res.status(201).json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.patch('/checklists/:id', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    const { nombre, turno, dias_semana, activo } = req.body || {};
    const patch = {};
    if (nombre !== undefined) patch.nombre = nombre;
    if (turno !== undefined) patch.turno = turno;
    if (dias_semana !== undefined) patch.dias_semana = dias_semana;
    if (activo !== undefined) patch.activo = !!activo;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nada que actualizar' });
    try {
      const { data, error } = await supabase
        .from('checklists').update(patch).eq('id', req.params.id).eq('cliente', cliente).select().maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return res.status(404).json({ error: 'Checklist no encontrado' });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Tareas ───────────────────────────────────────────────────────────
  router.get('/checklists/:id/tareas', requireAuth, async (req, res) => {
    const { data, error } = await supabase
      .from('checklist_tareas').select('*').eq('checklist_id', req.params.id).order('orden');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  router.post('/checklists/:id/tareas', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    const { titulo, descripcion, requiere_foto, hora_limite, requiere_valor, valor_etiqueta, valor_min, valor_max, orden } = req.body || {};
    if (!titulo) return res.status(400).json({ error: 'Falta el título de la tarea' });
    try {
      const { data, error } = await supabase
        .from('checklist_tareas')
        .insert({
          checklist_id: req.params.id, orden: orden ?? 0, titulo,
          descripcion: descripcion || null, requiere_foto: !!requiere_foto,
          hora_limite: hora_limite || null, requiere_valor: !!requiere_valor,
          valor_etiqueta: valor_etiqueta || null, valor_min: valor_min ?? null, valor_max: valor_max ?? null,
        })
        .select().single();
      if (error) throw new Error(error.message);
      res.status(201).json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.patch('/tareas/:id', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    const campos = ['titulo', 'descripcion', 'requiere_foto', 'hora_limite', 'requiere_valor', 'valor_etiqueta', 'valor_min', 'valor_max', 'orden', 'activo'];
    const patch = {};
    for (const c of campos) if (req.body?.[c] !== undefined) patch[c] = req.body[c];
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nada que actualizar' });
    try {
      const { data, error } = await supabase.from('checklist_tareas').update(patch).eq('id', req.params.id).select().maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return res.status(404).json({ error: 'Tarea no encontrada' });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Asignaciones ─────────────────────────────────────────────────────
  router.get('/checklists/:id/asignaciones', requireAuth, async (req, res) => {
    try {
      const { data: asignaciones, error } = await supabase
        .from('checklist_asignaciones').select('*').eq('checklist_id', req.params.id);
      if (error) throw new Error(error.message);
      if (!asignaciones.length) return res.json([]);

      const { data: empleados, error: errE } = await supabase
        .from('empleados').select('id, nombre').in('id', asignaciones.map(a => a.empleado_id));
      if (errE) throw new Error(errE.message);
      const nombrePorEmpleado = new Map(empleados.map(e => [e.id, e.nombre]));
      res.json(asignaciones.map(a => ({ ...a, empleado_nombre: nombrePorEmpleado.get(a.empleado_id) || null })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/checklists/:id/asignaciones', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    const { empleado_id } = req.body || {};
    if (!empleado_id) return res.status(400).json({ error: 'Falta empleado_id' });
    try {
      const { data, error } = await supabase
        .from('checklist_asignaciones')
        .upsert({ checklist_id: req.params.id, empleado_id }, { onConflict: 'checklist_id,empleado_id' })
        .select().single();
      if (error) throw new Error(error.message);
      res.status(201).json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/asignaciones/:id', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    const { error } = await supabase.from('checklist_asignaciones').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  // ── Tablero del día ──────────────────────────────────────────────────
  router.get('/checklists/tablero', requireAuth, async (req, res) => {
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '') ? req.query.fecha : new Date().toISOString().slice(0, 10);
    try {
      let q = supabase.from('checklist_ejecuciones').select('*').eq('cliente', cliente).eq('fecha', fecha);
      if (req.query.local) q = q.eq('local_id', req.query.local);
      const { data: ejecuciones, error } = await q;
      if (error) throw new Error(error.message);
      if (!ejecuciones.length) return res.json({ fecha, ejecuciones: [] });

      const checklistIds = [...new Set(ejecuciones.map(e => e.checklist_id))];
      const { data: checklists, error: errC } = await supabase.from('checklists').select('id, nombre, turno, local_id').in('id', checklistIds);
      if (errC) throw new Error(errC.message);
      const checklistPorId = new Map(checklists.map(c => [c.id, c]));

      const empleadoIds = [...new Set(ejecuciones.map(e => e.empleado_id).filter(Boolean))];
      let empleados = [];
      if (empleadoIds.length) {
        const { data, error: errE } = await supabase.from('empleados').select('id, nombre').in('id', empleadoIds);
        if (errE) throw new Error(errE.message);
        empleados = data;
      }
      const nombrePorEmpleado = new Map(empleados.map(e => [e.id, e.nombre]));

      const ejecucionIds = ejecuciones.map(e => e.id);
      const { data: respuestas, error: errR } = await supabase
        .from('checklist_respuestas').select('ejecucion_id, hecho, fuera_rango, foto_verificacion').in('ejecucion_id', ejecucionIds);
      if (errR) throw new Error(errR.message);
      const { data: avisos, error: errAv } = await supabase.from('checklist_avisos').select('ejecucion_id').in('ejecucion_id', ejecucionIds);
      if (errAv) throw new Error(errAv.message);

      const respuestasPorEjecucion = new Map();
      for (const r of respuestas) {
        if (!respuestasPorEjecucion.has(r.ejecucion_id)) respuestasPorEjecucion.set(r.ejecucion_id, []);
        respuestasPorEjecucion.get(r.ejecucion_id).push(r);
      }
      const avisosPorEjecucion = new Map();
      for (const a of avisos) avisosPorEjecucion.set(a.ejecucion_id, (avisosPorEjecucion.get(a.ejecucion_id) || 0) + 1);

      const salida = ejecuciones.map(e => {
        const c = checklistPorId.get(e.checklist_id);
        const propias = respuestasPorEjecucion.get(e.id) || [];
        return {
          id: e.id, checklist_id: e.checklist_id, checklist_nombre: c?.nombre, turno: c?.turno, local_id: e.local_id,
          estado: e.estado, empleado: e.empleado_id ? { id: e.empleado_id, nombre: nombrePorEmpleado.get(e.empleado_id) } : null,
          iniciado_at: e.iniciado_at, completado_at: e.completado_at,
          tareas_revisar: propias.filter(r => r.fuera_rango || r.foto_verificacion?.coincide === false).length,
          avisos_enviados: avisosPorEjecucion.get(e.id) || 0,
        };
      });
      res.json({ fecha, ejecuciones: salida });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Detalle de una ejecución ─────────────────────────────────────────
  router.get('/checklists/ejecuciones/:id', requireAuth, async (req, res) => {
    try {
      const { data: ejecucion, error } = await supabase
        .from('checklist_ejecuciones').select('*').eq('id', req.params.id).eq('cliente', cliente).maybeSingle();
      if (error) throw new Error(error.message);
      if (!ejecucion) return res.status(404).json({ error: 'Ejecución no encontrada' });

      const { data: tareas, error: errT } = await supabase
        .from('checklist_tareas').select('*').eq('checklist_id', ejecucion.checklist_id).order('orden');
      if (errT) throw new Error(errT.message);

      const { data: respuestas, error: errR } = await supabase
        .from('checklist_respuestas').select('*').eq('ejecucion_id', ejecucion.id);
      if (errR) throw new Error(errR.message);
      const respuestaPorTarea = new Map(respuestas.map(r => [r.tarea_id, r]));

      res.json({
        ejecucion,
        tareas: tareas.map(t => ({ ...t, respuesta: respuestaPorTarea.get(t.id) || null })),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Validar (o rechazar) a mano una foto que la IA marcó dudosa.
  router.patch('/respuestas/:id/validar', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    const { coincide, motivo } = req.body || {};
    if (typeof coincide !== 'boolean') return res.status(400).json({ error: 'Falta coincide (true|false)' });
    try {
      const { data: actual, error: errA } = await supabase
        .from('checklist_respuestas').select('foto_verificacion').eq('id', req.params.id).maybeSingle();
      if (errA) throw new Error(errA.message);
      if (!actual) return res.status(404).json({ error: 'Respuesta no encontrada' });

      const foto_verificacion = { ...(actual.foto_verificacion || {}), coincide, motivo: motivo || 'Validado a mano', confianza: 'alta', validado_manualmente: true };
      const { data, error } = await supabase
        .from('checklist_respuestas').update({ foto_verificacion }).eq('id', req.params.id).select().single();
      if (error) throw new Error(error.message);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Calendario mensual ───────────────────────────────────────────────
  router.get('/checklists/calendario', requireAuth, async (req, res) => {
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : new Date().toISOString().slice(0, 7);
    try {
      // Último día REAL del mes (28/29/30/31) — un mes de 30 días con
      // ".lte('fecha', `${mes}-31`)" no traía nada bien, pero en febrero
      // Postgres directamente rechaza "2026-02-31" como fecha inválida.
      const ultimoDia = DateTime.fromFormat(mes, 'yyyy-MM', { zone: 'utc' }).endOf('month').toISODate();
      let q = supabase.from('checklist_ejecuciones').select('fecha, estado').eq('cliente', cliente)
        .gte('fecha', `${mes}-01`).lte('fecha', ultimoDia);
      if (req.query.local) q = q.eq('local_id', req.query.local);
      const { data, error } = await q;
      if (error) throw new Error(error.message);

      const porDia = new Map();
      for (const e of data) {
        if (!porDia.has(e.fecha)) porDia.set(e.fecha, { total: 0, completado: 0, incompleto: 0 });
        const d = porDia.get(e.fecha);
        d.total++;
        if (e.estado === 'completado') d.completado++;
        if (e.estado === 'incompleto') d.incompleto++;
      }
      res.json({ mes, dias: [...porDia.entries()].map(([fecha, v]) => ({ fecha, ...v })).sort((a, b) => a.fecha.localeCompare(b.fecha)) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Informe PDF (Sanidad) ────────────────────────────────────────────
  router.get('/checklists/informe', requireAuth, async (req, res) => {
    const { desde, hasta, local } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde || '') || !/^\d{4}-\d{2}-\d{2}$/.test(hasta || '')) {
      return res.status(400).json({ error: 'Se requiere desde y hasta (YYYY-MM-DD)' });
    }
    try {
      const pdf = await generarInformeChecklistsPDF({ cliente, desde, hasta, localId: local });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="checklists-${cliente}-${desde}-a-${hasta}.pdf"`);
      res.send(pdf);
    } catch (e) {
      console.error(`[checklists:${cliente}] informe error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createChecklistsRouter };
