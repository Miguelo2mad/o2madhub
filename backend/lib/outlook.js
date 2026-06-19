// Microsoft Graph (Outlook / Microsoft 365) mailbox adapter.
//
// Uses the APP-ONLY (client credentials) flow with a ClientSecretCredential, so no
// per-user refresh token is needed — the Entra app reads the mailbox directly via its
// own secret. This requires, in Entra ID → App registrations:
//   * API permission: Microsoft Graph → Application → Mail.Read  (admin-consented)
//   * (recommended) an Application Access Policy scoping the app to just this mailbox.
//
// Exposes the SAME interface as createGmailClient() in backend/lib/google.js:
//   listMessages({ keywords, days }, max) -> [{ id }]
//   getEmailDetail(id) / getMessage(id)   -> { id, subject, from, date, bodyText, attachments[] }
//   getAttachment(messageId, attachmentId)-> Buffer (PDF bytes)
const { ClientSecretCredential } = require('@azure/identity');
const { Client } = require('@microsoft/microsoft-graph-client');
const {
  TokenCredentialAuthenticationProvider,
} = require('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials');
require('dotenv').config();

// Pull the OR-joined keywords ("(factura OR invoice OR ...)") down to bare terms so we
// can match them against a message's subject + preview client-side.
function keywordTerms(keywords) {
  return String(keywords || '')
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t && !/^(OR|AND)$/i.test(t));
}

function keywordRegex(keywords) {
  const terms = keywordTerms(keywords);
  if (!terms.length) return null;
  const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('|'), 'i');
}

// Build a Graph client for a mailbox using the shared Entra app credentials.
function createOutlookClient(userEmail) {
  const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET } = process.env;
  if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    throw new Error('Missing MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET for Outlook account');
  }
  if (!userEmail) throw new Error('Missing mailbox address (MS_GULLIVER_EMAIL) for Outlook account');

  const credential = new ClientSecretCredential(MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET);
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default'],
  });
  const client = Client.initWithMiddleware({ authProvider });
  const base = `/users/${encodeURIComponent(userEmail)}`;

  // List candidate invoice message ids from the last `days` days.
  // We filter server-side by date (correct + ordered) and match keywords client-side
  // against subject + bodyPreview — Graph forbids combining $search with $filter/$orderby.
  async function listMessages({ keywords, days } = {}, max = 50) {
    const sinceMs = Date.now() - (days || 1) * 24 * 60 * 60 * 1000;
    const sinceIso = new Date(sinceMs).toISOString();
    const rx = keywordRegex(keywords);

    const out = [];
    let page = await client
      .api(`${base}/messages`)
      .header('Prefer', 'outlook.body-content-type="text"')
      .filter(`receivedDateTime ge ${sinceIso}`)
      .select('id,subject,bodyPreview,receivedDateTime')
      .orderby('receivedDateTime desc')
      .top(Math.min(50, max))
      .get();

    while (page) {
      for (const m of page.value || []) {
        if (out.length >= max) break;
        const haystack = `${m.subject || ''} ${m.bodyPreview || ''}`;
        if (!rx || rx.test(haystack)) out.push({ id: m.id });
      }
      const next = page['@odata.nextLink'];
      if (out.length >= max || !next) break;
      page = await client.api(next).get();
    }
    return out;
  }

  // Fetch one message and normalize it to the same shape gmail.js returns.
  async function getEmailDetail(id) {
    const m = await client
      .api(`${base}/messages/${id}`)
      .header('Prefer', 'outlook.body-content-type="text"')
      .select('id,conversationId,subject,from,receivedDateTime,bodyPreview,body,hasAttachments')
      .get();

    const attachments = [];
    if (m.hasAttachments) {
      const att = await client
        .api(`${base}/messages/${id}/attachments`)
        .select('id,name,contentType,size')
        .get();
      for (const a of att.value || []) {
        const filename = a.name || '';
        const mime = a.contentType || '';
        if (mime === 'application/pdf' || /\.pdf$/i.test(filename)) {
          attachments.push({ filename, attachmentId: a.id, mimeType: mime || 'application/pdf' });
        }
      }
    }

    const addr = m.from && m.from.emailAddress;
    return {
      id: m.id,
      threadId: m.conversationId,
      subject: m.subject || '(no subject)',
      from: addr ? `${addr.name || ''} <${addr.address || ''}>`.trim() : '',
      date: m.receivedDateTime || '',
      snippet: m.bodyPreview || '',
      bodyText: (m.body && m.body.content) || m.bodyPreview || '',
      attachments,
    };
  }

  // Download one attachment as a Buffer. Graph returns the bytes base64-encoded inline
  // (fileAttachment.contentBytes); reference/large attachments have no contentBytes.
  async function getAttachment(messageId, attachmentId) {
    const a = await client.api(`${base}/messages/${messageId}/attachments/${attachmentId}`).get();
    if (!a.contentBytes) {
      throw new Error('Outlook attachment has no contentBytes (reference or oversized attachment)');
    }
    return Buffer.from(a.contentBytes, 'base64');
  }

  return {
    provider: 'outlook',
    listMessages,
    getMessage: getEmailDetail,
    getEmailDetail,
    getAttachment,
  };
}

module.exports = { createOutlookClient };
