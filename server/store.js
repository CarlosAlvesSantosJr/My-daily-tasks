'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Tarefas e itens de mercado ficam sempre em maiúsculas. */
const toUpperText = (text) => text.toLocaleUpperCase('pt-BR');

/** Devolve o JSON do arquivo, ou `fallback` se ele ainda não existe. */
function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/**
 * A escrita síncrona com rename evita arquivo pela metade e, como o Node é
 * single-thread, duas escritas nunca se misturam.
 */
function writeJsonFile(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Um arquivo por usuário. Toda operação exige o userId, que vem sempre da
 * sessão, nunca do cliente.
 */
function createTodoStore(dir) {
  fs.mkdirSync(dir, { recursive: true });

  const fileFor = (userId) => path.join(dir, `todos-${userId}.json`);
  // As gravadas antes da regra das maiúsculas são convertidas na leitura.
  const read = (userId) => readJsonFile(fileFor(userId), [])
    .map((todo) => ({ ...todo, text: toUpperText(todo.text) }));
  const write = (userId, todos) => writeJsonFile(fileFor(userId), todos);

  return {
    list: read,

    add(userId, text, dueDate) {
      const todos = read(userId);
      const todo = {
        id: crypto.randomUUID(),
        text: toUpperText(text),
        done: false,
        dueDate,
        createdAt: new Date().toISOString(),
      };
      todos.unshift(todo);
      write(userId, todos);
      return todo;
    },

    update(userId, id, changes) {
      const todos = read(userId);
      const todo = todos.find((item) => item.id === id);
      if (!todo) return null;
      Object.assign(todo, changes);
      todo.text = toUpperText(todo.text);
      write(userId, todos);
      return todo;
    },

    remove(userId, id) {
      const todos = read(userId);
      const remaining = todos.filter((item) => item.id !== id);
      if (remaining.length === todos.length) return false;
      write(userId, remaining);
      return true;
    },

    clearDone(userId) {
      const remaining = read(userId).filter((item) => !item.done);
      write(userId, remaining);
      return remaining;
    },
  };
}

/**
 * Lista de mercado, a única coisa compartilhada entre os usuários. A versão
 * cresce a cada mudança para o cliente ignorar uma resposta mais antiga que
 * chegue depois de uma atualização em tempo real.
 */
function createMarketStore(dir) {
  fs.mkdirSync(dir, { recursive: true });

  const file = path.join(dir, 'market.json');
  // Os itens gravados antes da regra das maiúsculas são convertidos na leitura.
  const read = () => {
    const state = readJsonFile(file, { version: 0, items: [] });
    for (const item of state.items) item.text = toUpperText(item.text);
    return state;
  };

  function save(items, version) {
    const state = { version: version + 1, items };
    writeJsonFile(file, state);
    return state;
  }

  return {
    read,

    add(text, addedBy) {
      const { version, items } = read();
      const item = {
        id: crypto.randomUUID(),
        text: toUpperText(text),
        bought: false,
        addedBy,
        createdAt: new Date().toISOString(),
      };
      return save([item, ...items], version);
    },

    setBought(id, bought) {
      const { version, items } = read();
      const item = items.find((other) => other.id === id);
      if (!item) return null;
      item.bought = bought;
      return save(items, version);
    },

    remove(id) {
      const { version, items } = read();
      const remaining = items.filter((item) => item.id !== id);
      if (remaining.length === items.length) return null;
      return save(remaining, version);
    },

    clearBought() {
      const { version, items } = read();
      return save(items.filter((item) => !item.bought), version);
    },
  };
}

module.exports = {
  createTodoStore,
  createMarketStore,
  toUpperText,
  readJsonFile,
  writeJsonFile,
};
