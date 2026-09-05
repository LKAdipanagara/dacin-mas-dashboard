const CACHE_NAME = 'dacin-mas-crud-v13';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './compute.js',
  './db.js',
  './firebase-config.js',
  './seed-data.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './brand-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Jangan sentuh apa pun yang menuju Firestore/Firebase — biarkan SDK-nya sendiri
  // yang mengurus cache & sinkronisasi offline (lebih andal daripada cache generik).
  if (req.url.includes('firestore.googleapis.com') || req.url.includes('googleapis.com') || req.url.includes('firebaseio.com')) {
    return;
  }

  // Pustaka CDN (Chart.js, Firebase SDK dari gstatic): network-first, fallback ke cache
  if (req.url.includes('cdnjs.cloudflare.com') || req.url.includes('gstatic.com')) {
    event.respondWith(
      fetch(req).then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, clone));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // App shell: cache-first
  event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});
