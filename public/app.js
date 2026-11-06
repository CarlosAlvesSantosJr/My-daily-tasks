'use strict';

const $ = (id) => document.getElementById(id);

const EMPTY_MESSAGES = {
  all: 'Nada por aqui ainda. Adicione sua primeira tarefa.',
  pending: 'Nenhuma tarefa pendente.',
  done: 'Nenhuma tarefa concluída.',
};

const MAX_DOTS = 3;

const initialState = () => ({
  todos: [],
  filter: 'all',
  view: 'list',
  newDate: null, // data escolhida no campo de nova tarefa, na aba Lista
  selectedDay: null, // dia aberto no calendário
  month: null, // primeiro dia do mês exibido no calendário
  editing: null, // rascunho da tarefa em edição: { id, text, dueDate }
  userName: null,
  market: [],
  marketVersion: 0,
  marketUnseen: 0, // itens dos outros ainda não vistos na aba Mercado
  live: false, // conexão em tempo real aberta
  pushEnabled: false,
});

const state = initialState();

// Datas das tarefas são "AAAA-MM-DD" no horário local. Nunca usar toISOString
// aqui: ele converte para UTC e, à noite no Brasil, cairia no dia seguinte.
const pad = (number) => String(number).padStart(2, '0');
const toKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const todayKey = () => toKey(new Date());

function fromKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function addDays(key, amount) {
  const date = fromKey(key);
  date.setDate(date.getDate() + amount);
  return toKey(date);
}

function formatShort(key) {
  const today = todayKey();
  if (key === today) return 'Hoje';
  if (key === addDays(today, 1)) return 'Amanhã';
  if (key === addDays(today, -1)) return 'Ontem';
  const date = fromKey(key);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('pt-BR', {
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : 'numeric',
  }).replace('.', '');
}

function formatLong(key) {
  return fromKey(key).toLocaleDateString('pt-BR', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
}

let toastTimer;

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
}

async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Sem conexão com o servidor.');
  }

  if (response.status === 204) return null;

  const data = await response.json().catch(() => ({}));
  if (response.ok) return data;

  // Sessão expirada: volta ao login sem deixar a lista na tela.
  if (response.status === 401 && path !== '/api/login') {
    showLogin();
    const expired = new Error(data.error);
    expired.silent = true;
    throw expired;
  }
  throw new Error(data.error || 'Algo deu errado. Tente de novo.');
}

/** Roda uma ação da lista e mostra o erro, se houver. */
async function attempt(action) {
  try {
    await action();
  } catch (err) {
    if (!err.silent) showToast(err.message);
  }
}

function showLogin() {
  disconnectLive();
  Object.assign(state, initialState());
  $('todo-list').replaceChildren();
  $('day-list').replaceChildren();
  $('calendar-grid').replaceChildren();
  $('market-list').replaceChildren();
  $('add-form').reset();
  $('login-form').reset();
  $('login-error').hidden = true;
  $('app-view').hidden = true;
  $('login-view').hidden = false;
  $('username').focus();
}

async function showApp(name) {
  $('user-name').textContent = name;
  $('today').textContent = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  state.userName = name;
  state.todos = await api('/api/todos');
  applyMarket(await api('/api/market'));
  if (location.hash === '#mercado') state.view = 'market';
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  render();
  connectLive();
  syncPush();
}

/** Pendentes primeiro; dentro delas, as datas mais próximas e depois as sem data. */
function compareTodos(a, b) {
  return a.done - b.done
    || (a.dueDate || '9999').localeCompare(b.dueDate || '9999');
}

function visibleTodos() {
  const todos = [...state.todos].sort(compareTodos);
  if (state.filter === 'pending') return todos.filter((todo) => !todo.done);
  if (state.filter === 'done') return todos.filter((todo) => todo.done);
  return todos;
}

function replaceTodo(updated) {
  state.todos = state.todos.map((todo) => (todo.id === updated.id ? updated : todo));
  render();
}

function selectDay(key) {
  const date = fromKey(key);
  state.selectedDay = key;
  state.month = new Date(date.getFullYear(), date.getMonth(), 1);
}

