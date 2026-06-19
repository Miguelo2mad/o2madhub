# Gmail + Drive OAuth2 Setup — Getting a Refresh Token

Goal: obtain a **refresh token** so the app (`googleapis` / `nodemailer`) can send mail
and access Drive on your behalf without re-logging-in each time.

You'll end up with three values for your `.env`:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
```

---

## Step 1 — Create a Google Cloud project

1. Go to <https://console.cloud.google.com/>.
2. Sign in with the Google account that owns the mailbox you want to send from
   (e.g. `o2mktmiguel@gmail.com`).
3. In the top bar, click the **project dropdown** (left of the search box) → **New Project**.
4. Name it `o2madhub` (Location: *No organization* is fine for a personal Gmail).
5. Click **Create**, then make sure the new project is **selected** in the top bar
   before continuing.

---

## Step 2 — Enable the Gmail API and Drive API

1. Left menu (≡) → **APIs & Services → Library**.
2. Search **"Gmail API"** → click it → **Enable**.
3. Go back to the Library, search **"Google Drive API"** → click it → **Enable**.

> Tip: direct links (with your project selected):
> - Gmail: <https://console.cloud.google.com/apis/library/gmail.googleapis.com>
> - Drive: <https://console.cloud.google.com/apis/library/drive.googleapis.com>

---

## Step 3 — Configure the OAuth consent screen

You **must** do this before credentials will work.

1. Left menu → **APIs & Services → OAuth consent screen**
   (newer console calls this **"Google Auth Platform → Branding / Audience"**).
2. **User type: External** → **Create**.
   (Choose *Internal* only if this account is part of a Google Workspace org and you
   want it restricted to that org.)
3. Fill the required fields:
   - **App name:** `o2madhub`
   - **User support email:** your email
   - **Developer contact email:** your email
   - Logo / domains are optional — leave blank → **Save and Continue**.
4. **Scopes** page: you can leave this empty here and add scopes later in the
   Playground. (Optional: click *Add or Remove Scopes* and add `.../auth/gmail.send`
   and `.../auth/drive` so they're documented.) → **Save and Continue**.
5. **Test users** page: click **+ Add Users** and add **your own Gmail address**.
   This is required while the app is in *Testing* status. → **Save and Continue**.
6. **Summary** → **Back to Dashboard**.

> ⚠️ **Important — 7-day refresh-token expiry.**
> While the consent screen's **Publishing status is "Testing"**, refresh tokens
> **expire after 7 days**. For a token that lasts indefinitely, after you confirm
> everything works go to the OAuth consent screen and click **"Publish app"**
> (status → *In production*). For a personal/unverified app using only your own
> account this is fine — you'll see an "unverified app" warning you can bypass via
> *Advanced → Go to o2madhub (unsafe)*. Full Google verification is only needed if
> other people will use the app.

---

## Step 4 — Create OAuth2 credentials (Web application)

1. Left menu → **APIs & Services → Credentials**.
2. **+ Create Credentials → OAuth client ID**.
3. **Application type: Web application** (this type works with the OAuth Playground).
4. **Name:** `o2madhub-oauth`.
5. Under **Authorized redirect URIs**, click **+ Add URI** and paste **exactly**:
   ```
   https://developers.google.com/oauthplayground
   ```
   (No trailing slash. This must match exactly or you'll get `redirect_uri_mismatch`.)
6. **Create**. A dialog shows your **Client ID** and **Client secret** —
   copy both (you can also download the JSON). Keep these secret.

---

## Step 5 — Get the refresh token via OAuth Playground

1. Open <https://developers.google.com/oauthplayground/>.
2. Click the **gear icon (⚙️)** in the top-right → check
   **"Use your own OAuth credentials"**.
3. Paste your **Client ID** and **Client secret** from Step 4 → close the panel.
4. In the left **"Step 1 — Select & authorize APIs"** box, paste these scopes into
   the **"Input your own scopes"** field (space- or line-separated):
   ```
   https://mail.google.com/
   https://www.googleapis.com/auth/drive
   ```
   - `https://mail.google.com/` = full Gmail access (needed for nodemailer SMTP/IMAP
     OAuth2). If you only need to *send*, you can use
     `https://www.googleapis.com/auth/gmail.send` instead.
   - `https://www.googleapis.com/auth/drive` = full Drive access (use
     `.../auth/drive.file` for app-created files only, a safer scope).
5. Click **Authorize APIs** → choose your Google account → on the "unverified app"
   screen click **Advanced → Go to o2madhub (unsafe)** → **Continue / Allow** the scopes.
6. You're returned to the Playground at **"Step 2 — Exchange authorization code for
   tokens"**. Click **Exchange authorization code for tokens**.
7. The response panel now shows a **Refresh token** (and an Access token).
   **Copy the refresh token** — that's the long-lived value you need.

> If the **Refresh token** field is empty: in the gear menu confirm
> *Access type = Offline*, then revoke prior access at
> <https://myaccount.google.com/permissions> and redo Step 5. Google only returns a
> refresh token on the **first** consent unless you force re-consent.

---

## Step 6 — Save the values

Add to your local `.env` (already gitignored, so it won't be pushed):

```
GOOGLE_CLIENT_ID=<from Step 4>
GOOGLE_CLIENT_SECRET=<from Step 4>
GOOGLE_REFRESH_TOKEN=<from Step 5>
```

### Quick verification snippet (optional)

```js
// node verify-google.js
const { google } = require('googleapis');
require('dotenv').config();

const oauth2 = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground'
);
oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

(async () => {
  const { token } = await oauth2.getAccessToken();   // proves the refresh token works
  console.log('Access token acquired:', !!token);
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  const me = await gmail.users.getProfile({ userId: 'me' });
  console.log('Gmail account:', me.data.emailAddress);
})().catch(e => console.error('FAILED:', e.message));
```

---

## Common errors

| Symptom | Cause / fix |
|---|---|
| `redirect_uri_mismatch` | The redirect URI in Step 4 must be **exactly** `https://developers.google.com/oauthplayground` (no slash). |
| Refresh token field empty | Not first consent. Revoke at <https://myaccount.google.com/permissions> and retry; ensure *Offline* access. |
| `invalid_grant` after ~7 days | App still in **Testing** → publish to **Production** (Step 3 warning), then regenerate the token. |
| `access_denied` / 403 on send | Scope too narrow. Use `https://mail.google.com/` for nodemailer, or `gmail.send` for send-only. |
| `Gmail API has not been used` | The API isn't enabled on the **selected** project (Step 2). |
