'use strict';

// Cria um usuário ou troca a senha, direto no banco.
//
//   Produção (Neon):  node --env-file=.env.local scripts/set-password.js <nome> <senha>
//   Local (PGlite):   node scripts/set-password.js <nome> <senha>
//
// O .env.local vem de `vercel env pull` e não vai para o Git.

const path = require('node:path');

const { hashPassword, normalizeUsername, createUsers } = require('../server/auth');
const { createNeonDb } = require('../server/db');

async function main() {
  const [name, password] = process.argv.slice(2);
  if (!name || !password) {
    console.error('Uso: node scripts/set-password.js <nome> <senha>');
    process.exit(1);
  }

  let db;
  if (process.env.DATABASE_URL) db = createNeonDb();
  else {
    const { createPgliteDb } = require('../server/pglite');
    db = createPgliteDb(process.env.DATA_DIR || path.join(__dirname, '..', 'data', 'pglite'));
  }

  await createUsers(db).save({ id: normalizeUsername(name), name, ...(await hashPassword(password)) });
  console.log(`Senha de ${name} salva ${process.env.DATABASE_URL ? 'no Neon' : 'no banco local'}.`);
  if (db.close) await db.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
