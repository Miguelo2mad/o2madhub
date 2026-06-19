// One-time setup: create the "O2MAD Facturas" root folder in Google Drive
// and persist its ID to .env as DRIVE_ROOT_FOLDER_ID.
// Usage: node setup-drive.js
const fs = require('fs');
const path = require('path');
const g = require('./backend/lib/google');
require('dotenv').config();

const ROOT_NAME = 'O2MAD Facturas';

function writeEnv(key, value) {
  const envPath = path.join(__dirname, '.env');
  let env = fs.readFileSync(envPath, 'utf8');
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(env)) env = env.replace(re, line);
  else env += (env.endsWith('\n') ? '' : '\n') + line + '\n';
  fs.writeFileSync(envPath, env);
}

(async () => {
  // ensureFolder finds the folder if it already exists (idempotent), else creates it in My Drive root.
  const id = await g.ensureFolder(ROOT_NAME, 'root');
  console.log(`Folder "${ROOT_NAME}" id: ${id}`);
  writeEnv('DRIVE_ROOT_FOLDER_ID', id);
  console.log('✓ Written to .env (DRIVE_ROOT_FOLDER_ID).');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