function changeMonth(amount) {
  const { month } = state;
  state.month = new Date(month.getFullYear(), month.getMonth() + amount, 1);
  render();
}

function startEditing(todo) {
  state.editing = { id: todo.id, text: todo.text, dueDate: todo.dueDate || '' };
  render();
  const input = document.querySelector('.edit-input');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  // Evita que os botões fiquem atrás do campo fixo de nova tarefa.
  input.closest('.todo').scrollIntoView({ block: 'center' });
}

function stopEditing() {
  state.editing = null;
  render();
}

function renderEditor() {
  const item = $('edit-template').content.firstElementChild.cloneNode(true);
  const text = item.querySelector('.edit-input');
  const date = item.querySelector('.edit-date');
  const draft = state.editing;

  text.value = draft.text;
  date.value = draft.dueDate;

  text.addEventListener('input', () => { draft.text = text.value; });
  date.addEventListener('input', () => { draft.dueDate = date.value; });
  item.querySelector('.cancel').addEventListener('click', stopEditing);
  item.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') stopEditing();
  });
  item.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    attempt(async () => {
      const updated = await api(`/api/todos/${draft.id}`, {
        method: 'PATCH',
        body: { text: draft.text, dueDate: draft.dueDate || null },
      });
      state.editing = null;
      replaceTodo(updated);
    });
  });

  return item;
}

function renderDue(element, todo) {
  // No calendário o dia já está no título, então a etiqueta seria repetição.
  if (!todo.dueDate || state.view === 'calendar') return;
  const late = !todo.done && todo.dueDate < todayKey();
  element.hidden = false;
  element.classList.toggle('late', late);
  element.textContent = late
    ? `Atrasada · ${formatShort(todo.dueDate)}`
    : formatShort(todo.dueDate);
}

function renderTodo(todo) {
  if (state.editing?.id === todo.id) return renderEditor();

  const item = $('todo-template').content.firstElementChild.cloneNode(true);
  const checkbox = item.querySelector('input[type="checkbox"]');
  const edit = item.querySelector('.edit');
  const remove = item.querySelector('.delete');

  item.classList.toggle('done', todo.done);
  item.querySelector('.text').textContent = todo.text;
  renderDue(item.querySelector('.due'), todo);
  checkbox.checked = todo.done;
  checkbox.setAttribute('aria-label', `Concluir: ${todo.text}`);
  edit.setAttribute('aria-label', `Editar: ${todo.text}`);
  remove.setAttribute('aria-label', `Apagar: ${todo.text}`);

  checkbox.addEventListener('change', () => attempt(async () => {
    try {
      replaceTodo(await api(`/api/todos/${todo.id}`, {
        method: 'PATCH',
        body: { done: checkbox.checked },
      }));
    } catch (err) {
      checkbox.checked = todo.done;
      throw err;
    }
  }));

  edit.addEventListener('click', () => startEditing(todo));

  remove.addEventListener('click', () => {
    if (!confirm(`Apagar "${todo.text}"?`)) return;
    attempt(async () => {
      await api(`/api/todos/${todo.id}`, { method: 'DELETE' });
      state.todos = state.todos.filter((other) => other.id !== todo.id);
      render();
    });
  });

  return item;
}

function renderList() {
  const visible = visibleTodos();
  $('todo-list').replaceChildren(...visible.map(renderTodo));
  $('empty').textContent = EMPTY_MESSAGES[state.filter];
  $('empty').hidden = visible.length > 0;
  $('clear-done').hidden = state.filter === 'pending' || !state.todos.some((todo) => todo.done);

  for (const button of document.querySelectorAll('[data-filter]')) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
  }
}

function renderDay(key, todos, today) {
  const date = fromKey(key);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'day';
  button.dataset.day = key;
  button.classList.toggle('today', key === today);
  button.setAttribute('aria-pressed', String(key === state.selectedDay));

  const month = date.toLocaleDateString('pt-BR', { month: 'long' });
  const count = todos.length === 1 ? '1 tarefa' : `${todos.length} tarefas`;
  button.setAttribute(
    'aria-label',
    `${date.getDate()} de ${month}${todos.length ? `, ${count}` : ''}`,
  );

  const number = document.createElement('span');
  number.textContent = date.getDate();

  const dots = document.createElement('span');
  dots.className = 'dots';
  for (const todo of todos.slice(0, MAX_DOTS)) {
    const dot = document.createElement('i');
    dot.classList.toggle('done', todo.done);
    dot.classList.toggle('late', !todo.done && key < today);
    dots.append(dot);
  }
  if (todos.length > MAX_DOTS) dots.append('+');

  button.append(number, dots);
  return button;
}

