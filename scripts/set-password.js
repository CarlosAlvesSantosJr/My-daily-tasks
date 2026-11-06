'use strict';

// Cria um usuário ou troca a senha: node scripts/set-password.js <nome> <senha>

const fs = require('node:fs');
const path = require('node:path');

const { hashPassword, normalizeUsername } = require('../server/auth');

const USERS_FILE = path.join(__dirname, '..', 'server', 'users.json');

async function main() {
  const [name, password] = process.argv.slice(2);
  if (!name || !password) {
    console.error('Uso: node scripts/set-password.js <nome> <senha>');
    process.exit(1);
  }

  const users = fs.existsSync(USERS_FILE)
    ? JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
    : [];
  const id = normalizeUsername(name);
  const user = { id, name, ...(await hashPassword(password)) };
  const index = users.findIndex((item) => item.id === id);

  if (index === -1) users.push(user);
  else users[index] = user;

  fs.writeFileSync(USERS_FILE, `${JSON.stringify(users, null, 2)}\n`);
  console.log(`Senha de ${name} salva.`);
}

main();
