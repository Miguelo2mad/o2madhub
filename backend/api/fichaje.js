// Fichaje de personal — módulo reutilizable parametrizado por cliente.
// No se monta solo: cada módulo cliente (timbol.js, comarea.js, futuros
// restaurantes) llama a createFichajeRouter({ cliente, requireAuth,
// requireRole }) con SU PROPIO login/roles y lo monta en '/fichaje'. Una
// sola tabla empleados/fichajes para todos; el aislamiento entre clientes
// lo da el `.eq('cliente', cliente)` que esta fábrica mete en cada query —
// Timbol nunca puede leer ni tocar empleados de Comarea, y viceversa.
//
// Las reglas de negocio (atribución de turnos, semana a caballo entre
// meses, incidencias >12h, precio congelado en el informe) viven en
// backend/lib/fichaje-calc.js, documentadas ahí. Este archivo es el pegamento
// HTTP + Supabase.
const express = require('express');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const { DateTime } = require('luxon');
const { supabase } = require('../lib/supabase');
const calc = require('../lib/fichaje-calc');

const PIN_REGEX = /^\d{5}$/;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Rate limit de intentos de PIN: máx. 5 por token cada 10 min. En memoria
// del proceso — asume una sola instancia del servicio en Railway. Si algún
// día corre más de una réplica, esto se queda corto y hay que moverlo a
// Supabase (una tabla) o Redis para compartir el contador entre instancias.
const intentosPin = new Map(); // token -> { count, desde }
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_MS  = 10 * 60 * 1000;

function pinRateLimited(token) {
  const ahora = Date.now();
  const e = intentosPin.get(token);
  if (!e || ahora - e.desde > RATE_LIMIT_MS) {
    intentosPin.set(token, { count: 1, desde: ahora });
    return false;
  }
  e.count += 1;
  return e.count > RATE_LIMIT_MAX;
}
function pinRateLimitReset(token) {
  intentosPin.delete(token);
}

function formatoHora(fechaIso) {
  return DateTime.fromJSDate(new Date(fechaIso)).setZone(calc.ZONA).toFormat('HH:mm');
}

