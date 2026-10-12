// Cliente de solo lectura de la API de Gulliver AI (atención por WhatsApp/voz
// y citas de las clínicas). Endpoints en Gulliver: apps/api/src/routes/leads-export.ts.
// GULLIVER_API_KEY nunca se registra ni se devuelve al frontend.
const API_URL = (process.env.GULLIVER_API_URL || 'https://gulliverapi-production.up.railway.app').replace(/\/+$/, '');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(ruta, params) {
  const key = process.env.GULLIVER_API_KEY;
  if (!key) throw new Error('GULLIVER_API_KEY no configurada');
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  for (let intento = 0; ; intento++) {
    const res = await fetch(`${API_URL}/api/v1/leads/${ruta}?${qs}`, {
      headers: { 'x-gulliver-api-key': key, accept: 'application/json' },
      signal: AbortSignal.timeout(120_000),
    });
    if ((res.status === 429 || res.status >= 500) && intento < 3) {
      await sleep(5000 * (intento + 1));
      continue;
    }
    if (!res.ok) throw new Error(`Gulliver ${ruta}: HTTP ${res.status}`);
    return res.json();
  }
}

// Recorre todas las páginas de un endpoint paginado por cursor.
async function todo(ruta, campo, { hotelId, desde, limit }) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 1000; i++) {
    const r = await get(ruta, { hotel_id: hotelId, desde, cursor, limit });
    out.push(...(r[campo] || []));
    if (!r.next_cursor) return out;
    cursor = r.next_cursor;
  }
  throw new Error(`Gulliver ${ruta}: demasiadas páginas`);
}

const contactos = opts => todo('contactos', 'contactos', { limit: 500, ...opts });
const citas = opts => todo('citas', 'citas', { limit: 1000, ...opts });

// Mismo criterio que normalizePhone de Gulliver (packages/shared/src/common.ts):
// E.164 con "+", números españoles de 9 dígitos → +34. null si no es válido.
function telefonoE164(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  else if (!s.startsWith('+')) {
    if (/^34[6789]\d{8}$/.test(s)) s = `+${s}`;
    else if (/^[6789]\d{8}$/.test(s)) s = `+34${s}`;
  }
  return /^\+\d{8,15}$/.test(s) ? s : null;
}

module.exports = { contactos, citas, telefonoE164 };
