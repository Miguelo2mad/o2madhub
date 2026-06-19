// Generates a Google OAuth2 refresh token via a local loopback flow.
// Usage:
//   node get-token.js                     → writes GOOGLE_REFRESH_TOKEN (primary o2mad account)
//   node get-token.js --account=apper     → writes ACCT_APPER_GOOGLE_REFRESH_TOKEN
//   node get-token.js --account=<id>      → writes ACCT_<ID>_GOOGLE_REFRESH_TOKEN
//
// Sign in on the consent screen as the Google account you want THIS token for — the same
// OAuth client (GOOGLE_CLIENT_ID) mints refresh tokens for any account.
//
// PREREQUISITE: the OAuth client (GOOGLE_CLIENT_ID) must list
//   http://localhost:3000/callback
// under "Authorized redirect URIs" in Google Cloud Console → Credentials.
//
// The token is minted by YOUR client_id/secret, so it avoids the
// "invalid_grant" mismatch seen with the OAuth Playground.

const express = require('express');
const { google } = require('googleapis');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;

// Which .env var receives the refresh token, chosen by --account=<id>.
// Default (no flag) or --account=o2mad → the primary GOOGLE_REFRESH_TOKEN.
const accountArg = process.argv.find(a => a.startsWith('--account='));
const ACCOUNT = accountArg ? accountArg.split('=')[1].trim().toLowerCase() : 'o2mad';
const TOKEN_VAR = (!ACCOUNT || ACCOUNT === 'o2mad')
  ? 'GOOGLE_REFRESH_TOKEN'
  : `ACCT_${ACCOUNT.toUpperCase()}_GOOGLE_REFRESH_TOKEN`;

const SCOPES = [
  'https://mail.google.com/',                 // full Gmail (nodemailer)
  'https://www.googleapis.com/auth/drive',    // full Drive
];

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',      // required to receive a refresh token
  prompt: 'consent',           // force a refresh token even on re-consent
  scope: SCOPES,
});

// Persist the new refresh token into .env under TOKEN_VAR (replace existing line or append).
function writeRefreshToken(token) {
  const envPath = path.join(__dirname, '.env');
  let env = fs.readFileSync(envPath, 'utf8');
  const line = `${TOKEN_VAR}=${token}`;
  const re = new RegExp(`^${TOKEN_VAR}=.*$`, 'm');
  if (re.test(env)) {
    env = env.replace(re, line);
  } else {
    env += `\n${line}\n`;
  }
  fs.writeFileSync(envPath, env);
}

const app = express();

// Non-secret diagnostics land here so nothing is lost to a stdout flush race.
const DIAG = '/tmp/get-token-result.json';
function diag(obj) { try { fs.writeFileSync(DIAG, JSON.stringify(obj, null, 2)); } catch {} }

app.get('/callback', async (req, res) => {
  res.set('Connection', 'close');
  const { code, error } = req.query;
  if (error) {
    res.status(400).send(`Authorization failed: ${error}`);
    console.error('Authorization failed:', error);
    diag({ ok: false, stage: 'consent', error });
    return finish(1);
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.send('<h2>✓ Authorized.</h2><p>You can close this tab and return to the terminal.</p>');

    console.log('\n=== TOKENS RECEIVED ===');
    const hasRefresh = Boolean(tokens.refresh_token);
    if (hasRefresh) {
      console.log('REFRESH TOKEN:\n' + tokens.refresh_token);
      writeRefreshToken(tokens.refresh_token);
      console.log(`\n✓ Written to .env (${TOKEN_VAR}) for account "${ACCOUNT}".`);
    } else {
      console.log('⚠ No refresh_token returned. Revoke access at');
      console.log('  https://myaccount.google.com/permissions and run again.');
    }
    console.log('Access token acquired:', Boolean(tokens.access_token));
    diag({ ok: true, hasRefreshToken: hasRefresh, hasAccessToken: Boolean(tokens.access_token),
      scope: tokens.scope, token_type: tokens.token_type, expiry_date: tokens.expiry_date });
    console.log('\nNext: node verify-google.js');
    finish(0);
  } catch (e) {
    const detail = e.response && e.response.data;
    res.status(500).send('Token exchange failed: ' + e.message);
    console.error('Token exchange FAILED:', e.message);
    console.error('Detail:', detail);
    diag({ ok: false, stage: 'token_exchange', message: e.message, detail });
    finish(1);
  }
});

// Flush stdout, then exit. server.close drains keep-alive; timer is a backstop.
function finish(code) {
  process.exitCode = code;
  server.close();
  setTimeout(() => process.exit(code), 800);
}

const server = app.listen(PORT, () => {
  console.log(`Listening on ${REDIRECT_URI}`);
  console.log(`Target account: "${ACCOUNT}" → will write ${TOKEN_VAR}`);
  console.log('Sign in on the consent screen as the Google account you want this token for.');
  console.log('\nOpening browser for consent. If it does not open, paste this URL:\n');
  console.log(authUrl + '\n');
  // macOS: open the default browser.
  exec(`open "${authUrl}"`, (err) => {
    if (err) console.log('(Could not auto-open browser — use the URL above.)');
  });
});
