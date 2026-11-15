'use strict';

// web-push é só ESM: carregado sob demanda, o que funciona em qualquer runtime Node.
const loadWebPush = () => import('web-push');

const SUBJECT = process.env.VAPID_SUBJECT || 'https://mydailytaskas.vercel.app';
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
function createPush(db, {
  send = async (...args) => (await loadWebPush()).sendNotification(...args),
} = {}) {
  let keys = null;

  // As chaves ficam no banco: trocá-las invalidaria todas as inscrições.
  // `DO NOTHING` garante que duas instâncias iniciando juntas fiquem com o mesmo par.
  async function vapidKeys() {
    if (keys) return keys;
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('vapid', $1::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [JSON.stringify((await loadWebPush()).generateVAPIDKeys())],
    );
    const [row] = await db.query("SELECT value FROM settings WHERE key = 'vapid'");
    keys = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    return keys;
  }

  return {
    async publicKey() {
      return (await vapidKeys()).publicKey;
    },

    isValidSubscription,

    /** Um aparelho fica ligado a um usuário só: quem entrou por último. */
    async subscribe(userId, { endpoint, keys: { p256dh, auth } }) {
      await db.query(
        `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = $2, p256dh = $3, auth = $4`,
        [endpoint, userId, p256dh, auth],
      );
    },

    async unsubscribe(userId, endpoint) {
      await db.query(
        'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
        [userId, endpoint],
      );
    },

    async subscriptions() {
      return db.query('SELECT endpoint, user_id FROM push_subscriptions ORDER BY endpoint');
    },

    /** Avisa todo mundo menos quem fez a mudança. Falhas não afetam o pedido. */
    async notifyOthers(userId, message) {
      const targets = await db.query(
        'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id <> $1',
        [userId],
      );
      if (targets.length === 0) return;
      const vapid = await vapidKeys();
      const expired = [];

      await Promise.all(targets.map(async ({ endpoint, p256dh, auth }) => {
        try {
          await send({ endpoint, keys: { p256dh, auth } }, JSON.stringify(message), {
            TTL: NOTIFICATION_TTL_SECONDS,
            urgency: 'high',
            timeout: 5000,
            vapidDetails: { subject: SUBJECT, ...vapid },
          });
        } catch (err) {
          // 404 e 410: o navegador cancelou a inscrição.
          if (err.statusCode === 404 || err.statusCode === 410) {
            expired.push(endpoint);
          } else {
            console.warn('Falha ao enviar notificação:', err.statusCode || err.message);
          }
        }
      }));

      if (expired.length > 0) {
        await db.query('DELETE FROM push_subscriptions WHERE endpoint = ANY($1::text[])', [expired]);
      }
    },
  };
}

module.exports = { createPush };
