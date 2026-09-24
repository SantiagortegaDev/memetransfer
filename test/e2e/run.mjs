// Pruebas de navegador (Playwright + Chromium headless) de la cadena completa:
//
//   1. Emisor: la pagina dibuja el marco magenta y avanza los memes.
//   2. Receptor con "Cargar video": un video sintetico (training/make_video.py)
//      de una transmision se analiza cuadro a cuadro y tiene que decodificar
//      el texto exacto.
//   3. Receptor con camara: Chrome usa el mismo video como camara falsa
//      (--use-file-for-fake-video-capture) y decodifica en tiempo real.
//   4. Sin errores en la consola en ningun caso.
//
// Uso:  npm run e2e            (genera los videos si no existen; necesita
//                               Python con training/requirements.txt)
//       PYTHON=/ruta/python npm run e2e
//       E2E_ONLY=video npm run e2e

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname, join, resolve } from "node:path";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const OUT = join(ROOT, "test-results");
const PY = process.env.PYTHON ?? "python3";
const ONLY = process.env.E2E_ONLY;
const TEXT = process.env.E2E_TEXT ?? "https://github.com/santiagortegadev/memetransfer ¡funciona!";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webm": "video/webm",
};

function serve() {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p.endsWith("/")) p += "index.html";
      const file = join(ROOT, p);
      if (!file.startsWith(ROOT)) throw new Error("fuera de la raiz");
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

function makeVideo(name, args) {
  const webm = join(OUT, `${name}.webm`);
  const mjpeg = join(OUT, `${name}.mjpeg`);
  if (!existsSync(webm) || !existsSync(mjpeg)) {
    console.log(`generando ${name} (training/make_video.py)…`);
    execFileSync(PY, [join(ROOT, "training/make_video.py"), ...args, "--webm", webm, "--mjpeg", mjpeg, "--truth", join(OUT, `${name}.json`)], {
      cwd: join(ROOT, "training"),
      stdio: ["ignore", "inherit", "inherit"],
    });
  }
  return { webm, mjpeg };
}

function watchConsole(page, errors) {
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
}

const results = [];
async function check(name, fn) {
  if (ONLY && !name.startsWith(ONLY)) return;
  const t = Date.now();
  try {
    const info = await fn();
    results.push({ name, ok: true, info, s: (Date.now() - t) / 1000 });
    console.log(`✔ ${name} (${((Date.now() - t) / 1000).toFixed(1)} s) ${info ?? ""}`);
  } catch (err) {
    results.push({ name, ok: false, info: err.message, s: (Date.now() - t) / 1000 });
    console.log(`✘ ${name}: ${err.message}`);
  }
}

