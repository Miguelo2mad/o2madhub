// Shared Google OAuth2 client + Gmail and Drive helpers.
//
// Two ways to use this module:
//   * Module-level singletons (auth/gmail/drive, listMessages/getMessage/...) bound to
//     the PRIMARY account's GOOGLE_REFRESH_TOKEN — used by Drive uploads and the
//     setup/backfill scripts.
//   * createGmailClient(refreshToken) — a per-account Gmail mailbox (used by the
//     multi-account agent). Returns the same { listMessages, getMessage, getAttachment }
//     interface as backend/lib/outlook.js so the agent stays provider-agnostic.
const { google } = require('googleapis');
require('dotenv').config();

// Build an OAuth2 client for a given refresh token (defaults to the primary account's).
function getOAuth2Client(refreshToken) {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  const token = refreshToken || GOOGLE_REFRESH_TOKEN;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !token) {
    throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN (see docs/gmail-oauth2-setup.md)');
  }
  const oauth2 = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2.setCredentials({ refresh_token: token });
  return oauth2;
}

const auth = getOAuth2Client();
const gmail = google.gmail({ version: 'v1', auth });
const drive = google.drive({ version: 'v3', auth });

// --- Gmail (low-level helpers; take an explicit gmail client) ---

// List message IDs matching a Gmail search query (e.g. "newer_than:1d factura").
// Paginates up to `max` total results.
async function listMessagesWith(gmailClient, query, max = 50) {
  const out = [];
  let pageToken;
  do {
    const res = await gmailClient.users.messages.list({
      userId: 'me', q: query, pageToken,
      maxResults: Math.min(100, max - out.length),
    });
    (res.data.messages || []).forEach(m => out.push(m));
    pageToken = res.data.nextPageToken;
  } while (pageToken && out.length < max);
  return out;
}

// Fetch a full message and flatten the parts we care about.
async function getMessageWith(gmailClient, id) {
  const res = await gmailClient.users.messages.get({ userId: 'me', id, format: 'full' });
  const msg = res.data;
  const headers = Object.fromEntries(
    (msg.payload.headers || []).map(h => [h.name.toLowerCase(), h.value])
  );

  // Collect plain-text body and PDF attachment refs by walking the MIME tree.
  let bodyText = '';
  const attachments = [];
  const walk = (part) => {
    if (!part) return;
    const mime = part.mimeType || '';
    const filename = part.filename || '';
    if (mime === 'text/plain' && part.body?.data) {
      bodyText += Buffer.from(part.body.data, 'base64').toString('utf8');
    }
    if (filename && (mime === 'application/pdf' || /\.pdf$/i.test(filename)) && part.body?.attachmentId) {
      attachments.push({ filename, attachmentId: part.body.attachmentId, mimeType: mime });
    }
    (part.parts || []).forEach(walk);
  };
  walk(msg.payload);

  return {
    id: msg.id,
    threadId: msg.threadId,
    subject: headers.subject || '(no subject)',
    from: headers.from || '',
    date: headers.date || '',
    snippet: msg.snippet || '',
    bodyText: bodyText || msg.snippet || '',
    attachments,
  };
}

// Download one attachment as a Buffer.
async function getAttachmentWith(gmailClient, messageId, attachmentId) {
  const res = await gmailClient.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
  return Buffer.from(res.data.data, 'base64');
}

// Build a Gmail search query from a normalized spec { keywords, days }.
// Besides the factura keywords, also catches invoices that arrive WITHOUT those keywords:
//   * from a whitelist of known invoice senders (INVOICE_SENDERS env), and
//   * inside reply/forward threads carrying a PDF attachment.
// The agent's es_factura check filters out anything that isn't really an invoice.
function buildGmailQuery({ keywords, days } = {}) {
  const kw = keywords || '(factura OR invoice OR recibo OR receipt OR fra)';
  const senders = (process.env.INVOICE_SENDERS || 'bielsb@bsbadministracio.es,sandra@o2mad.com')
    .split(',').map(s => s.trim()).filter(Boolean).map(s => `from:${s}`).join(' OR ');
  const clauses = [kw];
  if (senders) clauses.push(`((${senders}) has:attachment)`);
  clauses.push('(subject:(Re OR Fwd) has:attachment filename:pdf)');
  return `newer_than:${days || 1}d (${clauses.join(' OR ')})`;
}

// --- Primary-account singletons (kept for Drive uploads + setup/backfill scripts) ---
// listMessages here takes a RAW Gmail query string (backfill-drive.js relies on this).
const listMessages = (query, max) => listMessagesWith(gmail, query, max);
const getMessage = (id) => getMessageWith(gmail, id);
const getAttachment = (messageId, attachmentId) => getAttachmentWith(gmail, messageId, attachmentId);

// --- Per-account Gmail mailbox (provider-agnostic interface for the agent) ---
// listMessages here takes a normalized spec { keywords, days } so it matches outlook.js.
function createGmailClient(refreshToken) {
  const client = google.gmail({ version: 'v1', auth: getOAuth2Client(refreshToken) });
  const getEmailDetail = (id) => getMessageWith(client, id);
  return {
    provider: 'gmail',
    listMessages: (spec, max) => listMessagesWith(client, buildGmailQuery(spec), max),
    getMessage: getEmailDetail,
    getEmailDetail,
    getAttachment: (messageId, attachmentId) => getAttachmentWith(client, messageId, attachmentId),
  };
}

// --- Drive ---

// Find a folder by name under a parent (or root), creating it if absent. Returns folder id.
async function ensureFolder(name, parentId = null) {
  const safeName = name.replace(/'/g, "\\'");
  let q = `mimeType='application/vnd.google-apps.folder' and name='${safeName}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const found = await drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive' });
  if (found.data.files?.length) return found.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: 'id',
  });
  return created.data.id;
}

// Walk/create a nested path of folders (array of names) under an optional starting
// parent id, and return the deepest folder id.
async function ensureFolderPath(names, startParent = null) {
  let parent = startParent;
  for (const name of names) parent = await ensureFolder(name, parent);
  return parent;
}

// Find a file by exact name within a folder. Returns { id, webViewLink } or null.
async function findFileInFolder(name, folderId) {
  const safeName = name.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name='${safeName}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id,webViewLink)',
    spaces: 'drive',
  });
  return res.data.files?.[0] || null;
}

// Upload a buffer as a file into a folder. If a file with the same name already
// exists in that folder, skip the upload and return the existing file.
// Returns { id, webViewLink, existed }.
async function uploadFile(name, buffer, folderId, mimeType = 'application/pdf') {
  const existing = await findFileInFolder(name, folderId);
  if (existing) return { ...existing, existed: true };

  const { Readable } = require('stream');
  const res = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id, webViewLink',
  });
  return { ...res.data, existed: false };
}

module.exports = {
  auth, gmail, drive,
  listMessages, getMessage, getAttachment,
  createGmailClient,
  ensureFolder, ensureFolderPath, findFileInFolder, uploadFile,
};
