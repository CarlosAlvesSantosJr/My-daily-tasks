'use strict';

// Banco Postgres (Neon em produção). Todo acesso passa por `query(sql, params)`,
// que devolve as linhas; os testes trocam o Neon por um Postgres em memória.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  salt       text NOT NULL,
  hash       text NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS todos (
  id         uuid PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       text NOT NULL,
  done       boolean NOT NULL DEFAULT false,
  due_date   text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS todos_user_idx ON todos (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS market_items (
  id         uuid PRIMARY KEY,
  text       text NOT NULL,
  bought     boolean NOT NULL DEFAULT false,
  added_by   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS market_meta (
  id      int PRIMARY KEY CHECK (id = 1),
  version bigint NOT NULL
);
INSERT INTO market_meta (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint text PRIMARY KEY,
  user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh   text NOT NULL,
  auth     text NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  key      text PRIMARY KEY,
  count    int NOT NULL,
  reset_at bigint NOT NULL
);
`;

/**
 * `run(sql, params)` executa uma instrução e devolve as linhas. O esquema é
 * criado uma vez por instância (idempotente), antes da primeira consulta.
 */
function createDb(run, { exec = null } = {}) {
  let ready = null;

  function ensureSchema() {
    if (!ready) {
      ready = (async () => {
        if (exec) await exec(SCHEMA);
        else {
          for (const statement of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
            await run(statement, []);
          }
        }
      })();
      ready.catch(() => { ready = null; });
    }
    return ready;
  }

  return {
    ensureSchema,
    async query(sql, params = []) {
      await ensureSchema();
      return run(sql, params);
    },
  };
}

/** Neon pelo driver HTTP: cada consulta é um fetch, ideal para funções serverless. */
function createNeonDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('Defina DATABASE_URL com a conexão do Neon.');
  const { neon } = require('@neondatabase/serverless');
  const sql = neon(url);
  return createDb((text, params) => sql.query(text, params));
}

module.exports = { createDb, createNeonDb, SCHEMA };
