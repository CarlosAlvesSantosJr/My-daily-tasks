'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, beforeEach, test } = require('node:test');

const { WebSocket } = require('ws');

const { createApp } = require('../server/app');
const { hashPassword } = require('../server/auth');

let server;
let baseUrl;
let dataDir;
const pushed = [];
let pushError = null;
const weatherCalls = [];
let weatherDown = false;

/** Responde como as APIs públicas de clima, sem sair para a internet. */
async function fakeWeatherFetch(url) {
  weatherCalls.push(url);
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  if (weatherDown) return { ok: false, status: 503, json: async () => ({}) };
  const { host } = new URL(url);
  if (host === 'ipwho.is') {
    if (url.includes('127.0.0.1')) return json({ success: false, message: 'Reserved range' });
    return json({ success: true, city: 'Tubarão', latitude: -28.4667, longitude: -49.0069 });
  }
  if (host === 'nominatim.openstreetmap.org') {
    return json({ name: 'Florianópolis', address: { city: 'Florianópolis' } });
  }
  return json({
    current: { temperature_2m: 28.6, weather_code: 2, is_day: 1 },
    daily: {
      temperature_2m_max: [30.2],
      temperature_2m_min: [18.7],
      precipitation_probability_max: [60],
    },
  });
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-test-'));
  const users = [
    { id: 'ana', name: 'Ana', ...(await hashPassword('senha-ana')) },
    { id: 'bia', name: 'Bia', ...(await hashPassword('senha-bia')) },
    { id: 'limite', name: 'Limite', ...(await hashPassword('senha-limite')) },
    { id: 'semtunel', name: 'Sem Túnel', ...(await hashPassword('senha-semtunel')) },
  ];
  const pushOptions = {
    send: async (subscription, payload) => {
      if (pushError) throw pushError;
      pushed.push({ endpoint: subscription.endpoint, message: JSON.parse(payload) });
    },
  };
  server = createApp({ users, dataDir, pushOptions, weatherOptions: { fetch: fakeWeatherFetch } });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => { server.close(resolve); });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  const files = ['todos-ana.json', 'todos-bia.json', 'market.json', 'push-subscriptions.json'];
  for (const name of files) {
    fs.rmSync(path.join(dataDir, name), { force: true });
  }
  pushed.length = 0;
  pushError = null;
  weatherCalls.length = 0;
  weatherDown = false;
});

