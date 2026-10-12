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

// ---- Oportunidades y conversaciones (token privado de la subcuenta) ----

function getSubcuenta(cliente, url, params) {
  if (!cliente.token_privado) throw new Error('Subcuenta sin token privado');
  return request({ method: 'get', url, params, headers: headers(cliente.token_privado) });
}

// GET /opportunities/pipelines — pipelines con sus etapas (id, name, position).
async function listarPipelines(cliente) {
  const data = await getSubcuenta(cliente, '/opportunities/pipelines', { locationId: cliente.location_id });
  return data.pipelines || [];
}

// GET /opportunities/search — todas las oportunidades de la subcuenta,
// paginadas con el cursor startAfter/startAfterId que devuelve meta.
async function listarOportunidades(cliente, { pausaMs = 150 } = {}) {
  const todas = [];
  let cursor = {};
  for (let i = 0; i < 1000; i++) {
    const data = await getSubcuenta(cliente, '/opportunities/search', { location_id: cliente.location_id, limit: 100, ...cursor });
    const page = data.opportunities || [];
    todas.push(...page);
    const meta = data.meta || {};
    if (page.length < 100 || !meta.startAfterId) break;
    cursor = { startAfter: meta.startAfter, startAfterId: meta.startAfterId };
    await sleep(pausaMs);
  }
  return todas;
}

// GET /conversations/search?contactId= — conversaciones de un contacto.
async function conversacionesContacto(cliente, contactId) {
  const data = await getSubcuenta(cliente, '/conversations/search', { locationId: cliente.location_id, contactId });
  return data.conversations || [];
}

// GET /conversations/{id}/messages — mensajes de una conversación (hasta
// maxPaginas × 100, paginando con lastMessageId).
async function mensajesConversacion(cliente, conversationId, { maxPaginas = 3, pausaMs = 150 } = {}) {
  const todos = [];
  let lastMessageId;
  for (let i = 0; i < maxPaginas; i++) {
    const data = await getSubcuenta(cliente, `/conversations/${encodeURIComponent(conversationId)}/messages`,
      { limit: 100, ...(lastMessageId ? { lastMessageId } : {}) });
    const m = data.messages || {};
    todos.push(...(m.messages || []));
    if (!m.nextPage || !m.lastMessageId) break;
    lastMessageId = m.lastMessageId;
    await sleep(pausaMs);
  }
  return todos;
}

// ---- Normalización de contactos ----
//
// Qué manda GHL (verificado con 526 leads reales de Capilar Mora, oct 2026):
// no hay array attributions; vienen attributionSource (first touch) y
// lastAttributionSource (last touch), objetos con sessionSource ("Paid Social",
// "Paid Search", "Organic Search", "Direct traffic", "Social media", "CRM UI"),
// medium ("form", "facebook", "manual"), url (página del formulario, con la
// query de la visita: gclid, gbraid, gad_source, gad_campaignid, utm_*…),
// referrer y, en los leads de Meta, utmSource/adSource "facebook", campaign +
// campaignId, adId y utmContent (ojo: utmMedium trae el NOMBRE de la campaña).
// A veces llegan como objeto vacío {}.

