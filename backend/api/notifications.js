// Daily email summary of processed invoices.
// Sends via Gmail using the same OAuth2 credentials (mail.google.com scope).
const nodemailer = require('nodemailer');
require('dotenv').config();

function getTransport() {
  const { GMAIL_USER, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type: 'OAuth2',
      user: GMAIL_USER,
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      refreshToken: GOOGLE_REFRESH_TOKEN,
    },
  });
}

const eur = (n) => (n == null ? '—' : `${Number(n).toFixed(2)} €`);
const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function buildHtml({ processed, skipped, errors }) {
  const today = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });
  const total = processed.reduce((s, f) => s + (Number(f.importe) || 0), 0);
  const appUrl = process.env.RAILWAY_URL || `http://localhost:${process.env.PORT || 8080}`;

  const rows = processed.map(f => {
    const links = (f.driveLinks || []).map((l, i) => `<a href="${esc(l)}">PDF${f.driveLinks.length > 1 ? ' ' + (i + 1) : ''}</a>`).join(' · ') || '—';
    return `<tr>
      <td>${esc(f.source_account || '—')}</td>
      <td>${esc(f.fecha_factura || '—')}</td>
      <td>${esc(f.proveedor)}</td>
      <td>${esc(f.referencia)}</td>
      <td>${esc(f.concepto || '')}</td>
      <td>${esc(f.sociedad || f.sociedad_codigo)}</td>
      <td style="text-align:right">${eur(f.importe)}</td>
      <td>${links}</td>
    </tr>`;
  }).join('');

  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
    <h2>Resumen diario de facturas — ${today}</h2>
    <p><b>${processed.length}</b> factura(s) procesada(s) · total <b>${eur(total)}</b>
       ${skipped.length ? `· ${skipped.length} omitida(s)` : ''}
       ${errors.length ? `· <span style="color:#b00">${errors.length} error(es)</span>` : ''}</p>
    ${processed.length ? `<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#ddd">
      <thead style="background:#f4f1ea"><tr>
        <th>Cuenta</th><th>Fecha</th><th>Proveedor</th><th>Ref.</th><th>Concepto</th><th>Sociedad</th><th>Importe</th><th>Drive</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>` : '<p>No se procesaron facturas nuevas hoy.</p>'}
    ${errors.length ? `<h3 style="color:#b00">Errores</h3><ul>${errors.map(e => `<li>${esc(e.id)}: ${esc(e.message)}</li>`).join('')}</ul>` : ''}
    <p style="color:#888;font-size:12px">Enviado automáticamente por
      <a href="${esc(appUrl)}">o2madhub</a>.</p>
  </div>`;
}

// Send the daily summary. `result` is the object returned by runFacturaAgent().
async function sendDailySummary(result) {
  const to = (process.env.NOTIFY_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  const cc = (process.env.NOTIFY_CC || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!to.length) { console.warn('[notifications] NOTIFY_TO empty — skipping email'); return null; }

  const info = await getTransport().sendMail({
    from: `O2MAD Hub <${process.env.GMAIL_USER}>`,
    to,
    cc,
    subject: `Facturas O2MAD — ${result.processed.length} nuevas (${new Date().toLocaleDateString('es-ES')})`,
    html: buildHtml(result),
  });
  console.log(`[notifications] sent: ${info.messageId} → ${to.join(', ')}`);
  return info;
}

// Notify info@o2mad.com about invoices with NO identifiable CIF that need manual
// classification. One consolidated email per scan, with each PDF attached.
// items: [{ proveedor, importe, fecha_factura, referencia, source, link, filename, buf }]
async function sendNoCifNotice(items, scanLabel = '') {
  if (!items.length) return null;
  const rows = items.map(i => `<tr>
      <td>${esc(i.source)}</td>
      <td>${esc(i.proveedor || '—')}</td>
      <td>${esc(i.referencia || '—')}</td>
      <td style="text-align:right">${eur(i.importe)}</td>
      <td>${i.link ? `<a href="${esc(i.link)}">ver</a>` : '—'}</td>
    </tr>`).join('');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
    <h2>Facturas sin CIF identificado — necesitan clasificación manual</h2>
    <p>${items.length} factura(s) ${scanLabel ? `(${esc(scanLabel)}) ` : ''}no traen un CIF de destinatario reconocible, así que NO se han clasificado ni insertado. PDFs adjuntos.</p>
    <table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#ddd">
      <thead style="background:#f4f1ea"><tr><th>Origen</th><th>Proveedor</th><th>Ref.</th><th>Importe</th><th>PDF</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  // Attach the PDFs we have buffers for (cap total to keep the email under Gmail limits).
  let total = 0;
  const attachments = [];
  for (const i of items) {
    if (i.buf && total + i.buf.length < 20 * 1024 * 1024) { attachments.push({ filename: i.filename || `${i.referencia || 'factura'}.pdf`, content: i.buf }); total += i.buf.length; }
  }
  const info = await getTransport().sendMail({
    from: `O2MAD Hub <${process.env.GMAIL_USER}>`,
    to: 'info@o2mad.com',
    subject: 'Factura sin CIF identificado - necesita clasificación manual',
    html, attachments,
  });
  console.log(`[notifications] no-CIF notice sent: ${info.messageId} (${items.length} items, ${attachments.length} adjuntos)`);
  return info;
}

module.exports = { sendDailySummary, buildHtml, sendNoCifNotice };
