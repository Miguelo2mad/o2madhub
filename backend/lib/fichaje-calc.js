// Reglas de negocio del fichaje de personal, en un solo sitio y sin efectos
// secundarios (nada de Supabase aquí — eso vive en backend/api/fichaje.js).
// Las cuatro reglas siguientes afectan directamente al importe a pagar, así
// que van explícitas:
//
// 1. ATRIBUCIÓN DE UN TURNO — un fichaje pertenece ENTERO al día y a la
//    semana de su entrada_at, aunque la salida caiga en el día/semana
//    siguiente. Un turno de sábado 20:00 a domingo 01:30 cuenta entero como
//    sábado. Nunca se parte un turno entre dos días ni entre dos semanas.
//
// 2. SEMANA A CABALLO ENTRE DOS MESES — las extras de una semana se imputan
//    al mes que contiene su LUNES. La semana del 28/09 al 04/10 va entera a
//    septiembre. Por eso semanasDelMes() puede devolver una última semana
//    cuyo domingo cae en el mes siguiente: el informe debe mostrar ese rango
//    real (rango_inicio/rango_fin), no las fechas 1–30/31 del mes.
//
// 3. TURNOS ABIERTOS Y OLVIDADOS — un turno abierto que supera
//    UMBRAL_INCIDENCIA_HORAS deja de sumar en el instante en que cruza el
//    umbral y se trata como incidencia: no se le inventa una hora de
//    salida, simplemente no cuenta hasta que un gestor/admin lo corrija.
//
// 4. PRECIO DE LA HORA EXTRA — precio_hora_extra es el precio VIGENTE en
//    empleados. Un informe generado congela el precio usado en ese momento
//    (ver informes_fichaje.detalle); si el precio cambia después, los
//    informes ya generados no se recalculan.

const { DateTime } = require('luxon');

const ZONA = 'Europe/Madrid';
const UMBRAL_INCIDENCIA_HORAS = 12;

function aMadrid(fecha) {
  return (fecha instanceof DateTime ? fecha : DateTime.fromJSDate(new Date(fecha))).setZone(ZONA);
}

// Lunes 00:00:00 (Madrid) de la semana ISO que contiene `fecha`. Se calcula
// a mano con DateTime#weekday (siempre ISO 1–7 pase lo que pase con el
// locale) en vez de confiar en startOf('week'), que depende del locale.
function lunesDeSemana(fecha) {
  const dt = aMadrid(fecha);
  return dt.minus({ days: dt.weekday - 1 }).startOf('day');
}

function rangoSemana(fecha) {
  const inicio = lunesDeSemana(fecha);
  return { inicio, fin: inicio.plus({ days: 6 }).endOf('day') };
}

// Todas las semanas (lunes–domingo) cuyo LUNES cae dentro de `year`/`month`
// (month: 1–12). Regla 2: esto es lo que define a qué mes pertenece cada
// semana, no si la semana "toca" el mes.
function semanasDelMes(year, month) {
  const semanas = [];
  let cursor = DateTime.fromObject({ year, month, day: 1 }, { zone: ZONA });
  while (cursor.weekday !== 1) cursor = cursor.plus({ days: 1 }); // primer lunes del mes (avanza como mucho 6 días, sigue en el mismo mes)
  while (cursor.month === month && cursor.year === year) {
    semanas.push(rangoSemana(cursor));
    cursor = cursor.plus({ days: 7 });
  }
  return semanas;
}

function claveDia(fecha) {
  return aMadrid(fecha).toISODate();
}

function claveSemana(fecha) {
  return lunesDeSemana(fecha).toISODate();
}

// Regla 3: ¿un turno todavía abierto ya cruzó el umbral? Solo tiene sentido
// para filas con salida_at null; el llamador decide si persiste el flag.
function esIncidenciaAbierta(entradaAt, ahora = new Date()) {
  const horas = DateTime.fromJSDate(new Date(ahora)).diff(aMadrid(entradaAt), 'hours').hours;
  return horas > UMBRAL_INCIDENCIA_HORAS;
}

// Horas de UN fichaje, aplicando la regla 3: si ya está marcado incidencia
// en BD, o si sigue abierto y acaba de cruzar el umbral, no suma (0h) y se
// informa incidencia=true para que el llamador lo destaque/persista.
function horasDeFichaje(fichaje, ahora = new Date()) {
  if (fichaje.incidencia) return { horas: 0, incidencia: true };
  if (fichaje.salida_at) {
    const horas = aMadrid(fichaje.salida_at).diff(aMadrid(fichaje.entrada_at), 'hours').hours;
    return { horas: Math.max(0, horas), incidencia: false };
  }
  if (esIncidenciaAbierta(fichaje.entrada_at, ahora)) return { horas: 0, incidencia: true };
  const horas = DateTime.fromJSDate(new Date(ahora)).diff(aMadrid(fichaje.entrada_at), 'hours').hours;
  return { horas: Math.max(0, horas), incidencia: false };
}

function totalHoras(fichajes, ahora = new Date()) {
  return fichajes.reduce((s, f) => s + horasDeFichaje(f, ahora).horas, 0);
}

// Agrupa fichajes por el día/semana de su ENTRADA (regla 1: nunca se
// reparte un turno entre dos cubos).
function agruparPorDia(fichajes) {
  const mapa = new Map();
  for (const f of fichajes) {
    const k = claveDia(f.entrada_at);
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push(f);
  }
  return mapa;
}

function agruparPorSemana(fichajes) {
  const mapa = new Map();
  for (const f of fichajes) {
    const k = claveSemana(f.entrada_at);
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push(f);
  }
  return mapa;
}

function fichajesDeSemana(fichajes, semana) {
  return fichajes.filter(f => claveSemana(f.entrada_at) === semana.inicio.toISODate());
}

function calcularExtrasSemana(fichajesSemana, horasContrato, ahora = new Date()) {
  const horasTrabajadas = totalHoras(fichajesSemana, ahora);
  return { horasTrabajadas, extras: Math.max(0, horasTrabajadas - horasContrato) };
}

// Regla 2: suma las extras semana a semana (nunca por mes plano — una
// semana floja no puede tapar una cargada) y devuelve también el rango real
// de fechas cubierto, para que el informe lo muestre en cabecera.
function calcularExtrasMes(fichajes, horasContrato, year, month, ahora = new Date()) {
  const semanas = semanasDelMes(year, month);
  const porSemana = semanas.map(semana => {
    const { horasTrabajadas, extras } = calcularExtrasSemana(fichajesDeSemana(fichajes, semana), horasContrato, ahora);
    return { inicio: semana.inicio, fin: semana.fin, horasTrabajadas, extras };
  });
  const totalExtras = porSemana.reduce((s, w) => s + w.extras, 0);
  return {
    totalExtras,
    porSemana,
    rangoInicio: semanas[0].inicio,
    rangoFin: semanas[semanas.length - 1].fin,
  };
}

module.exports = {
  ZONA,
  UMBRAL_INCIDENCIA_HORAS,
  lunesDeSemana,
  rangoSemana,
  semanasDelMes,
  claveDia,
  claveSemana,
  esIncidenciaAbierta,
  horasDeFichaje,
  totalHoras,
  agruparPorDia,
  agruparPorSemana,
  fichajesDeSemana,
  calcularExtrasSemana,
  calcularExtrasMes,
};
