// Cliente de la API v2 de GoHighLevel (services.leadconnectorhq.com).
// Dos tokens, cada uno para una cosa:
//   - GHL_AGENCY_TOKEN (Private Integration de agencia): SOLO para descubrir
//     subcuentas (/locations/search). Un PIT de agencia no puede pedir tokens de
//     subcuenta (/oauth/locationToken da 401), así que no se intenta.
//   - clientes_ghl.token_privado (PIT de cada subcuenta, scopes contacts.readonly
//     + locations.readonly): para leer contactos. Sin él, la subcuenta se salta.
const axios = require('axios');

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';
const MAX_REINTENTOS = 5;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function agencyConfig() {
  const token = process.env.GHL_AGENCY_TOKEN;
  const companyId = process.env.GHL_COMPANY_ID;
  if (!token || !companyId) throw new Error('GHL_AGENCY_TOKEN / GHL_COMPANY_ID no configurados');
  return { token, companyId };
}

// Mensaje legible de un error de axios contra GHL (sin cabeceras ni tokens).
function ghlError(e) {
  const status = e.response?.status;
  const msg = e.response?.data?.message || e.response?.data?.error || e.message;
  return status ? `GHL ${status}: ${Array.isArray(msg) ? msg.join('; ') : msg}` : msg;
}

// Petición con reintento y backoff exponencial en 429 y 5xx. Respeta
// Retry-After si GHL lo envía. Límite GHL: 100 peticiones / 10 s por location.
async function request(config, intento = 1) {
  try {
    const res = await axios({ baseURL: BASE, timeout: 30000, ...config });
    return res.data;
  } catch (e) {
    const status = e.response?.status;
    const reintentable = status === 429 || (status >= 500 && status < 600) || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT';
    if (reintentable && intento < MAX_REINTENTOS) {
      const retryAfter = Number(e.response?.headers?.['retry-after']);
      const espera = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (intento - 1);
      console.warn(`[leads] GHL ${status || e.code} en ${config.url} — reintento ${intento}/${MAX_REINTENTOS - 1} en ${espera} ms`);
      await sleep(espera);
      return request(config, intento + 1);
    }
    const err = new Error(ghlError(e));
    err.status = status;
    throw err;
  }
}

const headers = token => ({ Authorization: `Bearer ${token}`, Version: VERSION, Accept: 'application/json' });

// GET /locations/search — todas las subcuentas de la agencia (paginado skip/limit).
async function listarLocations() {
  const { token, companyId } = agencyConfig();
  const limit = 100;
  const todas = [];
  for (let skip = 0; ; skip += limit) {
    const data = await request({
      method: 'get', url: '/locations/search',
      headers: headers(token),
      params: { companyId, skip, limit },
    });
    const page = data.locations || [];
    todas.push(...page);
    if (page.length < limit) break;
    await sleep(150);
  }
  return todas;
}

// GET /locations/{locationId} con el token privado de la subcuenta. Sirve para
// validar un token antes de guardarlo: debe responder y devolver esa misma location.
async function validarTokenPrivado(locationId, token) {
  try {
    const data = await request({ method: 'get', url: `/locations/${encodeURIComponent(locationId)}`, headers: headers(token) });
    const id = data.location?.id || data.id;
    if (id && id !== locationId) return { ok: false, error: 'El token es de otra subcuenta' };
    return { ok: true, nombre: data.location?.name || data.name || null };
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      return { ok: false, error: `Token no válido para esta subcuenta o sin scope locations.readonly (${e.message})` };
    }
    return { ok: false, error: e.message };
  }
}

