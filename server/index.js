'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const USERS_FILE = process.env.USERS_FILE || path.join(__dirname, 'users.json');
const TRUST_PROXY = process.env.TRUST_PROXY === 'cloudflare';

const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));

createApp({ users, dataDir: DATA_DIR, trustProxy: TRUST_PROXY }).listen(PORT, () => {
  console.log(`To Do List no ar: http://localhost:${PORT}`);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const { family, internal, address } of addresses) {
      if (family === 'IPv4' && !internal) {
        console.log(`No celular (mesmo Wi-Fi): http://${address}:${PORT}`);
      }
    }
  }
});

// Toda escrita é síncrona, então não há nada pendente para esperar ao encerrar.
process.on('SIGTERM', () => process.exit(0));