function request(method, url, { cookie, body } = {}) {
  return fetch(baseUrl + url, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function login(username, password) {
  const response = await request('POST', '/api/login', { body: { username, password } });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

async function addTodo(cookie, text) {
  const response = await request('POST', '/api/todos', { cookie, body: { text } });
  assert.equal(response.status, 201);
  return response.json();
}

/** Abre o tempo real e guarda as mensagens, com `next()` para esperar a próxima. */
function connectLive(cookie, origin = baseUrl) {
  const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/api/market/live`, {
    headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
  });
  const queue = [];
  const waiting = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data);
    if (waiting.length > 0) waiting.shift()(message);
    else queue.push(message);
  });
  socket.next = () => new Promise((resolve) => {
    if (queue.length > 0) resolve(queue.shift());
    else waiting.push(resolve);
  });
  return socket;
}

function upgradeStatus(socket) {
  return new Promise((resolve) => {
    socket.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    socket.on('open', () => resolve('open'));
    socket.on('error', () => {});
  });
}

const subscription = (name) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
  keys: { p256dh: 'chave', auth: 'segredo' },
});

async function subscribe(cookie, name) {
  const response = await request('POST', '/api/push/subscribe', {
    cookie,
    body: subscription(name),
  });
  assert.equal(response.status, 204);
}

async function addItem(cookie, text) {
  const response = await request('POST', '/api/market', { cookie, body: { text } });
  assert.equal(response.status, 201);
  return response.json();
}

test('lista de mercado é a mesma para os dois usuários', async () => {
  const ana = await login('ana', 'senha-ana');
  const bia = await login('bia', 'senha-bia');
  await addItem(ana, 'Leite');
  await addItem(bia, 'Pão');

  const seenByAna = await (await request('GET', '/api/market', { cookie: ana })).json();
  const seenByBia = await (await request('GET', '/api/market', { cookie: bia })).json();
  assert.deepEqual(seenByAna, seenByBia);
  assert.deepEqual(seenByAna.items.map((item) => item.text), ['PÃO', 'LEITE']);
  assert.deepEqual(seenByAna.items.map((item) => item.addedBy), ['Bia', 'Ana']);
});

test('itens de mercado ficam em maiúsculas, inclusive acentos', async () => {
  const cookie = await login('ana', 'senha-ana');
  const { items: [item] } = await addItem(cookie, 'feijão preto');
  assert.equal(item.text, 'FEIJÃO PRETO');
});

test('um usuário marca e apaga item adicionado pelo outro', async () => {
  const ana = await login('ana', 'senha-ana');
  const bia = await login('bia', 'senha-bia');
  const { items: [item] } = await addItem(ana, 'Leite');

  const bought = await request('PATCH', `/api/market/${item.id}`, {
    cookie: bia,
    body: { bought: true },
  });
  assert.equal((await bought.json()).items[0].bought, true);

  const removed = await request('DELETE', `/api/market/${item.id}`, { cookie: bia });
  assert.deepEqual((await removed.json()).items, []);
});

test('apagar comprados mantém os itens que faltam', async () => {
  const cookie = await login('ana', 'senha-ana');
  await addItem(cookie, 'Falta');
  const { items: [item] } = await addItem(cookie, 'Comprado');
  await request('PATCH', `/api/market/${item.id}`, { cookie, body: { bought: true } });

  const response = await request('POST', '/api/market/clear-bought', { cookie });
  assert.deepEqual((await response.json()).items.map((other) => other.text), ['FALTA']);
});

test('item de mercado inválido é recusado', async () => {
  const cookie = await login('ana', 'senha-ana');
  for (const text of ['', '   ', 'x'.repeat(501), 5]) {
    const response = await request('POST', '/api/market', { cookie, body: { text } });
    assert.equal(response.status, 400, JSON.stringify(text));
  }
  const { items: [item] } = await addItem(cookie, 'Leite');
  const bad = await request('PATCH', `/api/market/${item.id}`, {
    cookie,
    body: { bought: 'sim' },
  });
  assert.equal(bad.status, 400);
  const missing = await request('DELETE', '/api/market/nao-existe', { cookie });
  assert.equal(missing.status, 404);
});

test('rotas de mercado e notificação exigem login', async () => {
  const cases = [
    ['GET', '/api/market'],
    ['POST', '/api/market'],
    ['POST', '/api/market/clear-bought'],
    ['PATCH', '/api/market/abc'],
    ['DELETE', '/api/market/abc'],
    ['GET', '/api/push/key'],
    ['POST', '/api/push/subscribe'],
    ['POST', '/api/push/unsubscribe'],
  ];
  for (const [method, url] of cases) {
    const response = await request(method, url);
    assert.equal(response.status, 401, `${method} ${url}`);
  }
});

test('tarefas continuam privadas com a lista de mercado no ar', async () => {
  const ana = await login('ana', 'senha-ana');
  const bia = await login('bia', 'senha-bia');
  await addTodo(ana, 'segredo da Ana');
  const socket = connectLive(bia);
  await socket.next();
  await addItem(ana, 'Leite');

  const message = await socket.next();
  socket.close();
  assert.ok(!JSON.stringify(message).includes('segredo'));
  assert.deepEqual(await (await request('GET', '/api/todos', { cookie: bia })).json(), []);
});

test('item novo chega em tempo real para o outro usuário', async () => {
  const ana = await login('ana', 'senha-ana');
  const bia = await login('bia', 'senha-bia');
  const socket = connectLive(bia);

  const initial = await socket.next();
  assert.deepEqual(initial.items, []);

  await addItem(ana, 'Café');
  const update = await socket.next();
  socket.close();
  assert.deepEqual(update.items.map((item) => item.text), ['CAFÉ']);
  assert.deepEqual(update.event, { by: 'Ana', text: 'CAFÉ' });
  assert.ok(update.version > initial.version);
});

test('quem conecta depois recebe a lista atual', async () => {
  const ana = await login('ana', 'senha-ana');
  await addItem(ana, 'Arroz');
  const socket = connectLive(await login('bia', 'senha-bia'));
  const { items } = await socket.next();
  socket.close();
  assert.deepEqual(items.map((item) => item.text), ['ARROZ']);
});

test('tempo real exige login e a mesma origem', async () => {
  assert.equal(await upgradeStatus(connectLive()), 401);
  assert.equal(await upgradeStatus(connectLive('sid=token-falso')), 401);

  const cookie = await login('ana', 'senha-ana');
  assert.equal(await upgradeStatus(connectLive(cookie, 'https://site-malicioso.example')), 403);
});

test('logout encerra a conexão em tempo real', async () => {
  const cookie = await login('ana', 'senha-ana');
  const socket = connectLive(cookie);
  await socket.next();
  const closed = new Promise((resolve) => { socket.on('close', resolve); });
  await request('POST', '/api/logout', { cookie });
  await closed;
});

test('notificação vai só para o outro usuário', async () => {
  const ana = await login('ana', 'senha-ana');
  const bia = await login('bia', 'senha-bia');
  await subscribe(ana, 'celular-ana');
  await subscribe(bia, 'celular-bia');

  await addItem(ana, 'Ovos');

  assert.deepEqual(pushed, [{
    endpoint: subscription('celular-bia').endpoint,
    message: { title: 'Lista de mercado', body: 'Ana adicionou OVOS' },
  }]);
});

test('marcar como comprado não gera notificação', async () => {
  const ana = await login('ana', 'senha-ana');
  const bia = await login('bia', 'senha-bia');
  const { items: [item] } = await addItem(ana, 'Ovos');
  await subscribe(ana, 'celular-ana');
  await request('PATCH', `/api/market/${item.id}`, { cookie: bia, body: { bought: true } });
  assert.deepEqual(pushed, []);
});

test('aparelho passa para quem entrou por último', async () => {
  const ana = await login('ana', 'senha-ana');
  const bia = await login('bia', 'senha-bia');
  await subscribe(ana, 'celular-da-casa');
  await subscribe(bia, 'celular-da-casa');

  await addItem(bia, 'Sal');
  assert.deepEqual(pushed, []);
  await addItem(ana, 'Açúcar');
  assert.equal(pushed.length, 1);
});

test('usuário só cancela a própria inscrição', async () => {
  const ana = await login('ana', 'senha-ana');
  const bia = await login('bia', 'senha-bia');
  await subscribe(bia, 'celular-bia');

  await request('POST', '/api/push/unsubscribe', {
    cookie: ana,
    body: { endpoint: subscription('celular-bia').endpoint },
  });
  await addItem(ana, 'Sal');
  assert.equal(pushed.length, 1);

  await request('POST', '/api/push/unsubscribe', {
    cookie: bia,
    body: { endpoint: subscription('celular-bia').endpoint },
  });
  await addItem(ana, 'Açúcar');
  assert.equal(pushed.length, 1);
});

test('inscrição cancelada pelo navegador é removida', async () => {
  const ana = await login('ana', 'senha-ana');
  const bia = await login('bia', 'senha-bia');
  await subscribe(bia, 'celular-bia');

  pushError = Object.assign(new Error('Gone'), { statusCode: 410 });
  await addItem(ana, 'Sal');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'push-subscriptions.json'), 'utf8'));
  assert.deepEqual(saved, []);
});

test('falha ao notificar não impede de adicionar o item', async () => {
  const ana = await login('ana', 'senha-ana');
  const bia = await login('bia', 'senha-bia');
  await subscribe(bia, 'celular-bia');

  pushError = Object.assign(new Error('Fora do ar'), { statusCode: 500 });
  const { items } = await addItem(ana, 'Sal');
  assert.equal(items.length, 1);
});

test('notificação só aceita serviços de push conhecidos', async () => {
  const cookie = await login('ana', 'senha-ana');
  const endpoints = [
    'http://fcm.googleapis.com/fcm/send/x',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost:3000/api/login',
    'https://fcm.googleapis.com.site-malicioso.example/x',
    'nao-e-url',
  ];
  for (const endpoint of endpoints) {
    const response = await request('POST', '/api/push/subscribe', {
      cookie,
      body: { endpoint, keys: { p256dh: 'a', auth: 'b' } },
    });
    assert.equal(response.status, 400, endpoint);
  }
});

test('chave pública de notificação fica salva entre reinícios', async () => {
  const cookie = await login('ana', 'senha-ana');
  const { key } = await (await request('GET', '/api/push/key', { cookie })).json();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'vapid.json'), 'utf8'));
  assert.equal(key, saved.publicKey);
});

async function withProxiedApp(callback) {
  const proxyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-proxy-'));
  const users = [{ id: 'ana', name: 'Ana', ...(await hashPassword('senha-ana')) }];
  const proxied = createApp({ users, dataDir: proxyDir, trustProxy: true });
  await new Promise((resolve) => { proxied.listen(0, '127.0.0.1', resolve); });
  const attempt = (ip, password = 'errada') => fetch(
    `http://127.0.0.1:${proxied.address().port}/api/login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cf-Connecting-Ip': ip },
      body: JSON.stringify({ username: 'ana', password }),
    },
  );
  try {
    await callback(attempt);
  } finally {
    await new Promise((resolve) => { proxied.close(resolve); });
    fs.rmSync(proxyDir, { recursive: true, force: true });
  }
}

test('atrás do túnel, o limite de login é por visitante', async () => {
  await withProxiedApp(async (attempt) => {
    for (let i = 0; i < 5; i += 1) await attempt('203.0.113.1');
    assert.equal((await attempt('203.0.113.1')).status, 429);
    assert.equal((await attempt('203.0.113.2', 'senha-ana')).status, 200);
  });
});

test('trocar de IP não escapa do limite por conta', async () => {
  await withProxiedApp(async (attempt) => {
    for (let i = 0; i < 20; i += 1) {
      assert.equal((await attempt(`203.0.113.${i}`)).status, 401);
    }
    assert.equal((await attempt('198.51.100.1', 'senha-ana')).status, 429);
  });
});

test('sem túnel, o cabeçalho de IP é ignorado', async () => {
  const send = (ip) => fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cf-Connecting-Ip': ip },
    body: JSON.stringify({ username: 'semtunel', password: 'x' }),
  });
  for (let i = 0; i < 5; i += 1) await send(`203.0.113.${i}`);
  assert.equal((await send('203.0.113.99')).status, 429);
});

