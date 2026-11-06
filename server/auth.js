'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
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
 * Sessões no servidor. Só o hash do token vai para o disco, então ler o arquivo
 * não permite se passar por ninguém.
 */
function createSessions(file) {
  const sessions = new Map();

  try {
    for (const [key, value] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) {
      sessions.set(key, value);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Sessões ignoradas:', err.message);
  }

  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)));
    fs.renameSync(tmp, file);
  }

  return {
    ttlMs: SESSION_TTL_MS,

    create(userId) {
      const now = Date.now();
      for (const [key, session] of sessions) {
        if (session.expiresAt <= now) sessions.delete(key);
      }
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(sha256(token), { userId, expiresAt: now + SESSION_TTL_MS });
      persist();
      return token;
    },

    userIdFor(token) {
      if (!token) return null;
      const session = sessions.get(sha256(token));
      if (!session || session.expiresAt <= Date.now()) return null;
      return session.userId;
    },

    destroy(token) {
      if (token && sessions.delete(sha256(token))) persist();
    },
  };
}

/** Limita tentativas de login: as senhas são curtas, então isto é essencial. */
function createLoginLimiter({ max = 5, windowMs = 15 * 60 * 1000 } = {}) {
  const attempts = new Map();

  return {
    /** Segundos até poder tentar de novo; 0 se a tentativa está liberada. */
    retryAfter(key) {
      const entry = attempts.get(key);
      if (!entry) return 0;
      const remaining = entry.resetAt - Date.now();
      if (remaining <= 0) {
        attempts.delete(key);
        return 0;
      }
      return entry.count >= max ? Math.ceil(remaining / 1000) : 0;
    },

    /** Conta antes de verificar a senha, para barrar tentativas em paralelo. */
    hit(key) {
      const entry = attempts.get(key);
      if (entry) entry.count += 1;
      else attempts.set(key, { count: 1, resetAt: Date.now() + windowMs });
    },

    reset(key) {
      attempts.delete(key);
    },
  };
}

module.exports = {
  normalizeUsername,
  hashPassword,
  verifyPassword,
  createSessions,
  createLoginLimiter,
};
