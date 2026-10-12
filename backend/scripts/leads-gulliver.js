'use strict';
// Sync manual de Gulliver AI → leads_ia_contacto y leads_citas (lo mismo que
// el cron horario). Sin --desde, cada subcuenta sigue desde su última sync (la
// primera vez, todo el histórico).
//
//   railway run node backend/scripts/leads-gulliver.js
//   railway run node backend/scripts/leads-gulliver.js --location=<id> --desde=2024-01-01
const { syncGulliver } = require('../jobs/leads-gulliver');

const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];

syncGulliver({ locationId: arg('location') || undefined, desde: arg('desde') || undefined })
  .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
  .catch(e => { console.error(e.message); process.exit(1); });
