'use strict';

const CACHE = 'shell-v3';
const SHELL = [
  '/',
  '/style.css',
  '/app.js',
  '/icon.svg',
  '/bg.jpg',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE).map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  );
});

// Rede primeiro, para atualizações aparecerem na hora; o cache só serve para o
// app abrir sem internet. Respostas de /api nunca são guardadas: têm dados
// pessoais e o aparelho pode ser usado por outra pessoa.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!SHELL.includes(url.pathname)) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(url.pathname, copy)));
        }
        return response;
      })
      .catch(() => caches.match(url.pathname)),
  );
});

// Sempre mostra a notificação: o iPhone cancela a inscrição de quem recebe
// push sem exibir nada. A tag agrupa vários itens seguidos em um aviso só.
self.addEventListener('push', (event) => {
  const { title, body } = event.data.json();
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: 'market',
    renotify: true,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.length === 0) {
      await self.clients.openWindow('/#mercado');
      return;
    }
    windows[0].postMessage('open-market');
    await windows[0].focus();
  })());
});
