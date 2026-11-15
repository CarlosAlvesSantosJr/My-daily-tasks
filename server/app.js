'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const {
  normalizeUsername,
  verifyPassword,
  createSessions,
  createLoginLimiter,
  createUsers,
} = require('./auth');
const { createPush } = require('./push');
const { createMarketStore, createTodoStore, toUpperText } = require('./store');
const { createWeather } = require('./weather');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 10 * 1024;
const MAX_TEXT_LENGTH = 500;
const COOKIE_NAME = 'sid';

// Lista fixa de arquivos: nenhum caminho vindo da URL chega ao disco.
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/bg.jpg': ['bg.jpg', 'image/jpeg'],
  '/icons/icon-192.png': ['icons/icon-192.png', 'image/png'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png'],
  '/icons/maskable-512.png': ['icons/maskable-512.png', 'image/png'],
  '/icons/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png'],
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// Usuário inexistente gasta o mesmo tempo que senha errada.
const DECOY = { salt: '00'.repeat(16), hash: '00'.repeat(64) };

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readJson(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'Envie os dados como JSON.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Dados grandes demais.');
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'JSON inválido.');
  }
  return body;
}

function parseText(value, emptyMessage = 'Escreva a tarefa.') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new HttpError(400, emptyMessage);
  if (text.length > MAX_TEXT_LENGTH) {
    throw new HttpError(400, `O texto pode ter até ${MAX_TEXT_LENGTH} caracteres.`);
  }
  return text;
}

/** Data da tarefa como "AAAA-MM-DD", sem fuso; vazio significa "sem data". */
function parseDueDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [year, month, day] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() === month - 1 && date.getUTCDate() === day) return value;
  }
  throw new HttpError(400, 'Data inválida.');
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index !== -1 && part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return null;
}

function sessionCookie(req, value, maxAgeSeconds) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

/**
 * Monta o tratador de pedidos. O mesmo código roda como função serverless na
 * Vercel (api/index.js) e como servidor Node local (server/index.js).
 *
 * `trustProxy` só pode ser ligado atrás de um proxy que sobrescreve o
 * cabeçalho `x-real-ip` (a Vercel faz isso); fora dele, qualquer um o forjaria.
 */
