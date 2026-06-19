# o2madhub

Automated invoice (factura) pipeline for O2MAD. A daily agent reads new invoices
from Gmail, extracts the key fields with Claude, stores them in Supabase, files the
PDF in Google Drive, and emails a summary.

## Pipeline

```
cron 08:00 Europe/Madrid
  → read Gmail (last 24h)                     backend/lib/google.js
  → extract fields with Claude (structured)   backend/lib/claude.js
  → guards: protect alerts + dedup            backend/agents/factura-agent.js
  → save to Supabase (facturas)               backend/lib/supabase.js
  → upload PDF to Google Drive
  → email daily summary                       backend/api/notifications.js
```

## Requirements

- Node.js 18+
- A Supabase project with a `facturas` table (unique constraint on `referencia`;
  columns include `drive_url`, `drive_folder`)
- Google OAuth2 credentials with Gmail + Drive scopes (see
  [`docs/gmail-oauth2-setup.md`](docs/gmail-oauth2-setup.md))
- An Anthropic API key

## Setup

```bash
npm install
cp .env.example .env          # then fill in the values below
node setup-drive.js           # creates the Drive root folder, writes DRIVE_ROOT_FOLDER_ID
node verify-google.js         # confirms the Google refresh token works
```

> ⚠️ **Publish the Google OAuth consent screen** (Cloud Console → OAuth consent
> screen → *Publish app*). While it is in "Testing", the refresh token expires
> after 7 days and the agent stops working.

## Environment variables (`.env`)

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Anon key (not used server-side, kept for reference) |
| `SUPABASE_SERVICE_KEY` | Service role key — used by the agent (full DB access) |
| `GOOGLE_CLIENT_ID` | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth2 client secret |
| `GOOGLE_REFRESH_TOKEN` | OAuth2 refresh token (from `get-token.js`) |
| `GMAIL_USER` | Mailbox the agent reads / sends from (e.g. `o2mktmiguel@gmail.com`) |
| `ANTHROPIC_API_KEY` | Claude API key (`console.anthropic.com`) |
| `NOTIFY_TO` | Comma-separated summary recipients (e.g. `sandra@o2mad.com,pedro@agesbal.com`) |
| `NOTIFY_CC` | Comma-separated CC (e.g. `info@o2mad.com`) |
| `FACTURA_QUERY` | Gmail search for new invoices (default: `newer_than:1d (factura OR invoice OR recibo OR receipt OR fra)`) |
| `DRIVE_ROOT_FOLDER_ID` | Drive folder id for the invoice tree (set by `setup-drive.js`) |
| `PORT` | HTTP port for the server (default `8080`) |

> `.env` is gitignored — never commit it. It holds the service role key and the
> Anthropic key.

## Running

### Server + daily cron
```bash
node index.js
```
Starts the Express server on `:8080` and schedules the agent daily at **08:00
Europe/Madrid**. Each run processes invoices and emails the summary.

### Trigger a run manually
```bash
# Option A — via the running server
curl -X POST http://localhost:8080/run

# Option B — run the agent directly (no server needed)
node backend/agents/factura-agent.js
```

`GET /health` returns a liveness check.

## Drive folder structure

PDFs are filed under the root folder (`DRIVE_ROOT_FOLDER_ID`) as:

```
O2MAD Facturas/
  └── <Year>/            e.g. 2026
        └── <Sociedad>/  Gulliver AI · Apper Street · O2DOSMAD Design · SalesPro · General / Holding
              └── <Month>/   Enero … Diciembre
                    └── <referencia> - <filename>.pdf
```

Sociedad codes → names live in `backend/lib/claude.js` (`SOCIEDADES`):
`g`=Gulliver AI, `a`=Apper Street, `d`=O2DOSMAD Design, `s`=SalesPro, `x`=General / Holding.

## Behaviour notes

- **Idempotent on `referencia`** — re-running upserts rather than duplicating rows.
- **Alerts protected** — rows already in `estado` `alerta`/`pendiente` are never
  overwritten by the agent.
- **Dedup** — an invoice with the same `proveedor` + `importe` within ±7 days is
  skipped as a duplicate.
- **Extraction gate** — Claude only flags genuine business invoices (excludes food
  delivery, personal expenses, PayPal notifications; requires an invoice number).

## Scripts

| File | Purpose |
|---|---|
| `index.js` | Server + cron entrypoint |
| `setup-drive.js` | Create the Drive root folder, write `DRIVE_ROOT_FOLDER_ID` |
| `get-token.js` | Obtain a Google OAuth2 refresh token (local loopback flow) |
| `verify-google.js` | Verify the refresh token works (Gmail + Drive) |
| `backend/agents/factura-agent.js` | The daily invoice agent |
| `backend/api/notifications.js` | Daily email summary |
| `database/seeds/seed.js` | Seed the `facturas` table |
