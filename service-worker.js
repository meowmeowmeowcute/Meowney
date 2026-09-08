const CACHE_NAME = 'meowney-app-shell-v34';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=34',
  './app.js?v=34',
  './calculator.js?v=34',
  './data-layer.js?v=34',
  './query-logic.js?v=34',
  './backup-format.js?v=34',
  './manifest.webmanifest',
  './icons/meowney-192.png',
  './icons/meowney-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME)
    .then((cache) => cache.addAll(APP_SHELL.map((asset) => new Request(asset, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('meowney-app-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request)
      .then(async (response) => {
        const cache = await caches.open(CACHE_NAME);
        await cache.put('./index.html', response.clone());
        return response;
      })
      .catch(() => caches.match('./index.html')));
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
