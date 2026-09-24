// Prueba de la app como PWA offline:
//  1. carga la pagina CON el service worker y espera a que precachee todo
//  2. corta la red, recarga y decodifica un video: tiene que andar offline
//
// Sin argumentos usa un servidor local (127.0.0.1 es contexto seguro, el SW
// funciona igual que en GitHub Pages). Con una URL prueba ese sitio (hace
// falta que el navegador confie en su certificado).
//
// Uso: node test/e2e/live.mjs [url|local] [video.webm] [texto esperado]
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm", ".jpg": "image/jpeg", ".png": "image/png" };
let server = null;
let URL_ = process.argv[2] && process.argv[2] !== "local" ? process.argv[2] : null;
if (!URL_) {
  server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p.endsWith("/")) p += "index.html";
      const body = await readFile(join(ROOT, p));
      res.writeHead(200, { "content-type": TYPES[extname(p)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  URL_ = `http://127.0.0.1:${server.address().port}/`;
}
const VIDEO = process.argv[3] ?? new URL("../../test-results/e2e-message.webm", import.meta.url).pathname;
const TEXT = process.argv[4] ?? "https://github.com/santiagortegadev/memetransfer ¡funciona!";
const proxy = !server && process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;

const browser = await chromium.launch({ proxy });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(URL_);
const version = await page.textContent("#app-version");
// (waitForFunction no espera predicados async: se sondea con evaluate)
const swReady = () =>
  page.evaluate(async () => {
    // el SW controla la pagina y termino de precachear (addAll es atomico)
    if (!navigator.serviceWorker.controller) return false;
    const k = (await caches.keys()).find((x) => x.startsWith("memetransfer-"));
    if (!k) return false;
    const c = await caches.open(k);
    return (await c.keys()).length >= 20 && !!(await c.match("model/memes.onnx"));
  });
for (let t0 = Date.now(); !(await swReady()); await page.waitForTimeout(1000)) {
  if (Date.now() - t0 > 180000) throw new Error("el service worker no termino de precachear");
}
const cached = await page.evaluate(async () => {
  const k = (await caches.keys()).find((x) => x.startsWith("memetransfer-"));
  return { cache: k, entries: (await (await caches.open(k)).keys()).length };
});
console.log(`online: ${version}, service worker activo, cache ${cached.cache} con ${cached.entries} archivos`);

await context.setOffline(true);
await page.reload();
await page.click("#tab-receive");
await page.setInputFiles("#video-file", VIDEO);
await page.waitForSelector("#rx-result:not(.hidden)", { timeout: 600000 });
const got = await page.textContent("#rx-text");
console.log(`offline: decodificado ${JSON.stringify(got)}`);
await browser.close();
server?.close();
if (got !== TEXT || errors.length) {
  console.log("FALLO", errors);
  process.exit(1);
}
console.log(`OK: la PWA (${server ? "servidor local" : URL_}) funciona sin conexion`);
