// Cache-first para que, tras la primera visita, la pagina y los 256 memes
// carguen al instante incluso con conexion mala. Sube CACHE_VERSION si
// cambian los assets estaticos para invalidar el cache viejo.
const CACHE_VERSION = "v3";
const CACHE_NAME = `memetransfer-${CACHE_VERSION}`;

const CORE_ASSETS = [
  "./",
  "index.html",
  "style.css",
  "js/main.js",
  "js/dictionary.js",
  "js/camera.js",
  "js/sender.js",
  "js/receiver.js",
  "js/matcher.js",
  "js/classify.js",
  "js/frame-assembler.js",
  "js/protocol.js",
  "js/crc8.js",
  "js/phash.js",
  "js/dhash.js",
  "memes/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
