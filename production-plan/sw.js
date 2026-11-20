const STATIC_CACHE = 'production-plan-cache-v1.0.0-beta10.2';

const ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './IDCIcon-192.png',
  './IDCIcon-512.png',
  './js/app.js',
  './js/firebase.js',
  './js/utils.js',
  './js/plan-slider.js',
  './js/excel-sync.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== STATIC_CACHE)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const { request } = event;
    event.respondWith(
      caches.match(request).then(cachedRes => cachedRes || fetch(request))
    );
});