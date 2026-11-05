const CACHE_NAME = 'livetype-pwa-v21';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/p2p-file-transfer.js',
  './js/app.js',
  './manifest.json',
  './assets/icons/icon.svg',
  './sound/keyboard-typing-sound-effect.mp3',
  './sound/download-notification-sound.mp3',
  './sound/live-sound-notification.mp3'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