function renderCalendar() {
  const { month, selectedDay } = state;
  const today = todayKey();
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

  const byDay = new Map();
  for (const todo of [...state.todos].sort(compareTodos)) {
    if (!todo.dueDate) continue;
    if (!byDay.has(todo.dueDate)) byDay.set(todo.dueDate, []);
    byDay.get(todo.dueDate).push(todo);
  }

  const cells = [];
  for (let blank = 0; blank < month.getDay(); blank += 1) {
    cells.push(document.createElement('span'));
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = toKey(new Date(year, monthIndex, day));
    cells.push(renderDay(key, byDay.get(key) || [], today));
  }

  $('month-label').textContent = `${month.toLocaleDateString('pt-BR', { month: 'long' })} ${year}`;
  $('calendar-grid').replaceChildren(...cells);

  const todos = byDay.get(selectedDay) || [];
  $('day-title').textContent = formatLong(selectedDay);
  $('day-list').replaceChildren(...todos.map(renderTodo));
  $('day-empty').hidden = todos.length > 0;
}

function renderMarketItem(item) {
  const row = $('market-template').content.firstElementChild.cloneNode(true);
  const checkbox = row.querySelector('input[type="checkbox"]');
  const remove = row.querySelector('.delete');

  row.classList.toggle('done', item.bought);
  row.querySelector('.text').textContent = item.text;
  row.querySelector('.due').textContent = `Adicionado por ${item.addedBy}`;
  checkbox.checked = item.bought;
  checkbox.setAttribute('aria-label', `Comprado: ${item.text}`);
  remove.setAttribute('aria-label', `Apagar: ${item.text}`);

  checkbox.addEventListener('change', () => attempt(async () => {
    try {
      applyMarket(await api(`/api/market/${item.id}`, {
        method: 'PATCH',
        body: { bought: checkbox.checked },
      }));
    } catch (err) {
      checkbox.checked = item.bought;
      throw err;
    }
  }));

  remove.addEventListener('click', () => {
    if (!confirm(`Apagar "${item.text}"?`)) return;
    attempt(async () => {
      applyMarket(await api(`/api/market/${item.id}`, { method: 'DELETE' }));
    });
  });

  return row;
}

function renderMarket() {
  // O que falta comprar vem antes; sort é estável e mantém os mais novos no topo.
  const items = [...state.market].sort((a, b) => a.bought - b.bought);
  $('market-list').replaceChildren(...items.map(renderMarketItem));
  $('market-empty').hidden = items.length > 0;
  $('clear-bought').hidden = !items.some((item) => item.bought);
  $('live-status').textContent = state.live ? 'Ao vivo' : 'Reconectando…';
  $('live-status').classList.toggle('on', state.live);
  renderPushControls();
}

function renderBadge() {
  const badge = $('market-badge');
  badge.hidden = state.marketUnseen === 0;
  badge.textContent = state.marketUnseen;
}

/** A tarefa nova vai para o dia aberto no calendário ou para a data escolhida. */
function composerDate() {
  if (state.view === 'market') return null;
  return state.view === 'calendar' ? state.selectedDay : state.newDate;
}

function renderComposer() {
  const date = composerDate();
  $('composer-date').hidden = !date;
  $('composer-date-text').textContent = date ? `Para: ${formatLong(date)}` : '';
  $('clear-date').hidden = state.view !== 'list';
  $('date-pick').hidden = state.view !== 'list';

  const placeholder = state.view === 'market' ? 'Novo item' : 'Nova tarefa';
  $('new-todo').placeholder = `${placeholder}…`;
  $('new-todo').setAttribute('aria-label', placeholder);
}

