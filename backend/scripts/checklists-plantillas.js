'use strict';
// Plantillas iniciales de checklists para un cliente: "Apertura cocina",
// "Cierre cocina", "Apertura sala", "Cierre sala", con tareas típicas de
// hostelería y dos de temperatura de cámaras (rango 0–5 °C) en cada
// checklist de cocina. Pensado para correr UNA VEZ al dar de alta el
// módulo para un cliente (o uno nuevo, como Bon Thai el día que se
// incorpore) — no se re-ejecuta automáticamente.
//
//   node backend/scripts/checklists-plantillas.js timbol
//   node backend/scripts/checklists-plantillas.js timbol --local=3
//
// Sin --local, usa el primer local activo del cliente (el que crea la
// migración 047 por defecto, si es el único).
const { supabase } = require('../lib/supabase');
const { PLANTILLAS } = require('../lib/checklist-plantillas');

const CLIENTES_VALIDOS = ['timbol', 'comarea'];

async function crearPlantillas(cliente, localId) {
  let local;
  if (localId) {
    const { data, error } = await supabase.from('locales').select('id, nombre').eq('id', localId).eq('cliente', cliente).maybeSingle();
    if (error) throw new Error(`locales: ${error.message}`);
    local = data;
  } else {
    const { data, error } = await supabase.from('locales').select('id, nombre').eq('cliente', cliente).eq('activo', true).order('id').limit(1).maybeSingle();
    if (error) throw new Error(`locales: ${error.message}`);
    local = data;
  }
  if (!local) throw new Error(`No hay ningún local activo para "${cliente}" (¿migración 047 aplicada?)`);

  console.log(`Creando plantillas para ${cliente} — local "${local.nombre}" (id ${local.id})`);

  for (const plantilla of PLANTILLAS) {
    const { data: existente, error: errE } = await supabase
      .from('checklists').select('id').eq('local_id', local.id).eq('nombre', plantilla.nombre).maybeSingle();
    if (errE) throw new Error(`checklists: ${errE.message}`);
    if (existente) { console.log(`  = "${plantilla.nombre}" ya existe (id ${existente.id}), no se toca`); continue; }

    const { data: checklist, error: errC } = await supabase
      .from('checklists')
      .insert({ cliente, local_id: local.id, nombre: plantilla.nombre, turno: plantilla.turno })
      .select().single();
    if (errC) throw new Error(`checklists: ${errC.message}`);

    const filas = plantilla.tareas.map((t, i) => ({
      checklist_id: checklist.id, orden: i + 1,
      titulo: t.titulo, descripcion: t.descripcion || null,
      requiere_foto: !!t.requiere_foto, hora_limite: t.hora_limite || null,
      requiere_valor: !!t.requiere_valor, valor_etiqueta: t.valor_etiqueta || null,
      valor_min: t.valor_min ?? null, valor_max: t.valor_max ?? null,
    }));
    const { error: errT } = await supabase.from('checklist_tareas').insert(filas);
    if (errT) throw new Error(`checklist_tareas: ${errT.message}`);

    console.log(`  ✓ "${plantilla.nombre}" (id ${checklist.id}) — ${filas.length} tarea(s)`);
  }
}

async function main() {
  const cliente = process.argv[2];
  if (!CLIENTES_VALIDOS.includes(cliente)) {
    console.error(`Uso: node backend/scripts/checklists-plantillas.js <${CLIENTES_VALIDOS.join('|')}> [--local=<id>]`);
    process.exit(1);
  }
  const localArg = process.argv.slice(3).find(a => a.startsWith('--local='));
  const localId = localArg ? Number(localArg.split('=')[1]) : null;
  await crearPlantillas(cliente, localId);
}

main().catch(e => { console.error(e); process.exit(1); });