// POST /contacts/search — una página de contactos con dateAdded en [gte, lte],
// ordenados por dateAdded asc. Solo con el token privado de la subcuenta.
// Paginación por searchAfter (cursor que GHL devuelve en cada contacto); page
// solo como respaldo, porque tiene un tope de 10.000 resultados.
async function buscarContactos(cliente, { gte, lte, searchAfter, page = 1, pageLimit = 100 }) {
  if (!cliente.token_privado) throw new Error('Subcuenta sin token privado');
  const body = {
    locationId: cliente.location_id,
    pageLimit,
    filters: [{ field: 'dateAdded', operator: 'range', value: { gte, lte } }],
    sort: [{ field: 'dateAdded', direction: 'asc' }],
  };
  if (searchAfter) body.searchAfter = searchAfter;
  else body.page = page;

  return request({
    method: 'post', url: '/contacts/search',
    headers: { ...headers(cliente.token_privado), 'Content-Type': 'application/json' },
    data: body,
  });
}

// ---- Normalización de contactos ----

const META_RE = /facebook|\bfb\b|instagram|\big\b|\bmeta\b|paid social/i;
const GOOGLE_RE = /google|adwords|\bgclid\b/i;
const ORGANICO_RE = /organic|org[aá]nico|direct|referral|social media|\bseo\b/i;
const MANUAL_RE = /manual|crm|import|csv|\bapi\b|zapier/i;

function attrValor(a, ...keys) {
  if (!a) return null;
  for (const k of keys) if (a[k] != null && a[k] !== '') return String(a[k]);
  return null;
}

// Atribución: first touch (isFirst) para las UTMs del lead; last touch solo
// cuenta para derivar el canal. El contacto completo queda en raw.
function atribuciones(c) {
  const list = Array.isArray(c.attributions) ? c.attributions : [];
  const first = list.find(a => a.isFirst) || c.attributionSource || list[0] || null;
  const last = list.find(a => a.isLast) || c.lastAttributionSource || list[list.length - 1] || null;
  return { first, last, todas: [first, last, ...list].filter(Boolean) };
}

function derivarCanal(c, todas) {
  const textoAttr = todas.map(a => [
    attrValor(a, 'utmSource', 'utm_source'), attrValor(a, 'sessionSource', 'utmSessionSource'),
    attrValor(a, 'medium'), attrValor(a, 'adSource'), attrValor(a, 'utmMedium', 'utm_medium'),
  ].filter(Boolean).join(' ')).join(' ');
  const fuente = c.source || '';
  const tieneFbclid = todas.some(a => a.fbclid || a.fbc);
  const tieneGclid = todas.some(a => a.gclid || a.wbraid || a.gbraid);

  if (tieneFbclid || META_RE.test(textoAttr) || META_RE.test(fuente)) return 'meta';
  if (tieneGclid || GOOGLE_RE.test(textoAttr) || GOOGLE_RE.test(fuente)) return 'google';
  if (textoAttr && ORGANICO_RE.test(textoAttr)) return 'organico';
  if (!textoAttr && (!fuente || MANUAL_RE.test(fuente))) return 'manual';
  return 'otro';
}

function contactoALead(c, locationId) {
  const { first, last, todas } = atribuciones(c);
  const nombre = c.contactName || [c.firstName, c.lastName].filter(Boolean).join(' ') || c.companyName || null;
  const utm = k => attrValor(first, ...k) || attrValor(last, ...k);
  return {
    ghl_contact_id: c.id,
    location_id: locationId,
    nombre,
    email: c.email || null,
    telefono: c.phone || null,
    fuente: c.source || null,
    canal: derivarCanal(c, todas),
    utm_source: utm(['utmSource', 'utm_source']),
    utm_medium: utm(['utmMedium', 'utm_medium']),
    utm_campaign: utm(['utmCampaign', 'utm_campaign', 'campaign']),
    utm_content: utm(['utmContent', 'utm_content']),
    tags: Array.isArray(c.tags) ? c.tags : [],
    fecha_creacion: c.dateAdded,
    raw: c,
    synced_at: new Date().toISOString(),
  };
}

module.exports = { listarLocations, validarTokenPrivado, buscarContactos, contactoALead, derivarCanal, sleep };
