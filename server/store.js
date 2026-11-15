'use strict';

const crypto = require('node:crypto');

/** Tarefas e itens de mercado ficam sempre em maiúsculas. */
const toUpperText = (text) => text.toLocaleUpperCase('pt-BR');

const toTodo = (row) => ({
  id: row.id,
  text: row.text,
  done: row.done,
  dueDate: row.due_date,
  createdAt: new Date(row.created_at).toISOString(),
});

const toItem = (row) => ({
  id: row.id,
  text: row.text,
  bought: row.bought,
  addedBy: row.added_by,
  createdAt: new Date(row.created_at).toISOString(),
});

/** O id vem da URL: o que não é UUID não existe, sem nem consultar o banco. */
const isUuid = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/**
 * Tarefas privadas. Toda consulta filtra por `user_id`, que vem sempre da
 * sessão, nunca do cliente: o id de uma tarefa do outro não encontra nada.
 */
function createTodoStore(db) {
  const list = async (userId) => (await db.query(
    'SELECT * FROM todos WHERE user_id = $1 ORDER BY created_at DESC, id',
    [userId],
  )).map(toTodo);

  return {
    list,

    async add(userId, text, dueDate) {
      const [row] = await db.query(
        `INSERT INTO todos (id, user_id, text, due_date) VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [crypto.randomUUID(), userId, toUpperText(text), dueDate],
      );
      return toTodo(row);
    },

    async update(userId, id, changes) {
      if (!isUuid(id)) return null;
      const [row] = await db.query(
        `UPDATE todos SET
           text     = CASE WHEN $3::boolean THEN $4 ELSE text END,
           due_date = CASE WHEN $5::boolean THEN $6 ELSE due_date END,
           done     = CASE WHEN $7::boolean THEN $8::boolean ELSE done END
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [
          id, userId,
          'text' in changes, 'text' in changes ? toUpperText(changes.text) : null,
          'dueDate' in changes, changes.dueDate ?? null,
          'done' in changes, changes.done ?? null,
        ],
      );
      return row ? toTodo(row) : null;
    },

    async remove(userId, id) {
      if (!isUuid(id)) return false;
      const rows = await db.query(
        'DELETE FROM todos WHERE id = $1 AND user_id = $2 RETURNING id',
        [id, userId],
      );
      return rows.length > 0;
    },

    async clearDone(userId) {
      await db.query('DELETE FROM todos WHERE user_id = $1 AND done', [userId]);
      return list(userId);
    },
  };
}

/**
 * Lista de mercado, a única coisa compartilhada entre os usuários. A versão
 * cresce a cada mudança: o cliente consulta de tempos em tempos e ignora uma
 * resposta mais antiga que chegue depois de outra mais nova.
 */
function createMarketStore(db) {
  async function read() {
    const [items, [meta]] = await Promise.all([
      db.query('SELECT * FROM market_items ORDER BY created_at DESC, id'),
      db.query('SELECT version FROM market_meta WHERE id = 1'),
    ]);
    return { version: Number(meta.version), items: items.map(toItem) };
  }

  /**
   * Muda a lista e a versão na mesma instrução: se nada mudou (item que não
   * existe), a versão fica como está e a resposta é `null`.
   */
  async function change(sql, params) {
    const rows = await db.query(
      `WITH changed AS (${sql} RETURNING 1)
       UPDATE market_meta SET version = version + 1
       WHERE id = 1 AND EXISTS (SELECT 1 FROM changed)
       RETURNING version`,
      params,
    );
    return rows.length > 0 ? read() : null;
  }

  return {
    read,

    add(text, addedBy) {
      return change(
        'INSERT INTO market_items (id, text, added_by) VALUES ($1, $2, $3)',
        [crypto.randomUUID(), toUpperText(text), addedBy],
      );
    },

    setBought(id, bought) {
      if (!isUuid(id)) return null;
      return change('UPDATE market_items SET bought = $2 WHERE id = $1', [id, bought]);
    },

    remove(id) {
      if (!isUuid(id)) return null;
      return change('DELETE FROM market_items WHERE id = $1', [id]);
    },

    async clearBought() {
      return (await change('DELETE FROM market_items WHERE bought', [])) || read();
    },
  };
}

module.exports = { createTodoStore, createMarketStore, toUpperText };