function renderProgress() {
  const inMarket = state.view === 'market';
  const total = inMarket ? state.market.length : state.todos.length;
  const done = inMarket
    ? state.market.filter((item) => item.bought).length
    : state.todos.filter((todo) => todo.done).length;
  const word = inMarket ? 'comprado' : 'concluída';

  $('progress-bar').style.width = total ? `${(done / total) * 100}%` : '0';
  $('summary').textContent = total
    ? `${done} de ${total} ${word}${total === 1 ? '' : 's'}`
    : 'Sua lista está vazia';
}

function render() {
  if (state.view === 'market') state.marketUnseen = 0;
  renderProgress();
  renderBadge();

  $('list-view').hidden = state.view !== 'list';
  $('calendar-view').hidden = state.view !== 'calendar';
  $('market-view').hidden = state.view !== 'market';
  for (const button of document.querySelectorAll('[data-view]')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
  }

  if (state.view === 'calendar') renderCalendar();
  else if (state.view === 'market') renderMarket();
  else renderList();
  renderComposer();
}

function openView(view) {
  state.view = view;
  if (view === 'calendar' && !state.selectedDay) selectDay(todayKey());
  render();
}

/**
 * Aplica o estado vindo do servidor. Em outra aba, só atualiza o contador:
 * redesenhar ali derrubaria o foco de quem está digitando.
 */
function applyMarket({ version, items, event }) {
  if (version < state.marketVersion) return;
  state.marketVersion = version;
  state.market = items;

  if (event && event.by !== state.userName) {
    showToast(`${event.by} adicionou ${event.text}`);
    if (state.view !== 'market') state.marketUnseen += 1;
  }
  if (state.view === 'market') render();
  else renderBadge();
}

let socket = null;
let reconnectTimer;
let reconnectDelay = 1000;

function setLive(live) {
  state.live = live;
  if (state.view === 'market') render();
}

function connectLive() {
  clearTimeout(reconnectTimer);
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const current = new WebSocket(`${scheme}://${location.host}/api/market/live`);
  socket = current;

  current.addEventListener('open', () => {
    reconnectDelay = 1000;
    setLive(true);
  });
  current.addEventListener('message', (message) => applyMarket(JSON.parse(message.data)));
  current.addEventListener('close', () => {
    if (socket !== current) return;
    setLive(false);
    reconnectTimer = setTimeout(connectLive, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });
}

function disconnectLive() {
  clearTimeout(reconnectTimer);
  const current = socket;
  socket = null;
  if (current) current.close();
}

/** Celular suspende a conexão em segundo plano: ao voltar, sincroniza na hora. */
function resumeLive() {
  if (!state.userName || document.hidden) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    disconnectLive();
    connectLive();
  }
  attempt(async () => applyMarket(await api('/api/market')));
}

document.addEventListener('visibilitychange', resumeLive);
window.addEventListener('online', resumeLive);

const pushSupported = () => 'serviceWorker' in navigator
  && 'PushManager' in window
  && 'Notification' in window;

const isInstalled = () => matchMedia('(display-mode: standalone)').matches
  || navigator.standalone === true;

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

function renderPushControls() {
  const needsInstall = isIos() && !isInstalled();
  $('enable-push').hidden = !pushSupported() || state.pushEnabled || needsInstall;
  $('push-hint').hidden = !needsInstall;
  $('push-hint').textContent = needsInstall
    ? 'No iPhone, toque em Compartilhar e em "Adicionar à Tela de Início" para receber avisos.'
    : '';
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function currentSubscription() {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Permita as notificações nos ajustes do navegador.');
  }
  const registration = await navigator.serviceWorker.ready;
  const { key } = await api('/api/push/key');
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(key),
  });
  await api('/api/push/subscribe', { method: 'POST', body: subscription.toJSON() });
  state.pushEnabled = true;
  showToast('Avisos ativados neste aparelho.');
  render();
}

/** Reassocia o aparelho a quem acabou de entrar, se os avisos já estavam ligados. */
async function syncPush() {
  try {
    const subscription = await currentSubscription();
    if (!subscription || Notification.permission !== 'granted') return;
    await api('/api/push/subscribe', { method: 'POST', body: subscription.toJSON() });
    state.pushEnabled = true;
    if (state.view === 'market') render();
  } catch (err) {
    console.warn('Avisos indisponíveis:', err.message);
  }
}

