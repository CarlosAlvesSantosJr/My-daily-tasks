'use strict';

const { createDb } = require('./db');

/**
 * Postgres embutido (PGlite), sem servidor. Usado nos testes, em memória, e no
 * modo local sem DATABASE_URL, gravando numa pasta. Só precisa das
 * dependências de desenvolvimento: a Vercel nunca carrega este arquivo.
 */
function createPgliteDb(dataDir) {
  const { PGlite } = require('@electric-sql/pglite');
  const pg = new PGlite(dataDir);
  const db = createDb(
    async (sql, params) => (await pg.query(sql, params)).rows,
    { exec: (sql) => pg.exec(sql) },
  );
  return { ...db, close: () => pg.close() };
}

module.exports = { createPgliteDb };
