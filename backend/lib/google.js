// Shared Google OAuth2 client + Gmail and Drive helpers.
const { google } = require('googleapis');
require('dotenv').config();

function getOAuth2Client() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN (see docs/gmail-oauth2-setup.md)');
  }
  const oauth2 = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oauth2;
}

const auth = getOAuth2Client();
const gmail = google.gmail({ version: 'v1', auth });
const drive = google.drive({ version: 'v3', auth });

// --- Gmail ---

// List message IDs matching a Gmail search query (e.g. "newer_than:1d factura").
async function listMessages(query, max = 50) {
  const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: max });
  return res.data.messages || [];
}

// Fetch a full message and flatten the parts we care about.
async function getMessage(id) {
  const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
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
async function getAttachment(messageId, attachmentId) {
  const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
  return Buffer.from(res.data.data, 'base64');
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

// Upload a buffer as a file into a folder. Returns { id, webViewLink }.
async function uploadFile(name, buffer, folderId, mimeType = 'application/pdf') {
  const { Readable } = require('stream');
  const res = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id, webViewLink',
  });
  return res.data;
}

module.exports = {
  auth, gmail, drive,
  listMessages, getMessage, getAttachment,
  ensureFolder, ensureFolderPath, uploadFile,
};