const META_RE = /facebook|\bfb\b|instagram|\big\b|\bmeta\b|paid social/i;
const GOOGLE_RE = /google|adwords|paid search/i;
const TAG_META_RE = /meta ads|facebook ads|instagram ads|\bfb ads\b/i;
const TAG_GOOGLE_RE = /google ads|adwords/i;
const ORGANICO_RE = /organic|org[aá]nico|referral|social media|\bseo\b/i;
const DIRECTO_RE = /direct/i;
const MANUAL_RE = /manual|crm|import|csv|\bapi\b|zapier/i;
const PARAMS_URL = ['gclid', 'gbraid', 'wbraid', 'gad_source', 'gad_campaignid', 'fbclid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];

function attrValor(a, ...keys) {
  if (!a) return null;
  for (const k of keys) if (a[k] != null && a[k] !== '') return String(a[k]);
  return null;
}

// Copia de la atribución con los parámetros de su url (gclid, utm_*…) añadidos
// si no venían ya como campo propio. null si el objeto está vacío.
function normalizarAttr(a) {
  if (!a || typeof a !== 'object' || !Object.keys(a).length) return null;
  const out = { ...a };
  if (a.url) {
    try {
      const params = new URL(a.url).searchParams;
      for (const k of PARAMS_URL) if (params.get(k) && out[k] == null) out[k] = params.get(k);
    } catch { /* url no parseable: se ignora */ }
  }
  return out;
}

// Atribución: first touch para las UTMs del lead; first y last cuentan para el
// canal. Soporta también el formato attributions[] (isFirst/isLast) de otras
// versiones de la API. El contacto completo queda en raw.
function atribuciones(c) {
  const list = (Array.isArray(c.attributions) ? c.attributions : []).map(normalizarAttr).filter(Boolean);
  const first = list.find(a => a.isFirst) || normalizarAttr(c.attributionSource) || list[0] || null;
  const last = list.find(a => a.isLast) || normalizarAttr(c.lastAttributionSource) || list[list.length - 1] || null;
  return { first, last, todas: [first, last, ...list].filter(Boolean) };
}

const textoAttr = a => [
  attrValor(a, 'utmSource', 'utm_source'), attrValor(a, 'sessionSource', 'utmSessionSource'),
  attrValor(a, 'medium'), attrValor(a, 'adSource'),
].filter(Boolean).join(' ');

// Plataforma de pago de UNA atribución (click ids primero), o null.
function senalPago(a) {
  if (a.fbclid || a.fbc) return 'meta';
  if (a.gclid || a.gbraid || a.wbraid || a.gad_source) return 'google';
  const t = textoAttr(a);
  if (META_RE.test(t)) return 'meta';
  if (GOOGLE_RE.test(t)) return 'google';
  return null;
}

// Origen no pagado de UNA atribución, o null.
function senalNoPago(a) {
  const t = textoAttr(a);
  if (ORGANICO_RE.test(t)) return 'organico';
  if (/crm ui|manual/i.test(t)) return 'manual';
  if (DIRECTO_RE.test(t)) return 'directo';
  return null;
}

// El canal es el del contacto que CREÓ el lead (first touch); el last touch
// solo desempata si el primero no dice nada. Un lead que entró por un
// formulario de Meta y luego volvió por Google Ads es de Meta (y al revés).
// Orden: pago en first → pago en last → source → tags → no pagado en first
// → no pagado en last → manual sin atribución → otro.
function derivarCanal(c, todas) {
  const fuente = c.source || '';
  const tags = (Array.isArray(c.tags) ? c.tags : []).join(' | ');

  for (const a of todas) { const p = senalPago(a); if (p) return p; }
  if (META_RE.test(fuente)) return 'meta';
  if (GOOGLE_RE.test(fuente)) return 'google';
  if (TAG_META_RE.test(tags)) return 'meta';
  if (TAG_GOOGLE_RE.test(tags)) return 'google';
  for (const a of todas) { const n = senalNoPago(a); if (n) return n; }
  if (!todas.some(a => textoAttr(a)) && (!fuente || MANUAL_RE.test(fuente))) return 'manual';
  return 'otro';
}

// Claves de duplicado. Teléfono: solo dígitos y los 9 últimos (así +34 600…,
// 0034 600… y 600… son el mismo); menos de 7 dígitos no cuenta. Email: minúsculas.
function normalizarTelefono(t) {
  const d = String(t || '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-9) : null;
}
function normalizarEmail(e) {
  const v = String(e || '').trim().toLowerCase();
  return v.includes('@') ? v : null;
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
    utm_source: utm(['utmSource', 'utm_source', 'adSource']),
    utm_medium: utm(['utmMedium', 'utm_medium']),
    utm_campaign: utm(['utmCampaign', 'utm_campaign', 'campaign']),
    utm_content: utm(['utmContent', 'utm_content']),
    campaign_id: utm(['campaignId', 'gad_campaignid']),
    ad_id: utm(['adId']),
    tags: Array.isArray(c.tags) ? c.tags : [],
    sin_contacto: !normalizarTelefono(c.phone) && !normalizarEmail(c.email),
    fecha_creacion: c.dateAdded,
    raw: c,
    synced_at: new Date().toISOString(),
  };
}

module.exports = {
  listarLocations, validarTokenPrivado, buscarContactos, contactoALead, derivarCanal, sleep,
  listarPipelines, listarOportunidades, conversacionesContacto, mensajesConversacion,
  normalizarTelefono, normalizarEmail,
};
