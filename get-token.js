// Generates a Google OAuth2 refresh token via a local loopback flow.
// Usage: node get-token.js
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

// Persist the new refresh token into .env (replace existing line or append).
function writeRefreshToken(token) {
  const envPath = path.join(__dirname, '.env');
  let env = fs.readFileSync(envPath, 'utf8');
  if (/^GOOGLE_REFRESH_TOKEN=.*$/m.test(env)) {
    env = env.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, `GOOGLE_REFRESH_TOKEN=${token}`);
  } else {
    env += `\nGOOGLE_REFRESH_TOKEN=${token}\n`;
  }
  fs.writeFileSync(envPath, env);
}

const app = express();

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    res.status(400).send(`Authorization failed: ${error}`);
    console.error('Authorization failed:', error);
    return server.close(() => process.exit(1));
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.send('<h2>✓ Authorized.</h2><p>You can close this tab and return to the terminal.</p>');

    console.log('\n=== TOKENS RECEIVED ===');
    if (tokens.refresh_token) {
      console.log('REFRESH TOKEN:\n' + tokens.refresh_token);
      writeRefreshToken(tokens.refresh_token);
      console.log('\n✓ Written to .env (GOOGLE_REFRESH_TOKEN).');
    } else {
      console.log('⚠ No refresh_token returned. Revoke access at');
      console.log('  https://myaccount.google.com/permissions and run again.');
    }
    console.log('Access token acquired:', Boolean(tokens.access_token));
    console.log('\nNext: node verify-google.js');
  } catch (e) {
    res.status(500).send('Token exchange failed: ' + e.message);
    console.error('Token exchange failed:', e.message);
  } finally {
    server.close(() => process.exit(0));
  }
});

const server = app.listen(PORT, () => {
  console.log(`Listening on ${REDIRECT_URI}`);
  console.log('\nOpening browser for consent. If it does not open, paste this URL:\n');
  console.log(authUrl + '\n');
  // macOS: open the default browser.
  exec(`open "${authUrl}"`, (err) => {
    if (err) console.log('(Could not auto-open browser — use the URL above.)');
  });
});
