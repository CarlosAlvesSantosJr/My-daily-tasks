'use strict';

const fs = require('node:fs');
const path = require('node:path');

const webpush = require('web-push');

const { readJsonFile, writeJsonFile } = require('./store');

const SUBJECT = process.env.VAPID_SUBJECT || 'https://example.com/to-do-list';
const NOTIFICATION_TTL_SECONDS = 60 * 60;

// O servidor faz um POST para o endpoint recebido do navegador; aceitar só os
// serviços de push conhecidos impede usá-lo para acessar endereços internos.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

function isValidSubscription(subscription) {
  const { endpoint, keys } = subscription;
  if (typeof endpoint !== 'string' || typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string') {
    return false;
  }
  try {
    const { protocol, hostname } = new URL(endpoint);
    return protocol === 'https:' && PUSH_HOSTS.some((host) => host.test(hostname));
  } catch {
    return false;
  }
}

/** `send` só é trocado nos testes, para não depender dos serviços reais. */
function createPush(dir, { send = webpush.sendNotification } = {}) {
  fs.mkdirSync(dir, { recursive: true });

  const keysFile = path.join(dir, 'vapid.json');
  const subscriptionsFile = path.join(dir, 'push-subscriptions.json');

  // As chaves ficam no volume: trocá-las invalidaria todas as inscrições.
  let keys = readJsonFile(keysFile, null);
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    writeJsonFile(keysFile, keys);
  }

  const read = () => readJsonFile(subscriptionsFile, []);
  const write = (entries) => writeJsonFile(subscriptionsFile, entries);

  return {
    publicKey: keys.publicKey,
    isValidSubscription,

    /** Um aparelho fica ligado a um usuário só: quem entrou por último. */
    subscribe(userId, { endpoint, keys: subscriptionKeys }) {
      const others = read().filter((entry) => entry.subscription.endpoint !== endpoint);
      write([...others, { userId, subscription: { endpoint, keys: subscriptionKeys } }]);
    },

    unsubscribe(userId, endpoint) {
      write(read().filter((entry) => (
        entry.userId !== userId || entry.subscription.endpoint !== endpoint
      )));
    },

    /** Avisa todo mundo menos quem fez a mudança. Falhas não afetam o pedido. */
    async notifyOthers(userId, message) {
      const targets = read().filter((entry) => entry.userId !== userId);
      const expired = new Set();

      await Promise.all(targets.map(async ({ subscription }) => {
        try {
          await send(subscription, JSON.stringify(message), {
            TTL: NOTIFICATION_TTL_SECONDS,
            urgency: 'high',
            vapidDetails: { subject: SUBJECT, ...keys },
          });
        } catch (err) {
          // 404 e 410: o navegador cancelou a inscrição.
          if (err.statusCode === 404 || err.statusCode === 410) {
            expired.add(subscription.endpoint);
          } else {
            console.warn('Falha ao enviar notificação:', err.statusCode || err.message);
          }
        }
      }));

      if (expired.size > 0) {
        write(read().filter((entry) => !expired.has(entry.subscription.endpoint)));
      }
    },
  };
}

module.exports = { createPush };
