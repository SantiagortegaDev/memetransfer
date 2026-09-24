// Service worker: la app funciona offline despues de la primera visita.
//  - Precache al instalar: la pagina, el codigo, ONNX Runtime y el modelo.
//  - Cache-first en tiempo de ejecucion para todo lo demas (los memes se
//    cachean a medida que se usan; Calibrar los baja todos).
// Subir CACHE_VERSION junto con APP_VERSION (js/main.js) cuando cambian los assets.
const CACHE_VERSION = "v2.0.1";
const CACHE_NAME = `memetransfer-${CACHE_VERSION}`;

const CORE = [
  "./",
  "index.html",
  "style.css",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "js/main.js",
  "js/protocol.js",
  "js/rs.js",
  "js/sender.js",
  "js/camera.js",
  "js/layout.js",
  "js/locator.js",
  "js/homography.js",
  "js/frame-reader.js",
  "js/classifier.js",
  "js/segmenter.js",
  "js/receiver.js",
  "js/calibration.js",
  "lib/ort/ort.wasm.min.mjs",
  "lib/ort/ort-wasm-simd-threaded.mjs",
  "lib/ort/ort-wasm-simd-threaded.wasm",
  "model/labels.json",
  "model/memes.onnx",
  "memes/manifest.json",
  "memes/control-start.jpg",
  "memes/control-end.jpg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("memetransfer-") && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
    )
  );
});
