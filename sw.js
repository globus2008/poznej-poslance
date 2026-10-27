// Offline cache for the app shell. Bump CACHE when shipping changes so clients refresh.
const CACHE = 'poznej-poslance-v11';
const ASSETS = [
  './',
  'index.html',
  'about.html',
  'style.css',
  'app.js',
  'audio.js',
  'rounds.js',
  'leaderboard.js',
  'share.js',
  'config.js',
  'data/periods.json',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's HTTP cache so a new version never caches old files.
  const fresh = ASSETS.map((url) => new Request(url, { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Data (quiz.json) network-first so new opinions show up at once; everything else of ours,
// including the audio clips (content-hashed names), stale-while-revalidate. Photos and the
// leaderboard (other origins) bypass the worker.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      if (url.pathname.endsWith('.json')) return network.then((res) => res || cached);
      return cached || network;
    }),
  );
});
