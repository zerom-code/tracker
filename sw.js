/* Сервис-воркер: кэшируем оболочку приложения, чтобы трекер открывался офлайн.
   Запросы к API (Monobank, НБУ) всегда идут в сеть. */

const CACHE = 'tracker-v30';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/store.js',
  './js/api.js',
  './js/sync.js',
  './js/qr.js',
  './js/receipts.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Push-уведомления от личного сервера: новые операции и напоминания о платежах.
   Сервер шлёт относительный адрес ('#ops', '#subs'), а не абсолютный путь —
   на GitHub Pages сайт живёт в подпапке (/<репозиторий>/), и путь вида '/#ops'
   резолвился бы от корня домена, унося на несуществующую страницу. Разрешаем
   его против scope самого service worker'а — это и есть фактический адрес
   установленного сайта, независимо от того, как называется репозиторий. */
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { /* оставим заглушку ниже */ }
  const url = new URL(data.url || '', self.registration.scope).href;
  e.waitUntil(
    self.registration.showNotification(data.title || 'Трекер трат', {
      body: data.body || '',
      tag: data.tag || 'tracker',
      icon: './icons/icon-180.png',
      badge: './icons/icon-180.png',
      data: { url },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          if ('navigate' in client) client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // сеть в приоритете (чтобы обновления доезжали), кэш — запасной вариант
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() =>
        caches.match(e.request, { ignoreSearch: true })
          .then((r) => r || caches.match('./index.html'))
      )
  );
});