test('cookie é Secure quando o acesso vem por HTTPS', async () => {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ username: 'ana', password: 'senha-ana' }),
  });
  assert.match(response.headers.get('set-cookie'), /; Secure/);
});

test('arquivos do PWA e verificação de saúde são públicos', async () => {
  const expected = {
    '/healthz': 'application/json',
    '/sw.js': 'text/javascript',
    '/manifest.webmanifest': 'application/manifest+json',
    '/icons/icon-192.png': 'image/png',
    '/icons/icon-512.png': 'image/png',
    '/icons/maskable-512.png': 'image/png',
    '/icons/apple-touch-icon.png': 'image/png',
  };
  for (const [url, type] of Object.entries(expected)) {
    const response = await request('GET', url);
    assert.equal(response.status, 200, url);
    assert.ok(response.headers.get('content-type').startsWith(type), url);
  }
});

test('login recusa senha errada e usuário inexistente', async () => {
  const wrong = await request('POST', '/api/login', {
    body: { username: 'ana', password: 'errada' },
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('set-cookie'), null);

  const unknown = await request('POST', '/api/login', {
    body: { username: 'ninguem', password: 'senha-ana' },
  });
  assert.equal(unknown.status, 401);
});

test('a senha de um usuário não entra na conta do outro', async () => {
  const response = await request('POST', '/api/login', {
    body: { username: 'bia', password: 'senha-ana' },
  });
  assert.equal(response.status, 401);
});

test('login aceita maiúsculas e acentos no nome', async () => {
  const cookie = await login(' ÁNA ', 'senha-ana');
  const me = await request('GET', '/api/me', { cookie });
  assert.deepEqual(await me.json(), { name: 'Ana' });
});

test('cookie de sessão é HttpOnly e SameSite=Strict', async () => {
  const response = await request('POST', '/api/login', {
    body: { username: 'ana', password: 'senha-ana' },
  });
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
});

test('rotas de tarefas exigem login', async () => {
  const cases = [
    ['GET', '/api/me'],
    ['GET', '/api/todos'],
    ['POST', '/api/todos'],
    ['POST', '/api/todos/clear-done'],
    ['PATCH', '/api/todos/abc'],
    ['DELETE', '/api/todos/abc'],
  ];
  for (const [method, url] of cases) {
    const response = await request(method, url, { cookie: 'sid=token-falso' });
    assert.equal(response.status, 401, `${method} ${url}`);
  }
});

test('cada usuário vê apenas a própria lista', async () => {
  const ana = await login('ana', 'senha-ana');
  const bia = await login('bia', 'senha-bia');
  await addTodo(ana, 'tarefa da Ana');
  await addTodo(bia, 'tarefa da Bia');

  const anaTodos = await (await request('GET', '/api/todos', { cookie: ana })).json();
  const biaTodos = await (await request('GET', '/api/todos', { cookie: bia })).json();
  assert.deepEqual(anaTodos.map((todo) => todo.text), ['TAREFA DA ANA']);
  assert.deepEqual(biaTodos.map((todo) => todo.text), ['TAREFA DA BIA']);
});

test('um usuário não altera nem apaga tarefa do outro usando o id', async () => {
  const ana = await login('ana', 'senha-ana');
  const bia = await login('bia', 'senha-bia');
  const todo = await addTodo(ana, 'só da Ana');

  const patch = await request('PATCH', `/api/todos/${todo.id}`, {
    cookie: bia,
    body: { text: 'invadido', done: true },
  });
  assert.equal(patch.status, 404);

  const remove = await request('DELETE', `/api/todos/${todo.id}`, { cookie: bia });
  assert.equal(remove.status, 404);

  const anaTodos = await (await request('GET', '/api/todos', { cookie: ana })).json();
  assert.deepEqual(anaTodos, [todo]);
});

test('o cliente não escolhe de quem é a lista', async () => {
  const ana = await login('ana', 'senha-ana');
  const bia = await login('bia', 'senha-bia');
  await addTodo(ana, 'só da Ana');

  const query = await request('GET', '/api/todos?userId=ana', { cookie: bia });
  assert.deepEqual(await query.json(), []);

  const created = await request('POST', '/api/todos', {
    cookie: bia,
    body: { text: 'da Bia', userId: 'ana' },
  });
  assert.equal(created.status, 201);
  const anaTodos = await (await request('GET', '/api/todos', { cookie: ana })).json();
  assert.equal(anaTodos.length, 1);
});

test('apagar concluídas só afeta a própria lista', async () => {
  const ana = await login('ana', 'senha-ana');
  const bia = await login('bia', 'senha-bia');
  const anaTodo = await addTodo(ana, 'feita da Ana');
  await request('PATCH', `/api/todos/${anaTodo.id}`, { cookie: ana, body: { done: true } });
  const biaTodo = await addTodo(bia, 'feita da Bia');
  await request('PATCH', `/api/todos/${biaTodo.id}`, { cookie: bia, body: { done: true } });

  await request('POST', '/api/todos/clear-done', { cookie: bia });

  const anaTodos = await (await request('GET', '/api/todos', { cookie: ana })).json();
  assert.equal(anaTodos.length, 1);
});

test('criar, editar, concluir e apagar tarefa', async () => {
  const cookie = await login('ana', 'senha-ana');
  const todo = await addTodo(cookie, '  comprar pão  ');
  assert.equal(todo.text, 'COMPRAR PÃO');
  assert.equal(todo.done, false);

  const edited = await request('PATCH', `/api/todos/${todo.id}`, {
    cookie,
    body: { text: 'comprar leite', done: true },
  });
  const updated = await edited.json();
  assert.equal(updated.text, 'COMPRAR LEITE');
  assert.equal(updated.done, true);

  const removed = await request('DELETE', `/api/todos/${todo.id}`, { cookie });
  assert.equal(removed.status, 204);
  assert.deepEqual(await (await request('GET', '/api/todos', { cookie })).json(), []);
});

test('tarefa inválida é recusada', async () => {
  const cookie = await login('ana', 'senha-ana');
  for (const text of ['', '   ', 'x'.repeat(501), 123, null]) {
    const response = await request('POST', '/api/todos', { cookie, body: { text } });
    assert.equal(response.status, 400, JSON.stringify(text));
  }
  const todo = await addTodo(cookie, 'ok');
  const badDone = await request('PATCH', `/api/todos/${todo.id}`, {
    cookie,
    body: { done: 'sim' },
  });
  assert.equal(badDone.status, 400);
});

test('tarefa pode ser criada, reagendada e ficar sem data', async () => {
  const cookie = await login('ana', 'senha-ana');
  assert.equal((await addTodo(cookie, 'sem data')).dueDate, null);

  const created = await request('POST', '/api/todos', {
    cookie,
    body: { text: 'com data', dueDate: '2026-02-28' },
  });
  const todo = await created.json();
  assert.equal(todo.dueDate, '2026-02-28');

  const moved = await request('PATCH', `/api/todos/${todo.id}`, {
    cookie,
    body: { dueDate: '2028-02-29' },
  });
  assert.equal((await moved.json()).dueDate, '2028-02-29');

  const cleared = await request('PATCH', `/api/todos/${todo.id}`, {
    cookie,
    body: { dueDate: null },
  });
  assert.equal((await cleared.json()).dueDate, null);
});

test('concluir tarefa não apaga a data', async () => {
  const cookie = await login('ana', 'senha-ana');
  const created = await request('POST', '/api/todos', {
    cookie,
    body: { text: 'com data', dueDate: '2026-12-25' },
  });
  const todo = await created.json();
  const done = await request('PATCH', `/api/todos/${todo.id}`, {
    cookie,
    body: { done: true },
  });
  assert.equal((await done.json()).dueDate, '2026-12-25');
});

test('data inválida é recusada', async () => {
  const cookie = await login('ana', 'senha-ana');
  const invalid = ['2026-02-30', '2026-13-01', '2027-02-29', '25/12/2026', 'amanhã', 20261225];
  for (const dueDate of invalid) {
    const response = await request('POST', '/api/todos', {
      cookie,
      body: { text: 'x', dueDate },
    });
    assert.equal(response.status, 400, String(dueDate));
  }
  const todo = await addTodo(cookie, 'ok');
  const patch = await request('PATCH', `/api/todos/${todo.id}`, {
    cookie,
    body: { dueDate: '2026-02-30' },
  });
  assert.equal(patch.status, 400);
});

test('logout invalida a sessão no servidor', async () => {
  const cookie = await login('ana', 'senha-ana');
  await request('POST', '/api/logout', { cookie });
  const response = await request('GET', '/api/todos', { cookie });
  assert.equal(response.status, 401);
});

test('sessões sobrevivem a reiniciar o servidor e não guardam o token', async () => {
  const cookie = await login('ana', 'senha-ana');
  const token = cookie.split('=')[1];
  const saved = fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8');
  assert.ok(!saved.includes(token));

  const users = [{ id: 'ana', name: 'Ana', ...(await hashPassword('x')) }];
  const restarted = createApp({ users, dataDir });
  await new Promise((resolve) => { restarted.listen(0, '127.0.0.1', resolve); });
  const { port } = restarted.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/me`, {
    headers: { Cookie: cookie },
  });
  await new Promise((resolve) => { restarted.close(resolve); });
  assert.equal(response.status, 200);
});

test('muitas senhas erradas bloqueiam novas tentativas, mesmo com a senha certa', async () => {
  const attempt = (password) => request('POST', '/api/login', {
    body: { username: 'limite', password },
  });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await attempt('errada')).status, 401);
  }
  const blocked = await attempt('senha-limite');
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});

test('arquivos do servidor e dados não são servidos', async () => {
  const paths = [
    '/server/users.json',
    '/data/todos-ana.json',
    '/../server/users.json',
    '/%2e%2e/server/users.json',
    '/..%2fserver%2fusers.json',
  ];
  for (const url of paths) {
    const response = await request('GET', url);
    assert.equal(response.status, 404, url);
  }
});

test('página inicial é servida com cabeçalhos de segurança', async () => {
  const response = await request('GET', '/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('previsão do tempo exige login', async () => {
  assert.equal((await request('GET', '/api/weather')).status, 401);
  assert.equal(weatherCalls.length, 0);
});

test('previsão pelo GPS traz a cidade e arredonda as coordenadas', async () => {
  const cookie = await login('ana', 'senha-ana');
  const response = await request('GET', '/api/weather?lat=-27.59491&lon=-48.54822', { cookie });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    place: 'Florianópolis',
    temperature: 29,
    weatherCode: 2,
    isDay: true,
    max: 30,
    min: 19,
    rainChance: 60,
  });
  const forecast = weatherCalls.find((url) => url.includes('api.open-meteo.com'));
  assert.match(forecast, /latitude=-27\.59&longitude=-48\.55/);
});

test('sem GPS, usa o local pelo IP; IP interno cai no IP público do servidor', async () => {
  const cookie = await login('ana', 'senha-ana');
  const response = await request('GET', '/api/weather', { cookie });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).place, 'Tubarão');
  const lookups = weatherCalls.filter((url) => url.includes('ipwho.is'));
  assert.equal(lookups.length, 2);
  assert.ok(lookups[1].startsWith('https://ipwho.is/?'));
});

test('previsão fica em cache por um tempo', async () => {
  const cookie = await login('ana', 'senha-ana');
  await request('GET', '/api/weather?lat=10.001&lon=20.001', { cookie });
  const calls = weatherCalls.length;
  const again = await request('GET', '/api/weather?lat=10.002&lon=20.002', { cookie });
  assert.equal(again.status, 200);
  assert.equal(weatherCalls.length, calls);
});

test('coordenadas inválidas são recusadas', async () => {
  const cookie = await login('ana', 'senha-ana');
  for (const query of ['?lat=91&lon=0', '?lat=0&lon=181', '?lat=abc&lon=1', '?lat=1', '?lat=&lon=']) {
    assert.equal((await request('GET', `/api/weather${query}`, { cookie })).status, 400, query);
  }
  assert.equal(weatherCalls.length, 0);
});

test('API de clima fora do ar vira erro 502 sem derrubar o app', async () => {
  const cookie = await login('ana', 'senha-ana');
  weatherDown = true;
  const response = await request('GET', '/api/weather?lat=1.5&lon=2.5', { cookie });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'Previsão do tempo indisponível agora.');
  assert.equal((await request('GET', '/api/todos', { cookie })).status, 200);
});
