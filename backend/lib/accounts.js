// Account registry for the multi-account invoice agent.
//
// loadAccounts() returns every account whose credentials are present in the environment,
// so adding a mailbox is just a matter of filling in its env vars. createMailbox() turns
// an account into a provider-agnostic mailbox ({ listMessages, getMessage, getAttachment }).
const { createGmailClient } = require('./google');
const { createOutlookClient } = require('./outlook');
require('dotenv').config();

function loadAccounts() {
  const accounts = [];

  // 1. O2MAD — primary Gmail (already connected).
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    accounts.push({
      id: 'o2mad',
      provider: 'gmail',
      email: process.env.GMAIL_USER || 'o2mad',
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    });
  }

  // 2. Apper Street — Gmail (separate refresh token, same OAuth app).
  if (process.env.ACCT_APPER_GOOGLE_REFRESH_TOKEN) {
    accounts.push({
      id: 'apper',
      provider: 'gmail',
      email: process.env.ACCT_APPER_EMAIL || 'apper',
      refreshToken: process.env.ACCT_APPER_GOOGLE_REFRESH_TOKEN,
    });
  }

  // 3. Gulliver Ventures — Outlook / Microsoft 365 (app-only Graph access).
  if (process.env.MS_CLIENT_ID && process.env.MS_GULLIVER_EMAIL) {
    accounts.push({
      id: 'gulliver',
      provider: 'outlook',
      email: process.env.MS_GULLIVER_EMAIL,
    });
  }

  return accounts;
}

// Build the provider-agnostic mailbox for an account.
function createMailbox(account) {
  if (account.provider === 'gmail') return createGmailClient(account.refreshToken);
  if (account.provider === 'outlook') return createOutlookClient(account.email);
  throw new Error(`Unknown provider for account ${account.id}: ${account.provider}`);
}

module.exports = { loadAccounts, createMailbox };