/** Num aparelho compartilhado, quem sai não deve continuar recebendo avisos. */
async function removePush() {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await api('/api/push/unsubscribe', {
    method: 'POST',
    body: { endpoint: subscription.endpoint },
  });
  await subscription.unsubscribe();
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = $('login-submit');
  const error = $('login-error');
  submit.disabled = true;
  error.hidden = true;
  try {
    const { name } = await api('/api/login', {
      method: 'POST',
      body: { username: $('username').value, password: $('password').value },
    });
    await showApp(name);
    $('login-form').reset();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    $('password').value = '';
    $('password').focus();
  } finally {
    submit.disabled = false;
  }
});

$('logout').addEventListener('click', () => attempt(async () => {
  await removePush();
  await api('/api/logout', { method: 'POST' });
  showLogin();
}));

function setNewDate(value) {
  state.newDate = value || null;
  $('new-date').value = value || '';
  renderComposer();
}

$('add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('new-todo');
  const text = input.value.trim();
  if (!text) return;
  attempt(async () => {
    if (state.view === 'market') {
      applyMarket(await api('/api/market', { method: 'POST', body: { text } }));
      input.value = '';
      return;
    }
    const todo = await api('/api/todos', {
      method: 'POST',
      body: { text, dueDate: composerDate() },
    });
    state.todos.unshift(todo);
    // Sai de "Concluídas" para a tarefa nova aparecer na tela.
    if (state.filter === 'done') state.filter = 'all';
    input.value = '';
    setNewDate(null);
    render();
  });
  input.focus();
});

$('new-date').addEventListener('change', (event) => setNewDate(event.target.value));
$('clear-date').addEventListener('click', () => setNewDate(null));

// Abre o seletor de data em navegadores onde tocar no campo oculto não basta.
$('new-date').addEventListener('click', (event) => {
  try {
    event.target.showPicker();
  } catch {
    // Sem showPicker, o navegador abre o seletor sozinho.
  }
});

$('clear-done').addEventListener('click', () => {
  if (!confirm('Apagar todas as tarefas concluídas?')) return;
  attempt(async () => {
    state.todos = await api('/api/todos/clear-done', { method: 'POST' });
    render();
  });
});

for (const button of document.querySelectorAll('[data-filter]')) {
  button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    render();
  });
}

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => openView(button.dataset.view));
}

$('prev-month').addEventListener('click', () => changeMonth(-1));
$('next-month').addEventListener('click', () => changeMonth(1));
$('go-today').addEventListener('click', () => {
  selectDay(todayKey());
  render();
});

$('calendar-grid').addEventListener('click', (event) => {
  const day = event.target.closest('[data-day]');
  if (!day) return;
  const key = day.dataset.day;
  selectDay(key);
  render();
  // O render recria a grade; devolve o foco para quem navega pelo teclado.
  $('calendar-grid').querySelector(`[data-day="${key}"]`).focus();
});

$('clear-bought').addEventListener('click', () => {
  if (!confirm('Apagar todos os itens comprados?')) return;
  attempt(async () => {
    applyMarket(await api('/api/market/clear-bought', { method: 'POST' }));
  });
});

// A primeira inscrição pode levar dezenas de segundos no Chrome.
$('enable-push').addEventListener('click', async () => {
  const button = $('enable-push');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Ativando…';
  await attempt(enablePush);
  button.disabled = false;
  button.textContent = label;
});

let installPrompt = null;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  $('install-app').hidden = false;
});

$('install-app').addEventListener('click', async () => {
  $('install-app').hidden = true;
  await installPrompt.prompt();
  installPrompt = null;
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.warn('Service worker indisponível:', err.message);
  });
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data === 'open-market' && state.userName) openView('market');
  });
}

(async function start() {
  try {
    const { name } = await api('/api/me');
    await showApp(name);
  } catch (err) {
    if (!err.silent) {
      showLogin();
      $('login-error').textContent = err.message;
      $('login-error').hidden = false;
    }
  }
}());