function createHandler({ db, trustProxy = false, pushOptions, weatherOptions }) {
  const users = createUsers(db);
  const sessions = createSessions(db);
  const limiter = createLoginLimiter(db, { name: 'ip' });
  // Limite por conta: quem troca de IP a cada tentativa não escapa dele.
  const accountLimiter = createLoginLimiter(db, {
    name: 'conta', max: 20, windowMs: 60 * 60 * 1000,
  });
  const todos = createTodoStore(db);
  const market = createMarketStore(db);
  const push = createPush(db, pushOptions);
  const weather = createWeather(weatherOptions);

  function clientIp(req) {
    return (trustProxy && req.headers['x-real-ip']) || req.socket.remoteAddress || '';
  }

  async function requireUser(req) {
    const userId = await sessions.userIdFor(readCookie(req, COOKIE_NAME));
    const user = userId && await users.get(userId);
    if (!user) throw new HttpError(401, 'Faça login para continuar.');
    return user;
  }

  async function login(req, res) {
    const { username, password } = await readJson(req);
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new HttpError(400, 'Informe usuário e senha.');
    }

    const user = await users.get(normalizeUsername(username));
    const key = `${clientIp(req)}|${user ? user.id : '?'}`;
    const wait = Math.max(
      await limiter.retryAfter(key),
      user ? await accountLimiter.retryAfter(user.id) : 0,
    );
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60);
      throw new HttpError(
        429,
        `Muitas tentativas. Tente de novo em ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}.`,
        { 'Retry-After': String(wait) },
      );
    }
    await limiter.hit(key);
    if (user) await accountLimiter.hit(user.id);

    const valid = await verifyPassword(password, user || DECOY);
    if (!user || !valid) throw new HttpError(401, 'Usuário ou senha incorretos.');

    await limiter.reset(key);
    await accountLimiter.reset(user.id);
    const token = await sessions.create(user.id);
    sendJson(res, 200, { name: user.name }, {
      'Set-Cookie': sessionCookie(req, token, sessions.ttlMs / 1000),
    });
  }

  async function logout(req, res) {
    await sessions.destroy(readCookie(req, COOKIE_NAME));
    sendJson(res, 204, undefined, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  async function updateTodo(req, res, userId, id) {
    const body = await readJson(req);
    const changes = {};
    if ('text' in body) changes.text = parseText(body.text);
    if ('dueDate' in body) changes.dueDate = parseDueDate(body.dueDate);
    if ('done' in body) {
      if (typeof body.done !== 'boolean') throw new HttpError(400, 'Valor inválido.');
      changes.done = body.done;
    }
    const todo = await todos.update(userId, id, changes);
    if (!todo) throw new HttpError(404, 'Tarefa não encontrada.');
    sendJson(res, 200, todo);
  }

  function sendMarket(res, status, state) {
    if (!state) throw new HttpError(404, 'Item não encontrado.');
    sendJson(res, status, state);
  }

  /**
   * A notificação sai antes da resposta: numa função serverless, o que roda
   * depois da resposta pode ser congelado no meio.
   */
  async function addMarketItem(req, res, user) {
    const { text: rawText } = await readJson(req);
    const text = toUpperText(parseText(rawText, 'Escreva o item.'));
    const state = await market.add(text, user.name);
    await push.notifyOthers(user.id, {
      title: 'Lista de mercado',
      body: `${user.name} adicionou ${text}`,
    });
    sendMarket(res, 201, state);
  }

  async function updateMarketItem(req, res, id) {
    const { bought } = await readJson(req);
    if (typeof bought !== 'boolean') throw new HttpError(400, 'Valor inválido.');
    sendMarket(res, 200, await market.setBought(id, bought));
  }

  async function subscribePush(req, res, user) {
    const subscription = await readJson(req);
    if (!push.isValidSubscription(subscription)) {
      throw new HttpError(400, 'Inscrição de notificação inválida.');
    }
    await push.subscribe(user.id, subscription);
    sendJson(res, 204);
  }

  async function unsubscribePush(req, res, user) {
    const { endpoint } = await readJson(req);
    await push.unsubscribe(user.id, endpoint);
    sendJson(res, 204);
  }

  /** Com `lat` e `lon` usa o GPS do aparelho; sem eles, o local aproximado pelo IP. */
  async function sendWeather(req, res, searchParams) {
    const hasLat = searchParams.has('lat');
    if (hasLat !== searchParams.has('lon')) throw new HttpError(400, 'Informe latitude e longitude.');
    let report;
    try {
      if (hasLat) {
        const lat = Number.parseFloat(searchParams.get('lat'));
        const lon = Number.parseFloat(searchParams.get('lon'));
        if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) {
          throw new HttpError(400, 'Coordenadas inválidas.');
        }
        report = await weather.forCoordinates(lat, lon);
      } else {
        report = await weather.forIp(clientIp(req).replace(/^::ffff:/, ''));
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      console.warn('Previsão do tempo:', err.message);
      throw new HttpError(502, 'Previsão do tempo indisponível agora.');
    }
    sendJson(res, 200, report);
  }

  async function handleApi(req, res, pathname, searchParams) {
    const route = `${req.method} ${pathname}`;

    if (route === 'POST /api/login') return login(req, res);
    if (route === 'POST /api/logout') return logout(req, res);

    const user = await requireUser(req);

    if (route === 'GET /api/me') return sendJson(res, 200, { name: user.name });
    if (route === 'GET /api/weather') return sendWeather(req, res, searchParams);

    if (route === 'GET /api/todos') return sendJson(res, 200, await todos.list(user.id));
    if (route === 'POST /api/todos') {
      const { text, dueDate } = await readJson(req);
      return sendJson(res, 201, await todos.add(user.id, parseText(text), parseDueDate(dueDate)));
    }
    if (route === 'POST /api/todos/clear-done') {
      return sendJson(res, 200, await todos.clearDone(user.id));
    }

    if (route === 'GET /api/market') return sendJson(res, 200, await market.read());
    if (route === 'POST /api/market') return addMarketItem(req, res, user);
    if (route === 'POST /api/market/clear-bought') {
      return sendMarket(res, 200, await market.clearBought());
    }

    if (route === 'GET /api/push/key') return sendJson(res, 200, { key: await push.publicKey() });
    if (route === 'POST /api/push/subscribe') return subscribePush(req, res, user);
    if (route === 'POST /api/push/unsubscribe') return unsubscribePush(req, res, user);

    const todoMatch = pathname.match(/^\/api\/todos\/([\w-]+)$/);
    if (todoMatch && req.method === 'PATCH') {
      return updateTodo(req, res, user.id, todoMatch[1]);
    }
    if (todoMatch && req.method === 'DELETE') {
      if (!await todos.remove(user.id, todoMatch[1])) {
        throw new HttpError(404, 'Tarefa não encontrada.');
      }
      return sendJson(res, 204);
    }

    const marketMatch = pathname.match(/^\/api\/market\/([\w-]+)$/);
    if (marketMatch && req.method === 'PATCH') {
      return updateMarketItem(req, res, marketMatch[1]);
    }
    if (marketMatch && req.method === 'DELETE') {
      return sendMarket(res, 200, await market.remove(marketMatch[1]));
    }

    throw new HttpError(404, 'Não encontrado.');
  }

  /** Na Vercel os arquivos de public/ saem direto da CDN; isto serve o modo local. */
  function serveStatic(req, res, pathname) {
    const entry = STATIC_FILES[pathname];
    if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Não encontrado');
      return;
    }
    const [file, contentType] = entry;
    const content = fs.readFileSync(path.join(PUBLIC_DIR, file));
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : content);
  }

  return async function handler(req, res) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(name, value);
    }
    try {
      const { pathname, searchParams } = new URL(req.url, 'http://localhost');
      if (pathname === '/healthz' || pathname === '/api/healthz') sendJson(res, 200, { ok: true });
      else if (pathname.startsWith('/api/')) await handleApi(req, res, pathname, searchParams);
      else serveStatic(req, res, pathname);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message }, err.headers);
      } else if (err.code === 'ERR_INVALID_URL') {
        sendJson(res, 400, { error: 'Endereço inválido.' });
      } else {
        console.error(err);
        if (res.headersSent) res.end();
        else sendJson(res, 500, { error: 'Erro no servidor. Tente de novo.' });
      }
    }
  };
}

/** Servidor Node com o mesmo tratador: usado no modo local e nos testes. */
function createApp(options) {
  return http.createServer(createHandler(options));
}

module.exports = { createApp, createHandler };
