// Cache-first para que, tras la primera visita, la pagina y los 256 memes
// carguen al instante incluso con conexion mala. Sube CACHE_VERSION si
// cambian los assets estaticos para invalidar el cache viejo - y actualiza
// tambien el numero visible en el <h1> de index.html, asi el usuario puede
// confirmar a simple vista que su telefono ya cargo la version nueva.
const CACHE_VERSION = "v9";
const CACHE_NAME = `memetransfer-${CACHE_VERSION}`;

// OpenCV.js (vendor/opencv.js, ~10MB) y las referencias precalculadas
// (memes/features.bin, ~5MB) quedan afuera a proposito: son pesadas y solo
// las necesita quien recibe, asi que se cachean solas la primera vez que se
// piden (ver el handler de "fetch" mas abajo), sin bloquear ni demorar la
// instalacion del service worker para quien solo va a enviar.
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
  "js/frame-assembler.js",
  "js/protocol.js",
  "js/crc8.js",
  "js/symbols.js",
  "js/vision.js",
  "js/opencv-loader.js",
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
