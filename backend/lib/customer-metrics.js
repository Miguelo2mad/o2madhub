'use strict';
const { supabase } = require('./supabase');

async function loadConfig() {
  const { data, error } = await supabase
    .from('customer_status_config')
    .select('*')
    .eq('id', 1)
    .single();
  if (error || !data) throw new Error('customer_status_config no encontrada');
  return data;
}

function classifyStatus(daysSinceLast, frequencyDevRatio, isNew, config) {
  if (isNew) return 'NEW';
  // If still within 1.5x the normal purchase cycle, treat as ACTIVE
  if (frequencyDevRatio != null && frequencyDevRatio < 1.5) return 'ACTIVE';
  if (daysSinceLast <= config.active_max_days)   return 'ACTIVE';
  if (daysSinceLast <= config.at_risk_max_days)  return 'AT_RISK';
  if (daysSinceLast <= config.inactive_max_days) return 'INACTIVE';
  if (daysSinceLast <= config.dormant_max_days)  return 'DORMANT';
  return 'LOST';
}

function calcReactivationScore({ revenueTotal, invoiceCount, firstInvoiceDate, customerStatus }) {
  // 1. Revenue history (0-25): log scale
  const revScore = Math.min(25, Math.round(Math.log10(Math.max(revenueTotal, 1) + 1) * 5));

  // 2. Frequency (0-20): invoice count up to 20
  const freqScore = Math.min(20, invoiceCount);

  // 3. Inactivity signal (0-20): priority zone for reactivation
  let inactivityScore = 0;
  if (customerStatus === 'AT_RISK')  inactivityScore = 15;
  if (customerStatus === 'INACTIVE') inactivityScore = 20;
  if (customerStatus === 'DORMANT')  inactivityScore = 18;
  if (customerStatus === 'LOST')     inactivityScore = 10;

  // 4. Cross-sell potential (0-20): neutral 10 until Phase 6
  const crossSellScore = 10;

  // 5. Relationship quality (0-15): tenure in months / 6
  let tenureMonths = 0;
  if (firstInvoiceDate) {
    tenureMonths = (Date.now() - new Date(firstInvoiceDate).getTime()) / (1000 * 60 * 60 * 24 * 30);
  }
  const relationScore = Math.min(15, Math.round(tenureMonths / 6));

  return Math.min(100, Math.max(0, revScore + freqScore + inactivityScore + crossSellScore + relationScore));
}

function calcMetricsForContact(contact, invoices, config) {
  if (!invoices.length) return null;

  const now = new Date();
  const oneYearAgo  = new Date(now); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const twoYearsAgo = new Date(now); twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

  const sorted = [...invoices]
    .filter(inv => inv.invoice_date)
    .sort((a, b) => new Date(a.invoice_date) - new Date(b.invoice_date));

  if (!sorted.length) return null;

  const firstDate = sorted[0].invoice_date;
  const lastDate  = sorted[sorted.length - 1].invoice_date;
  const lastInvoiceDate = new Date(lastDate);
  const daysSinceLast   = Math.floor((now - lastInvoiceDate) / (1000 * 60 * 60 * 24));

  const revenueTotal       = invoices.reduce((s, inv) => s + (Number(inv.total) || 0), 0);
  const invoices12m        = invoices.filter(inv => inv.invoice_date && new Date(inv.invoice_date) >= oneYearAgo);
  const invoicesPrev12m    = invoices.filter(inv => {
    if (!inv.invoice_date) return false;
    const d = new Date(inv.invoice_date);
    return d >= twoYearsAgo && d < oneYearAgo;
  });
  const revenue12m         = invoices12m.reduce((s, inv) => s + (Number(inv.total) || 0), 0);
  const revenuePrevious12m = invoicesPrev12m.reduce((s, inv) => s + (Number(inv.total) || 0), 0);
  const averageInvoice     = invoices.length > 0 ? revenueTotal / invoices.length : null;

  let avgDaysBetween = null;
  let frequencyDevRatio = null;
  if (sorted.length >= 2) {
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      const diff = (new Date(sorted[i].invoice_date) - new Date(sorted[i-1].invoice_date)) / (1000 * 60 * 60 * 24);
      if (diff >= 0) gaps.push(diff);
    }
    if (gaps.length) {
      avgDaysBetween = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      if (avgDaysBetween > 0) frequencyDevRatio = daysSinceLast / avgDaysBetween;
    }
  }

  const firstInvoiceDate = new Date(firstDate);
  const isNew = (now - firstInvoiceDate) / (1000 * 60 * 60 * 24) <= config.new_max_days;
  const customerStatus = classifyStatus(daysSinceLast, frequencyDevRatio, isNew, config);

  const reactivationScore = calcReactivationScore({
    revenueTotal,
    invoiceCount: invoices.length,
    firstInvoiceDate: firstDate,
    customerStatus,
  });

  return {
    fd_contact_id:                  contact.fd_contact_id,
    first_invoice_date:             firstDate,
    last_invoice_date:              lastDate,
    days_since_last_invoice:        daysSinceLast,
    invoice_count:                  invoices.length,
    invoice_count_12m:              invoices12m.length,
    revenue_total:                  parseFloat(revenueTotal.toFixed(2)),
    revenue_12m:                    parseFloat(revenue12m.toFixed(2)),
    revenue_previous_12m:           parseFloat(revenuePrevious12m.toFixed(2)),
    average_invoice:                averageInvoice != null ? parseFloat(averageInvoice.toFixed(2)) : null,
    average_days_between_invoices:  avgDaysBetween != null ? parseFloat(avgDaysBetween.toFixed(1)) : null,
    frequency_deviation_ratio:      frequencyDevRatio != null ? parseFloat(frequencyDevRatio.toFixed(2)) : null,
    services_count:                 null,
    services_used:                  null,
    activity_score:                 null,
    value_score:                    null,
    reactivation_score:             reactivationScore,
    customer_status:                customerStatus,
    calculated_at:                  now.toISOString(),
  };
}

async function recalculateAllMetrics() {
  const config = await loadConfig();

  const { data: contacts, error: cErr } = await supabase
    .from('fd_contacts').select('fd_contact_id, name');
  if (cErr) throw new Error(cErr.message);

  const { data: allInvoices, error: iErr } = await supabase
    .from('fd_invoices').select('fd_contact_id, invoice_date, total');
  if (iErr) throw new Error(iErr.message);

  const byContact = {};
  for (const inv of allInvoices) {
    if (!inv.fd_contact_id) continue;
    if (!byContact[inv.fd_contact_id]) byContact[inv.fd_contact_id] = [];
    byContact[inv.fd_contact_id].push(inv);
  }

  const rows = [];
  let skipped = 0;
  for (const contact of contacts) {
    const invoices = byContact[contact.fd_contact_id] || [];
    if (!invoices.length) { skipped++; continue; }
    const metrics = calcMetricsForContact(contact, invoices, config);
    if (metrics) rows.push(metrics);
    else skipped++;
  }

  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase
      .from('customer_metrics')
      .upsert(rows.slice(i, i + BATCH), { onConflict: 'fd_contact_id' });
    if (error) throw new Error(`upsert batch ${i}: ${error.message}`);
  }

  const statusCounts = {};
  for (const r of rows) statusCounts[r.customer_status] = (statusCounts[r.customer_status] || 0) + 1;

  console.log(`[customer-metrics] recalculados: ${rows.length}, sin facturas: ${skipped}`);
  console.log('[customer-metrics] por status:', JSON.stringify(statusCounts));

  return { calculated: rows.length, skipped, statusCounts };
}

module.exports = { recalculateAllMetrics };
