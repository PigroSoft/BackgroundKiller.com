/* Background Killer service worker. It keeps this site's own files so the page opens without a connection.
   The cutout model is not kept here: the page stores it once in its own cache (background-killer-model-v2).
   Online, every request goes to the network first, so a new version shows up on the next visit. Offline, the kept copy is used. */
var CACHE = 'background-killer-site-v1';
var SCOPE = self.registration.scope;
var PRECACHE = [
  './', 'about', 'privacy', 'imprint', 'terms', 'licenses',
  'remove-bg-alternative', 'remove-background-from-image', 'make-png-transparent', 'product-photo-background-remover',
  'styles.css', 'app.js', 'engine.js', 'worker.js', 'matte.js', 'version.js', 'jszip.min.js',
  'ort/ort.wasm.min.js', 'ort/ort-wasm-simd-threaded.mjs', 'ort/ort-wasm-simd-threaded.wasm',
  'fonts/anton-latin-400-normal.woff2', 'fonts/inter-latin-wght-normal.woff2',
  'assets/noir-open.webp', 'assets/claw-cut.webp', 'assets/claw.webp', 'assets/noir-footer.webp', 'assets/avatar.webp',
  'sample/ragdoll-kitten.jpg', 'sample/thumb-ragdoll-kitten.jpg',
  'favicon.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest'
];
var MODEL_PATH = new URL('model/', SCOPE).pathname;

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (cache) {
    return Promise.all(PRECACHE.map(function (u) {
      return cache.add(new Request(new URL(u, SCOPE).href, { cache: 'reload' })).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('background-killer-site-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.indexOf(MODEL_PATH) === 0) return;
  if (req.headers.has('range')) return;
  e.respondWith(handle(req));
});

async function handle(req) {
  var cache = await caches.open(CACHE);
  var hit = await cache.match(req, { ignoreSearch: true });
  var net = fetch(req).then(function (res) {
    if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(function () {});
    return res;
  });
  if (!hit) {
    try { return await net; }
    catch (err) {
      if (req.mode === 'navigate') { var home = await cache.match(SCOPE); if (home) return home; }
      throw err;
    }
  }
  /* A kept copy exists: if the network is down or very slow, use it. */
  return Promise.race([
    net.catch(function () { return hit; }),
    new Promise(function (resolve) { setTimeout(function () { resolve(hit); }, 6000); })
  ]);
}
