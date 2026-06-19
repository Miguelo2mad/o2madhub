// Verifies the Google OAuth2 refresh token works for Gmail + Drive.
// Usage: node verify-google.js
// Prereqs: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN set in .env
//          (see docs/gmail-oauth2-setup.md)

const { google } = require('googleapis');
require('dotenv').config();

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
  console.error('Missing one of GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN in .env');
  console.error('Follow docs/gmail-oauth2-setup.md to obtain them.');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground'
);
oauth2.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });

(async () => {
  // 1. Exchange the refresh token for an access token — proves the token is valid.
  const { token } = await oauth2.getAccessToken();
  console.log('✓ Access token acquired:', Boolean(token));

  // 2. Gmail: read the authorized account's profile.
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  console.log('✓ Gmail account:', profile.data.emailAddress,
    `(${profile.data.messagesTotal} messages)`);

  // 3. Drive: confirm Drive scope by listing a single file.
  try {
    const drive = google.drive({ version: 'v3', auth: oauth2 });
    const files = await drive.files.list({ pageSize: 1, fields: 'files(id,name)' });
    const f = files.data.files?.[0];
    console.log('✓ Drive access OK', f ? `(sample file: "${f.name}")` : '(no files yet)');
  } catch (e) {
    console.log('⚠ Drive check failed (token may lack the Drive scope):', e.message);
  }

  console.log('\nAll good — the refresh token works.');
})().catch(e => {
  console.error('FAILED:', e.message);
  if (/invalid_grant/.test(e.message)) {
    console.error('Hint: refresh token expired/revoked. If the consent screen is still in');
    console.error('"Testing", tokens expire after 7 days — publish the app and regenerate.');
  }
  process.exit(1);
});
