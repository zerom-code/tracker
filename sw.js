/* Сервис-воркер: кэшируем оболочку приложения, чтобы трекер открывался офлайн.
   Запросы к API (Monobank, НБУ) всегда идут в сеть. */

const CACHE = 'tracker-v5';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/store.js',
  './js/api.js',
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
