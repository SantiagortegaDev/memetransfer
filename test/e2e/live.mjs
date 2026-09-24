// Prueba del sitio publicado (GitHub Pages) como PWA:
//  1. carga la pagina con el service worker y espera a que precachee todo
//  2. corta la red, recarga y decodifica un video: tiene que andar offline
//
// Uso: node test/e2e/live.mjs [url] [video.webm] [texto esperado]
import { chromium } from "playwright";

const URL_ = process.argv[2] ?? "https://santiagortegadev.github.io/memetransfer/";
const VIDEO = process.argv[3] ?? new URL("../../test-results/e2e-message.webm", import.meta.url).pathname;
const TEXT = process.argv[4] ?? "https://github.com/santiagortegadev/memetransfer ¡funciona!";
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;

const browser = await chromium.launch({ proxy });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(URL_);
const version = await page.textContent("#app-version");
await page.waitForFunction(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg?.active) return false;
  const keys = await caches.keys();
  for (const k of keys) {
    const c = await caches.open(k);
    if (await c.match("model/memes.onnx")) return true;
  }
  return false;
}, null, { timeout: 180000, polling: 1000 });
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
if (got !== TEXT || errors.length) {
  console.log("FALLO", errors);
  process.exit(1);
}
console.log("OK: la PWA publicada funciona sin conexion");