function parseMes(mesStr) {
  const m = /^(\d{4})-(\d{2})$/.exec(mesStr || '');
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

function csvNum(n) { return String(n).replace('.', ','); }
function csvField(s) {
  const str = String(s ?? '');
  return /[;"\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
function informeACsv(informe, cliente) {
  const header = ['Empleado', 'Puesto', 'Horas contrato', 'Extras (h)', 'Precio hora extra', 'Importe extras'];
  const filas = informe.empleados.map(e => [
    e.nombre, e.puesto || '', csvNum(e.horas_contrato), csvNum(e.extras_horas), csvNum(e.precio_hora_extra), csvNum(e.importe_extras),
  ]);
  const total = ['TOTAL', '', '', csvNum(informe.total_extras_horas), '', csvNum(informe.total_importe)];
  return [
    `Cliente: ${cliente}`,
    `Periodo: ${informe.rango_inicio} a ${informe.rango_fin}`,
    `Generado: ${informe.generado_at}`,
    '',
    header.join(';'),
    ...filas.map(r => r.map(csvField).join(';')),
    total.map(csvField).join(';'),
  ].join('\r\n');
}

function createFichajeRouter({ cliente, requireAuth, requireRole }) {
  const router = express.Router();

  function fichajeUrl(token) {
    const base = process.env.RAILWAY_URL || `http://localhost:${process.env.PORT || 8080}`;
    return `${base}/${cliente}/fichaje/${token}`;
  }

  async function empleadoPorToken(token) {
    const { data, error } = await supabase
      .from('empleados').select('*')
      .eq('cliente', cliente).eq('url_token', token).eq('activo', true)
      .maybeSingle();
    if (error) throw new Error(`Supabase: ${error.message}`);
    return data;
  }

  // Turnos abiertos que ya cruzaron el umbral de incidencia pero aún no
  // están marcados en BD (nadie los ha releído desde que cruzaron). Se
  // marcan aquí, de paso en cada lectura — no hace falta un cron aparte.
  async function marcarIncidenciasVencidas(empleadoIds) {
    if (!empleadoIds.length) return;
    const { data: abiertos } = await supabase
      .from('fichajes').select('id, entrada_at')
      .in('empleado_id', empleadoIds).is('salida_at', null).eq('incidencia', false);
    if (!abiertos?.length) return;
    const ahora = new Date();
    const vencidos = abiertos.filter(f => calc.esIncidenciaAbierta(f.entrada_at, ahora)).map(f => f.id);
    if (vencidos.length) await supabase.from('fichajes').update({ incidencia: true }).in('id', vencidos);
  }

  async function fichajesDelEmpleadoDesde(empleadoId, desde) {
    const { data, error } = await supabase
      .from('fichajes').select('*').eq('empleado_id', empleadoId)
      .gte('entrada_at', desde.toUTC().toISO()).order('entrada_at', { ascending: true });
    if (error) throw new Error(`Supabase: ${error.message}`);
    return data;
  }

  // ── Admin: alta y edición de empleados ──────────────────────────────────

  router.get('/empleados', requireAuth, requireRole('gestor', 'admin'), async (_req, res) => {
    try {
      const { data, error } = await supabase
        .from('empleados')
        .select('id, nombre, puesto, horas_semana, precio_hora_extra, url_token, activo, created_at')
        .eq('cliente', cliente).order('nombre', { ascending: true });
      if (error) throw error;
      res.json(data.map(e => ({ ...e, fichaje_url: fichajeUrl(e.url_token) })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/empleados', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    try {
      const { nombre, puesto, horas_semana, precio_hora_extra, pin } = req.body || {};
      if (!nombre?.trim()) return res.status(400).json({ error: 'nombre es obligatorio' });
      if (!(Number(horas_semana) > 0)) return res.status(400).json({ error: 'horas_semana debe ser un número positivo' });
      if (!(Number(precio_hora_extra) >= 0)) return res.status(400).json({ error: 'precio_hora_extra debe ser un número' });
      if (!PIN_REGEX.test(pin || '')) return res.status(400).json({ error: 'pin debe ser de 5 cifras' });

      const url_token = crypto.randomBytes(24).toString('base64url');
      const pin_hash = await bcrypt.hash(pin, 10);

      const { data, error } = await supabase
        .from('empleados')
        .insert({
          cliente, nombre: nombre.trim(), puesto: puesto?.trim() || null,
          horas_semana: Number(horas_semana), precio_hora_extra: Number(precio_hora_extra),
          pin_hash, url_token, activo: true,
        })
        .select('id, nombre, puesto, horas_semana, precio_hora_extra, url_token, activo, created_at')
        .single();
      if (error) throw error;
      res.status(201).json({ ...data, fichaje_url: fichajeUrl(data.url_token) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.patch('/empleados/:id', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    try {
      const { id } = req.params;
      const { nombre, puesto, horas_semana, precio_hora_extra, activo, pin, regenerar_token } = req.body || {};
      const updates = { updated_at: new Date().toISOString() };
      if (nombre !== undefined) updates.nombre = String(nombre).trim();
      if (puesto !== undefined) updates.puesto = puesto ? String(puesto).trim() : null;
      if (horas_semana !== undefined) updates.horas_semana = Number(horas_semana);
      if (precio_hora_extra !== undefined) updates.precio_hora_extra = Number(precio_hora_extra);
      if (activo !== undefined) updates.activo = Boolean(activo);
      if (pin !== undefined) {
        if (!PIN_REGEX.test(pin)) return res.status(400).json({ error: 'pin debe ser de 5 cifras' });
        updates.pin_hash = await bcrypt.hash(pin, 10);
      }
      if (regenerar_token) updates.url_token = crypto.randomBytes(24).toString('base64url');

      const { data, error } = await supabase
        .from('empleados').update(updates).eq('id', id).eq('cliente', cliente)
        .select('id, nombre, puesto, horas_semana, precio_hora_extra, url_token, activo, created_at')
        .single();
      if (error) throw error;
      res.json({ ...data, fichaje_url: fichajeUrl(data.url_token) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Admin: tabla en vivo y corrección de fichajes ───────────────────────

  router.get('/estado', requireAuth, requireRole('gestor', 'admin'), async (_req, res) => {
    try {
      const { data: empleados, error } = await supabase
        .from('empleados')
        .select('id, nombre, puesto, horas_semana, precio_hora_extra')
        .eq('cliente', cliente).eq('activo', true).order('nombre', { ascending: true });
      if (error) throw error;
      if (!empleados.length) return res.json({ empleados: [], personas_dentro: 0, total_extras_mes_horas: 0, total_importe_mes: 0 });

      const ids = empleados.map(e => e.id);
      await marcarIncidenciasVencidas(ids);

      const ahora = new Date();
      const madridNow = DateTime.fromJSDate(ahora).setZone(calc.ZONA);
      const { year, month } = madridNow;
      const semanas = calc.semanasDelMes(year, month);
      const fichajes = await fichajesDelEmpleadoEnLista(ids, semanas[0].inicio);

      const porEmpleado = new Map(ids.map(id => [id, []]));
      for (const f of fichajes) porEmpleado.get(f.empleado_id)?.push(f);

      const hoyKey = calc.claveDia(ahora);
      const semanaActual = calc.rangoSemana(ahora);

      let personasDentro = 0, totalExtrasHoras = 0, totalImporte = 0;
      const filas = empleados.map(emp => {
        const propios = porEmpleado.get(emp.id) || [];
        const abierto = propios.find(f => !f.salida_at);
        const dentro = !!abierto && !abierto.incidencia && !calc.esIncidenciaAbierta(abierto.entrada_at, ahora);
        if (dentro) personasDentro += 1;

        const horasHoy = calc.totalHoras(propios.filter(f => calc.claveDia(f.entrada_at) === hoyKey), ahora);
        const horasSemana = calc.totalHoras(calc.fichajesDeSemana(propios, semanaActual), ahora);
        const { totalExtras } = calc.calcularExtrasMes(propios, emp.horas_semana, year, month, ahora);
        const importe = totalExtras * Number(emp.precio_hora_extra);
        // Detalle (no solo el contador) para que el admin pueda corregirlas
        // sin tener que ir a buscar el id del fichaje por otro lado.
        const incidenciasDetalle = propios
          .filter(f => f.incidencia)
          .map(f => ({ id: f.id, entrada_at: f.entrada_at, salida_at: f.salida_at }));

        totalExtrasHoras += totalExtras;
        totalImporte += importe;

        return {
          id: emp.id, nombre: emp.nombre, puesto: emp.puesto,
          dentro, desde: dentro ? abierto.entrada_at : null,
          horas_hoy: round2(horasHoy), horas_semana: round2(horasSemana),
          horas_contrato: Number(emp.horas_semana), extras_mes: round2(totalExtras),
          importe_mes: round2(importe), incidencias: incidenciasDetalle,
        };
      });

      res.json({
        empleados: filas, personas_dentro: personasDentro,
        total_extras_mes_horas: round2(totalExtrasHoras), total_importe_mes: round2(totalImporte),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  async function fichajesDelEmpleadoEnLista(ids, desde) {
    const { data, error } = await supabase
      .from('fichajes').select('*').in('empleado_id', ids)
      .gte('entrada_at', desde.toUTC().toISO()).order('entrada_at', { ascending: true });
    if (error) throw error;
    return data;
  }

  async function generarInformeMensual(mesStr) {
    const parsed = parseMes(mesStr);
    if (!parsed) throw Object.assign(new Error('mes debe tener formato YYYY-MM'), { status: 400 });
    const { year, month } = parsed;

    const { data: empleados, error } = await supabase
      .from('empleados').select('id, nombre, puesto, horas_semana, precio_hora_extra')
      .eq('cliente', cliente).eq('activo', true).order('nombre', { ascending: true });
    if (error) throw error;

    const semanas = calc.semanasDelMes(year, month);
    const rangoInicio = semanas[0].inicio, rangoFin = semanas[semanas.length - 1].fin;
    const ahora = new Date();

    let empleadosDetalle = [], totalExtras = 0, totalImporte = 0;
    if (empleados.length) {
      const ids = empleados.map(e => e.id);
      await marcarIncidenciasVencidas(ids);
      const { data: fichajes, error: fErr } = await supabase
        .from('fichajes').select('*').in('empleado_id', ids)
        .gte('entrada_at', rangoInicio.toUTC().toISO()).lte('entrada_at', rangoFin.toUTC().toISO())
        .order('entrada_at', { ascending: true });
      if (fErr) throw fErr;

      const porEmpleado = new Map(ids.map(id => [id, []]));
      for (const f of fichajes) porEmpleado.get(f.empleado_id)?.push(f);

      empleadosDetalle = empleados.map(emp => {
        const propios = porEmpleado.get(emp.id) || [];
        const { totalExtras: extras } = calc.calcularExtrasMes(propios, emp.horas_semana, year, month, ahora);
        // Precio VIGENTE en el momento de generar — esto es lo que queda
        // congelado en informes_fichaje.detalle (regla 4).
        const precio = Number(emp.precio_hora_extra);
        const importe = extras * precio;
        totalExtras += extras;
        totalImporte += importe;
        return {
          empleado_id: emp.id, nombre: emp.nombre, puesto: emp.puesto,
          horas_contrato: Number(emp.horas_semana), extras_horas: round2(extras),
          precio_hora_extra: precio, importe_extras: round2(importe),
          incidencias_excluidas: propios.filter(f => f.incidencia).length,
        };
      });
    }

    const detalle = {
      rango_inicio: rangoInicio.toISODate(), rango_fin: rangoFin.toISODate(),
      empleados: empleadosDetalle, total_extras_horas: round2(totalExtras), total_importe: round2(totalImporte),
    };

    const { data: guardado, error: insErr } = await supabase
      .from('informes_fichaje').insert({ cliente, mes: mesStr, detalle }).select().single();
    if (insErr) throw insErr;

    return { id: guardado.id, cliente, mes: mesStr, generado_at: guardado.generado_at, ...detalle };
  }

  router.get('/informe', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    try {
      res.json(await generarInformeMensual(req.query.mes));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  router.get('/informe.csv', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    try {
      const informe = await generarInformeMensual(req.query.mes);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="fichaje-${cliente}-${informe.mes}.csv"`);
      res.send('﻿' + informeACsv(informe, cliente)); // BOM: Excel-ES detecta UTF-8
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Corrige entrada_at/salida_at de UN fichaje. El fichaje original nunca se
  // borra; cada campo tocado queda auditado en fichajes_correcciones.
  router.patch('/:id', requireAuth, requireRole('gestor', 'admin'), async (req, res) => {
    try {
      const { id } = req.params;
      const { entrada_at, salida_at, motivo } = req.body || {};
      if (!motivo?.trim()) return res.status(400).json({ error: 'motivo es obligatorio' });
      if (entrada_at === undefined && salida_at === undefined) return res.status(400).json({ error: 'nada que corregir' });

      // Confirma que el fichaje pertenece a un empleado de ESTE cliente
      // antes de tocar nada — evita que Timbol corrija fichajes de Comarea.
      const { data: actual, error: findErr } = await supabase
        .from('fichajes').select('*, empleado:empleado_id(cliente)').eq('id', id).maybeSingle();
      if (findErr) throw findErr;
      if (!actual || actual.empleado?.cliente !== cliente) return res.status(404).json({ error: 'Fichaje no encontrado' });

      const correcciones = [];
      const updates = {};
      if (entrada_at !== undefined && entrada_at !== actual.entrada_at) {
        correcciones.push({ fichaje_id: id, campo: 'entrada_at', valor_anterior: actual.entrada_at, valor_nuevo: entrada_at, autor: req.user.email, motivo: motivo.trim() });
        updates.entrada_at = entrada_at;
      }
      if (salida_at !== undefined && salida_at !== actual.salida_at) {
        correcciones.push({ fichaje_id: id, campo: 'salida_at', valor_anterior: actual.salida_at, valor_nuevo: salida_at, autor: req.user.email, motivo: motivo.trim() });
        updates.salida_at = salida_at;
      }
      if (!correcciones.length) return res.json(actual);

      // Recalcula incidencia con los valores YA corregidos: si la
      // corrección resuelve la ambigüedad (queda una salida, o una entrada
      // que abierta ya no supera el umbral), deja de ser incidencia sin que
      // el admin tenga que tocar ese campo aparte.
      const entradaFinal = updates.entrada_at ?? actual.entrada_at;
      const salidaFinal = 'salida_at' in updates ? updates.salida_at : actual.salida_at;
      updates.incidencia = !salidaFinal && calc.esIncidenciaAbierta(entradaFinal, new Date());

      const { data: actualizado, error: updErr } = await supabase
        .from('fichajes').update(updates).eq('id', id).select().single();
      if (updErr) {
        // Reabrir esta fila (salida_at -> null) mientras el empleado ya
        // tiene otro turno abierto choca con el índice único parcial.
        if (updErr.code === '23505') return res.status(409).json({ error: 'Ese empleado ya tiene otro turno abierto; ciérralo antes de reabrir este' });
        throw updErr;
      }

      const { error: corrErr } = await supabase.from('fichajes_correcciones').insert(correcciones);
      if (corrErr) console.error('[fichaje] guardar corrección:', corrErr.message);

      res.json(actualizado);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Empleado: identificado por url_token, sin sesión ────────────────────

  router.get('/:token/estado', async (req, res) => {
    try {
      const emp = await empleadoPorToken(req.params.token);
      if (!emp) return res.status(404).json({ error: 'No encontrado' });
      await marcarIncidenciasVencidas([emp.id]);

      const ahora = new Date();
      const hoyKey = calc.claveDia(ahora);
      const fichajes = await fichajesDelEmpleadoDesde(emp.id, calc.lunesDeSemana(ahora));

      const abierto = fichajes.find(f => !f.salida_at);
      const tramosHoy = fichajes.filter(f => calc.claveDia(f.entrada_at) === hoyKey).map(f => {
        const { horas, incidencia } = calc.horasDeFichaje(f, ahora);
        return { entrada: f.entrada_at, salida: f.salida_at, horas: round2(horas), incidencia };
      });
      const horasSemana = calc.totalHoras(calc.fichajesDeSemana(fichajes, calc.rangoSemana(ahora)), ahora);

      res.json({
        nombre: emp.nombre, puesto: emp.puesto, horas_semana: Number(emp.horas_semana),
        turno_abierto: abierto
          ? { desde: abierto.entrada_at, incidencia: !!abierto.incidencia || calc.esIncidenciaAbierta(abierto.entrada_at, ahora) }
          : null,
        tramos_hoy: tramosHoy, total_semana_horas: round2(horasSemana),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/:token/entrada', async (req, res) => {
    const { token } = req.params;
    try {
      const emp = await empleadoPorToken(token);
      if (!emp) return res.status(404).json({ error: 'No encontrado' });
      if (pinRateLimited(token)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });

      const { pin } = req.body || {};
      if (!PIN_REGEX.test(pin || '') || !(await bcrypt.compare(pin, emp.pin_hash))) {
        return res.status(401).json({ error: 'PIN incorrecto' });
      }
      pinRateLimitReset(token);

      const ahora = new Date();
      const { data: abierto, error: findErr } = await supabase
        .from('fichajes').select('*').eq('empleado_id', emp.id).is('salida_at', null).maybeSingle();
      if (findErr) throw findErr;

      if (abierto) {
        if (!calc.esIncidenciaAbierta(abierto.entrada_at, ahora)) {
          return res.status(409).json({ error: `Ya tienes un turno abierto desde las ${formatoHora(abierto.entrada_at)}` });
        }
        // Regla 3: turno olvidado (>12h) — se cierra sin inventar una hora
        // de salida (sentinel = la propia entrada, duración 0, excluido de
        // extras) y queda marcado para que gestor/admin lo corrija.
        await supabase.from('fichajes').update({ salida_at: abierto.entrada_at, incidencia: true }).eq('id', abierto.id);
      }

      const { data: nuevo, error: insErr } = await supabase
        .from('fichajes').insert({ empleado_id: emp.id, entrada_at: ahora.toISOString(), salida_at: null, incidencia: false })
        .select().single();
      if (insErr) {
        if (insErr.code === '23505') return res.status(409).json({ error: 'Ya tienes un turno abierto' });
        throw insErr;
      }

      res.json({ ok: true, turno_abierto: { desde: nuevo.entrada_at } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/:token/salida', async (req, res) => {
    const { token } = req.params;
    try {
      const emp = await empleadoPorToken(token);
      if (!emp) return res.status(404).json({ error: 'No encontrado' });
      if (pinRateLimited(token)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });

      const { pin } = req.body || {};
      if (!PIN_REGEX.test(pin || '') || !(await bcrypt.compare(pin, emp.pin_hash))) {
        return res.status(401).json({ error: 'PIN incorrecto' });
      }
      pinRateLimitReset(token);

      const { data: abierto, error: findErr } = await supabase
        .from('fichajes').select('*').eq('empleado_id', emp.id).is('salida_at', null).maybeSingle();
      if (findErr) throw findErr;
      if (!abierto) return res.status(409).json({ error: 'No tienes ningún turno abierto' });

      const ahora = new Date();
      if (calc.esIncidenciaAbierta(abierto.entrada_at, ahora)) {
        // Ya superó el umbral antes de que le diera tiempo a fichar salida:
        // mismo tratamiento que en /entrada, no se inventa hora de salida.
        await supabase.from('fichajes').update({ salida_at: abierto.entrada_at, incidencia: true }).eq('id', abierto.id);
        return res.status(409).json({ error: 'Tu turno superó las 12 horas sin registrar salida y ha quedado marcado para revisión. Avisa a tu gestor.' });
      }

      const { data: cerrado, error: updErr } = await supabase
        .from('fichajes').update({ salida_at: ahora.toISOString() }).eq('id', abierto.id).select().single();
      if (updErr) throw updErr;

      res.json({ ok: true, tramo: { entrada: cerrado.entrada_at, salida: cerrado.salida_at, horas: round2(calc.horasDeFichaje(cerrado, ahora).horas) } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createFichajeRouter };
