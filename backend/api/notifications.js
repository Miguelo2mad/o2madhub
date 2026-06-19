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
        <th>Fecha</th><th>Proveedor</th><th>Ref.</th><th>Concepto</th><th>Sociedad</th><th>Importe</th><th>Drive</th>
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

module.exports = { sendDailySummary, buildHtml };
