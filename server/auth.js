'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** "Mônica " -> "monica": login não diferencia maiúsculas nem acentos. */
function normalizeUsername(value) {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

async function verifyPassword(password, { salt, hash }) {
  const expected = Buffer.from(hash, 'hex');
  const actual = await scrypt(password, Buffer.from(salt, 'hex'), KEY_LENGTH);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Sessões no banco. Só o hash do token é gravado, então ler a tabela não
 * permite se passar por ninguém.
 */
function createSessions(db) {
  return {
    ttlMs: SESSION_TTL_MS,

    async create(userId) {
      const now = Date.now();
      const token = crypto.randomBytes(32).toString('base64url');
      await db.query('DELETE FROM sessions WHERE expires_at <= $1', [now]);
      await db.query(
        'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
        [sha256(token), userId, now + SESSION_TTL_MS],
      );
      return token;
    },

    async userIdFor(token) {
      if (!token) return null;
      const [row] = await db.query(
        'SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > $2',
        [sha256(token), Date.now()],
      );
      return row ? row.user_id : null;
    },

    async destroy(token) {
      if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
    },
  };
}

/**
 * Limita tentativas de login. Fica no banco porque cada pedido pode cair numa
 * instância diferente da função serverless: contar em memória não bastaria.
 */
function createLoginLimiter(db, { name, max = 5, windowMs = 15 * 60 * 1000 }) {
  const keyFor = (key) => `${name}:${key}`;

  return {
    /** Segundos até poder tentar de novo; 0 se a tentativa está liberada. */
    async retryAfter(key) {
      const [row] = await db.query(
        'SELECT count, reset_at FROM login_attempts WHERE key = $1',
        [keyFor(key)],
      );
      if (!row) return 0;
      const remaining = Number(row.reset_at) - Date.now();
      if (remaining <= 0) return 0;
      return row.count >= max ? Math.ceil(remaining / 1000) : 0;
    },

    /** Conta antes de verificar a senha, para barrar tentativas em paralelo. */
    async hit(key) {
      const now = Date.now();
      await db.query(
        `INSERT INTO login_attempts (key, count, reset_at) VALUES ($1, 1, $3)
         ON CONFLICT (key) DO UPDATE SET
           count    = CASE WHEN login_attempts.reset_at <= $2 THEN 1 ELSE login_attempts.count + 1 END,
           reset_at = CASE WHEN login_attempts.reset_at <= $2 THEN $3 ELSE login_attempts.reset_at END`,
        [keyFor(key), now, now + windowMs],
      );
    },

    async reset(key) {
      await db.query('DELETE FROM login_attempts WHERE key = $1', [keyFor(key)]);
    },
  };
}

/** Usuários cadastrados (só nome e hash da senha). */
function createUsers(db) {
  return {
    async get(id) {
      const [row] = await db.query('SELECT id, name, salt, hash FROM users WHERE id = $1', [id]);
      return row || null;
    },

    /** Cria o usuário ou troca a senha. */
    async save({ id, name, salt, hash }) {
      await db.query(
        `INSERT INTO users (id, name, salt, hash) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET name = $2, salt = $3, hash = $4`,
        [id, name, salt, hash],
      );
    },
  };
}

module.exports = {
  normalizeUsername,
  hashPassword,
  verifyPassword,
  createSessions,
  createLoginLimiter,
  createUsers,
};
