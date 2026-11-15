'use strict';

// Modo local: `npm start`. Com DATABASE_URL usa o Neon; sem ela, um Postgres
// embutido gravado em data/, para desenvolver sem tocar no banco de produção.

const os = require('node:os');
const path = require('node:path');

const { createApp } = require('./app');
const { createNeonDb } = require('./db');

const PORT = Number(process.env.PORT) || 3000;

function localDb() {
  if (process.env.DATABASE_URL) return createNeonDb();
  const { createPgliteDb } = require('./pglite');
  return createPgliteDb(process.env.DATA_DIR || path.join(__dirname, '..', 'data', 'pglite'));
}

createApp({ db: localDb() }).listen(PORT, () => {
  console.log(`Daily Tasks no ar: http://localhost:${PORT}`);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const { family, internal, address } of addresses) {
      if (family === 'IPv4' && !internal) {
        console.log(`No celular (mesmo Wi-Fi): http://${address}:${PORT}`);
      }
    }
  }
});

process.on('SIGTERM', () => process.exit(0));
