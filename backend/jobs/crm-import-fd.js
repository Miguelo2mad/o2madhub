'use strict';
const { supabase } = require('../lib/supabase');

async function importarContactosFD() {
  console.log(`[crm-import] iniciando @ ${new Date().toISOString()}`);

  // Solo los 74 contactos que tienen facturas (tienen fila en customer_metrics)
  const { data: metrics, error: metricsErr } = await supabase
    .from('customer_metrics')
    .select('fd_contact_id');
  if (metricsErr) throw new Error(`customer_metrics: ${metricsErr.message}`);

  const contactIds = metrics.map(m => m.fd_contact_id);
  if (!contactIds.length) {
    console.log('[crm-import] sin contactos con métricas');
    return { importados: 0, actualizados: 0, total: 0 };
  }

  const { data: contacts, error: contactsErr } = await supabase
    .from('fd_contacts')
    .select('fd_contact_id, name, fiscal_id, email, phone')
    .in('fd_contact_id', contactIds);
  if (contactsErr) throw new Error(`fd_contacts: ${contactsErr.message}`);

  let importados = 0;
  let actualizados = 0;

  for (const c of contacts) {
    const nombre = c.name || c.fd_contact_id;
    const cif = c.fiscal_id || null;
    const email = c.email || null;
    const telefono = c.phone || null;
    const fd_contact_id = c.fd_contact_id;

    // Buscar empresa existente sin fd_contact_id con mismo cif o email
    let empresaExistente = null;
    if (cif) {
      const { data } = await supabase
        .from('crm_empresas')
        .select('id, fd_contact_id')
        .is('fd_contact_id', null)
        .ilike('cif', cif)
        .maybeSingle();
      empresaExistente = data;
    }
    if (!empresaExistente && email) {
      const { data } = await supabase
        .from('crm_empresas')
        .select('id, fd_contact_id')
        .is('fd_contact_id', null)
        .ilike('email', email)
        .maybeSingle();
      empresaExistente = data;
    }

    if (empresaExistente) {
      const { error } = await supabase
        .from('crm_empresas')
        .update({ fd_contact_id, nombre, cif, email, telefono, updated_at: new Date().toISOString() })
        .eq('id', empresaExistente.id);
      if (error) console.error(`[crm-import] update ${fd_contact_id}: ${error.message}`);
      else actualizados++;
    } else {
      const { error } = await supabase
        .from('crm_empresas')
        .upsert(
          { nombre, cif, email, telefono, fd_contact_id, origen: 'facturadirecta', updated_at: new Date().toISOString() },
          { onConflict: 'fd_contact_id' }
        );
      if (error) console.error(`[crm-import] upsert ${fd_contact_id}: ${error.message}`);
      else importados++;
    }
  }

  console.log(`[crm-import] completado: ${importados} importados, ${actualizados} actualizados`);
  return { importados, actualizados, total: contacts.length };
}

module.exports = { importarContactosFD };
