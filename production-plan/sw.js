const STATIC_CACHE = 'production-plan-cache-v1.0.0-beta19.1';

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
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key !== STATIC_CACHE)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. GET이 아닌 요청(POST 등)이나 외부 도메인(Cloudflare Worker, Firebase, OneSignal 등)은 SW가 가로채지 않음
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // 2. 네트워크 우선(Network-First): 온라인일 때는 항상 최신 파일을 받아 캐시를 갱신하고, 오프라인일 때만 캐시 반환
  event.respondWith(
    fetch(event.request)
      .then(networkRes => {
        if (networkRes && networkRes.status === 200) {
          const resClone = networkRes.clone();
          caches.open(STATIC_CACHE).then(cache => cache.put(event.request, resClone));
        }
        return networkRes;
      })
      .catch(() => caches.match(event.request))
  );
});