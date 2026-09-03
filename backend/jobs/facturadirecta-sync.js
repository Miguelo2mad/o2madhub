'use strict';
const { FacturaDirectaClient } = require('../lib/facturadirecta-client');
const { supabase } = require('../lib/supabase');

async function logSync(entity, status, records, errorMessage, startedAt) {
  try {
    await supabase.from('fd_sync_logs').insert({
      entity,
      status,
      records_synced: records,
      error_message: errorMessage || null,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[fd-sync] logSync failed:', e.message);
  }
}

async function syncContacts(client) {
  const start = new Date().toISOString();
  try {
    const contacts = await client.getAll('/contacts');
    console.log(`[fd-sync] contacts: ${contacts.length} registros de la API`);
    if (!contacts.length) {
      await logSync('contacts', 'ok', 0, null, start);
      return [];
    }
    if (contacts.length > 0) {
      console.log('[fd-sync] contacts sample keys:', Object.keys(contacts[0]).join(', '));
    }
    // FacturaDirecta structure: { content: { main: { name, fiscalId, email, phone }, uuid }, ... }
    const rows = contacts.map(c => {
      const main = c.content?.main || {};
      const uuid = c.content?.uuid || String(c.id || '');
      // email field may contain "Display Name <email@>" — extract just the address
      const rawEmail = main.email || '';
      const emailMatch = rawEmail.match(/<([^>]+)>/) || rawEmail.match(/^[^\s@]+@[^\s@]+\.[^\s@]+/);
      const cleanEmail = emailMatch ? (emailMatch[1] || emailMatch[0]) : (rawEmail.includes('@') ? rawEmail : null);
      return {
        fd_contact_id:  uuid,
        name:           main.name || main.title || main.razon_social || uuid,
        fiscal_id:      main.fiscalId || main.fiscal_id || main.nif || null,
        email:          cleanEmail,
        phone:          main.phone || main.telefono || null,
        is_client:      true,
        raw:            c,
        last_synced_at: new Date().toISOString(),
        updated_at:     new Date().toISOString(),
      };
    });
    const { error } = await supabase
      .from('fd_contacts')
      .upsert(rows, { onConflict: 'fd_contact_id' });
    if (error) throw new Error(error.message);
    await logSync('contacts', 'ok', rows.length, null, start);
    console.log(`[fd-sync] contacts: ${rows.length} upserted`);
    return contacts;
  } catch (e) {
    await logSync('contacts', 'error', 0, e.message, start);
    console.error('[fd-sync] contacts error:', e.message);
    throw e;
  }
}

async function syncInvoices(client) {
  const start = new Date().toISOString();
  let totalLines = 0;
  try {
    const invoices = await client.getAll('/invoices');
    console.log(`[fd-sync] invoices: ${invoices.length} registros de la API`);
    if (!invoices.length) {
      await logSync('invoices', 'ok', 0, null, start);
      return;
    }
    if (invoices.length > 0) {
      console.log('[fd-sync] invoices sample keys:', Object.keys(invoices[0]).join(', '));
    }
    // FacturaDirecta structure: { content: { main: { date, total, lines, contact, ... }, uuid }, ... }
    const rows = invoices.map(inv => {
      const main = inv.content?.main || {};
      const uuid = inv.content?.uuid || String(inv.id || '');
      const dn   = main.docNumber || {};
      const docNum = dn.series ? `${dn.series}-${dn.number}` : (dn.number ? String(dn.number) : null);
      // Sum all taxes for the tax column
      const taxTotal = Array.isArray(main.taxes)
        ? main.taxes.reduce((s, t) => s + (Number(t.amount) || 0), 0)
        : null;
      // state: voided > draft > 'issued'
      const state = main.voided ? 'voided' : (main.draft ? 'draft' : 'issued');
      return {
        fd_invoice_id:   uuid,
        fd_contact_id:   main.contact || null,
        document_number: docNum,
        invoice_date:    main.date || null,
        due_date:        main.dueDate || null,
        state,
        subtotal:        main.linesTotal  != null ? Number(main.linesTotal)  : (main.totalBeforeTaxes != null ? Number(main.totalBeforeTaxes) : null),
        tax:             taxTotal,
        total:           main.total       != null ? Number(main.total)       : null,
        currency:        main.currency || 'EUR',
        raw:             inv,
        last_synced_at:  new Date().toISOString(),
        updated_at:      new Date().toISOString(),
      };
    });
    const { error } = await supabase
      .from('fd_invoices')
      .upsert(rows, { onConflict: 'fd_invoice_id' });
    if (error) throw new Error(error.message);
    console.log(`[fd-sync] invoices: ${rows.length} upserted`);

    // Sync lines
    const lineStart = new Date().toISOString();
    try {
      for (const inv of invoices) {
        const uuid  = inv.content?.uuid || String(inv.id || '');
        const main  = inv.content?.main || {};
        // Lines live at content.main.lines[]
        const lines = main.lines || [];
        if (!lines.length) continue;
        const lineRows = lines.map(l => {
          // tax_rate: lines have tax: ["S_IVA_21"] — extract numeric part
          let taxRate = null;
          if (Array.isArray(l.tax) && l.tax.length > 0) {
            const m = String(l.tax[0]).match(/(\d+(?:\.\d+)?)$/);
            if (m) taxRate = Number(m[1]);
          }
          return {
            fd_invoice_id:    uuid,
            description:      l.text || l.description || l.concepto || null,
            quantity:         l.quantity   != null ? Number(l.quantity)   : null,
            unit_price:       l.unitPrice  != null ? Number(l.unitPrice)  : null,
            line_total:       l.lineTotal  != null ? Number(l.lineTotal)  : null,
            tax_rate:         taxRate,
            service_category: null,
            raw:              l,
          };
        });
        await supabase.from('fd_invoice_lines').delete().eq('fd_invoice_id', uuid);
        await supabase.from('fd_invoice_lines').insert(lineRows);
        totalLines += lineRows.length;
      }
      await logSync('invoice_lines', 'ok', totalLines, null, lineStart);
      console.log(`[fd-sync] invoice_lines: ${totalLines} upserted`);
    } catch (lineErr) {
      await logSync('invoice_lines', 'error', 0, lineErr.message, lineStart);
      console.error('[fd-sync] invoice_lines error:', lineErr.message);
    }

    await logSync('invoices', 'ok', rows.length, null, start);
  } catch (e) {
    await logSync('invoices', 'error', 0, e.message, start);
    console.error('[fd-sync] invoices error:', e.message);
    throw e;
  }
}

async function syncFacturaDirecta() {
  console.log(`[fd-sync] iniciando sync @ ${new Date().toISOString()}`);
  const client = new FacturaDirectaClient();
  await syncContacts(client);
  await syncInvoices(client);
  console.log(`[fd-sync] sync completado @ ${new Date().toISOString()}`);
  return { ok: true };
}

module.exports = { syncFacturaDirecta };
