'use strict';

// Função serverless da Vercel: todas as rotas /api/* e /healthz chegam aqui
// (ver vercel.json). A conexão com o Neon vem de DATABASE_URL, criada pela
// integração Neon da Vercel.

const { createHandler } = require('../server/app');
const { createNeonDb } = require('../server/db');

module.exports = createHandler({ db: createNeonDb(), trustProxy: true });
