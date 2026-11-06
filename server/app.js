'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { WebSocket, WebSocketServer } = require('ws');

const {
  normalizeUsername,
  verifyPassword,
  createSessions,
  createLoginLimiter,
} = require('./auth');
const { createPush } = require('./push');
const { createMarketStore, createTodoStore } = require('./store');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 10 * 1024;
const MAX_TEXT_LENGTH = 500;
const COOKIE_NAME = 'sid';
const LIVE_PATH = '/api/market/live';
// Abaixo do tempo em que proxies e túneis derrubam conexões paradas.
const HEARTBEAT_MS = 30 * 1000;

// Lista fixa de arquivos: nenhum caminho vindo da URL chega ao disco.
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
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

/** Rejeita páginas de outros sites tentando abrir o WebSocket com o cookie. */
function isSameOrigin(req) {
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * `trustProxy` só pode ser ligado quando o app é acessível apenas pelo túnel
 * da Cloudflare; fora disso, qualquer um poderia forjar este cabeçalho.
 */
function createApp({ users, dataDir, trustProxy = false, pushOptions }) {
  const usersById = new Map(users.map((user) => [user.id, user]));
  const sessions = createSessions(path.join(dataDir, 'sessions.json'));
  const limiter = createLoginLimiter();
  // Limite por conta: quem troca de IP a cada tentativa não escapa dele.
  const accountLimiter = createLoginLimiter({ max: 20, windowMs: 60 * 60 * 1000 });
  const todos = createTodoStore(dataDir);
  const market = createMarketStore(dataDir);
  const push = createPush(dataDir, pushOptions);
  const live = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  // Usuário inexistente gasta o mesmo tempo que senha errada.
  const decoy = users[0];

  function clientIp(req) {
    return (trustProxy && req.headers['cf-connecting-ip']) || req.socket.remoteAddress;
  }

  function currentUser(req) {
    return usersById.get(sessions.userIdFor(readCookie(req, COOKIE_NAME))) || null;
  }

  function requireUser(req) {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'Faça login para continuar.');
    return user;
  }

  function broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of live.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  async function login(req, res) {
    const { username, password } = await readJson(req);
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new HttpError(400, 'Informe usuário e senha.');
    }

    const user = usersById.get(normalizeUsername(username));
    const key = `${clientIp(req)}|${user ? user.id : '?'}`;
    const wait = Math.max(limiter.retryAfter(key), user ? accountLimiter.retryAfter(user.id) : 0);
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60);
      throw new HttpError(
        429,
        `Muitas tentativas. Tente de novo em ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}.`,
        { 'Retry-After': String(wait) },
      );
    }
    limiter.hit(key);
    if (user) accountLimiter.hit(user.id);

    const valid = await verifyPassword(password, user || decoy);
    if (!user || !valid) throw new HttpError(401, 'Usuário ou senha incorretos.');

    limiter.reset(key);
    accountLimiter.reset(user.id);
    const token = sessions.create(user.id);
    sendJson(res, 200, { name: user.name }, {
      'Set-Cookie': sessionCookie(req, token, sessions.ttlMs / 1000),
    });
  }

  function logout(req, res) {
    const token = readCookie(req, COOKIE_NAME);
    sessions.destroy(token);
    for (const client of live.clients) {
      if (client.sessionToken === token) client.close();
    }
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
    const todo = todos.update(userId, id, changes);
    if (!todo) throw new HttpError(404, 'Tarefa não encontrada.');
    sendJson(res, 200, todo);
  }

  /** Responde a quem pediu e atualiza na hora quem está com o app aberto. */
  function sendMarket(res, status, state, event) {
    if (!state) throw new HttpError(404, 'Item não encontrado.');
    broadcast({ ...state, event });
    sendJson(res, status, state);
  }

  async function addMarketItem(req, res, user) {
    const { text: rawText } = await readJson(req);
    const text = parseText(rawText, 'Escreva o item.');
    sendMarket(res, 201, market.add(text, user.name), { by: user.name, text });
    await push.notifyOthers(user.id, {
      title: 'Lista de mercado',
      body: `${user.name} adicionou ${text}`,
    });
  }

  async function updateMarketItem(req, res, id) {
    const { bought } = await readJson(req);
    if (typeof bought !== 'boolean') throw new HttpError(400, 'Valor inválido.');
    sendMarket(res, 200, market.setBought(id, bought));
  }

  async function subscribePush(req, res, user) {
    const subscription = await readJson(req);
    if (!push.isValidSubscription(subscription)) {
      throw new HttpError(400, 'Inscrição de notificação inválida.');
    }
    push.subscribe(user.id, subscription);
    sendJson(res, 204);
  }

  async function unsubscribePush(req, res, user) {
    const { endpoint } = await readJson(req);
    push.unsubscribe(user.id, endpoint);
    sendJson(res, 204);
  }

  async function handleApi(req, res, pathname) {
    const route = `${req.method} ${pathname}`;

    if (route === 'POST /api/login') return login(req, res);
    if (route === 'POST /api/logout') return logout(req, res);

    const user = requireUser(req);

    if (route === 'GET /api/me') return sendJson(res, 200, { name: user.name });

    if (route === 'GET /api/todos') return sendJson(res, 200, todos.list(user.id));
    if (route === 'POST /api/todos') {
      const { text, dueDate } = await readJson(req);
      return sendJson(res, 201, todos.add(user.id, parseText(text), parseDueDate(dueDate)));
    }
    if (route === 'POST /api/todos/clear-done') {
      return sendJson(res, 200, todos.clearDone(user.id));
    }

    if (route === 'GET /api/market') return sendJson(res, 200, market.read());
    if (route === 'POST /api/market') return addMarketItem(req, res, user);
    if (route === 'POST /api/market/clear-bought') {
      return sendMarket(res, 200, market.clearBought());
    }

    if (route === 'GET /api/push/key') return sendJson(res, 200, { key: push.publicKey });
    if (route === 'POST /api/push/subscribe') return subscribePush(req, res, user);
    if (route === 'POST /api/push/unsubscribe') return unsubscribePush(req, res, user);

    const todoMatch = pathname.match(/^\/api\/todos\/([\w-]+)$/);
    if (todoMatch && req.method === 'PATCH') {
      return updateTodo(req, res, user.id, todoMatch[1]);
    }
    if (todoMatch && req.method === 'DELETE') {
      if (!todos.remove(user.id, todoMatch[1])) {
        throw new HttpError(404, 'Tarefa não encontrada.');
      }
      return sendJson(res, 204);
    }

    const marketMatch = pathname.match(/^\/api\/market\/([\w-]+)$/);
    if (marketMatch && req.method === 'PATCH') {
      return updateMarketItem(req, res, marketMatch[1]);
    }
    if (marketMatch && req.method === 'DELETE') {
      return sendMarket(res, 200, market.remove(marketMatch[1]));
    }

    throw new HttpError(404, 'Não encontrado.');
  }

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

  const server = http.createServer(async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(name, value);
    }
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname === '/healthz') sendJson(res, 200, { ok: true });
      else if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
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
  });

  server.on('upgrade', (req, socket, head) => {
    const reject = (status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);

    if (req.url !== LIVE_PATH) return reject('404 Not Found');
    if (!isSameOrigin(req)) return reject('403 Forbidden');
    if (!currentUser(req)) return reject('401 Unauthorized');

    return live.handleUpgrade(req, socket, head, (client) => {
      client.sessionToken = readCookie(req, COOKIE_NAME);
      client.isAlive = true;
      client.on('pong', () => { client.isAlive = true; });
      client.on('error', () => client.terminate());
      client.send(JSON.stringify(market.read()));
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of live.clients) {
      if (!client.isAlive || !sessions.userIdFor(client.sessionToken)) {
        client.terminate();
      } else {
        client.isAlive = false;
        client.ping();
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));

  return server;
}

module.exports = { createApp };