await mkdir(OUT, { recursive: true });
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/?nosw`;
const video = makeVideo("e2e-message", ["--text", TEXT, "--passes", "2.3", "--start-offset", "0.4", "--difficulty", "0.5", "--seed", "7"]);

// ---------------------------------------------------------------- 1. emisor
await check("sender", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errors = [];
  watchConsole(page, errors);
  await page.goto(base);
  await page.fill("#message-input", "hola");
  await page.click("#btn-transmit");
  await page.waitForFunction(() => /Pasada 1/.test(document.getElementById("stage-info").textContent), null, { timeout: 10000 });
  await page.waitForTimeout(1200);
  const px = await page.evaluate(() => {
    const c = document.getElementById("stage-canvas");
    const ctx = c.getContext("2d");
    const side = Math.round(0.92 * Math.min(c.width, c.height));
    const x = Math.round((c.width - side) / 2);
    const y = Math.round((c.height - side) / 2);
    const b = Math.round(side * 0.06);
    return {
      frame: [...ctx.getImageData(x + b / 2, y + side / 2, 1, 1).data],
      outside: [...ctx.getImageData(2, 2, 1, 1).data],
      info: document.getElementById("stage-info").textContent,
    };
  });
  await page.screenshot({ path: join(OUT, "sender.png") });
  await page.click("#btn-stop");
  await browser.close();
  if (px.frame[0] !== 255 || px.frame[1] !== 0 || px.frame[2] !== 170) throw new Error(`el marco no es magenta: ${px.frame}`);
  if (px.outside.slice(0, 3).some((v) => v !== 0)) throw new Error(`el fondo no es negro: ${px.outside}`);
  if (errors.length) throw new Error(errors.join("\n"));
  return px.info;
});

// ---------------------------------------------------------------- 2. receptor con archivo de video
await check("video-file", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  watchConsole(page, errors);
  await page.goto(base);
  await page.click("#tab-receive");
  await page.click(".debug summary");
  await page.check("#chk-debug");
  await page.setInputFiles("#video-file", video.webm);
  await page.waitForSelector("#rx-result:not(.hidden)", { timeout: 300000 });
  const got = await page.textContent("#rx-text");
  const meta = await page.textContent("#rx-result-meta");
  const log = await page.evaluate(() => {
    const l = window.__memetransfer.debugLog;
    return { frames: l.frames.length, slots: l.slots.length, inferMs: l.frames.filter((f) => f.inferMs).reduce((s, f, _, a) => s + f.inferMs / a.length, 0) };
  });
  await page.screenshot({ path: join(OUT, "receiver-video.png"), fullPage: true });
  await browser.close();
  if (got !== TEXT) throw new Error(`texto distinto: ${JSON.stringify(got)}`);
  if (errors.length) throw new Error(errors.join("\n"));
  return `${meta} · ${log.frames} frames, ${log.slots} slots, modelo ${log.inferMs.toFixed(1)} ms/frame`;
});

// ---------------------------------------------------------------- 3. receptor con camara (falsa)
await check("camera", async () => {
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${video.mjpeg}`],
  });
  const context = await browser.newContext();
  await context.grantPermissions(["camera"]);
  const page = await context.newPage();
  const errors = [];
  watchConsole(page, errors);
  await page.goto(base);
  await page.click("#tab-receive");
  await page.click("#btn-camera");
  await page.waitForSelector("#rx-result:not(.hidden)", { timeout: 240000 });
  const got = await page.textContent("#rx-text");
  const perfText = await page.textContent("#rx-perf");
  await page.screenshot({ path: join(OUT, "receiver-camera.png"), fullPage: true });
  await browser.close();
  if (got !== TEXT) throw new Error(`texto distinto: ${JSON.stringify(got)}`);
  if (errors.length) throw new Error(errors.join("\n"));
  return perfText;
});

// ---------------------------------------------------------------- 4. calibracion con video (opcional, ~5 min)
if (process.env.E2E_CALIBRATION || ONLY === "calibration") {
  await check("calibration", async () => {
    const cal = join(OUT, "calibration.webm");
    if (!existsSync(cal)) {
      execFileSync(PY, [join(ROOT, "training/make_video.py"), "--calibration", "--speed", "rapido", "--passes", "1.05", "--fps", "15", "--seed", "21", "--webm", cal, "--truth", join(OUT, "calibration.json")], {
        cwd: join(ROOT, "training"),
        stdio: ["ignore", "inherit", "inherit"],
      });
    }
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    watchConsole(page, errors);
    await page.goto(base);
    await page.click("#tab-calibrate");
    await page.setInputFiles("#cal-video-file", cal);
    await page.waitForFunction(() => /Video analizado/.test(document.getElementById("cal-model-status").textContent), null, { timeout: 900000 });
    const s = await page.evaluate(() => window.__memetransfer.cal.cal.summary());
    await page.screenshot({ path: join(OUT, "calibration.png"), fullPage: true });
    await browser.close();
    if (errors.length) throw new Error(errors.join("\n"));
    if (s.classesSeen < 250 || s.precisionAccepted < 0.98) throw new Error(JSON.stringify(s));
    return JSON.stringify(s);
  });
}

server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} OK`);
process.exit(failed.length ? 1 : 0);
