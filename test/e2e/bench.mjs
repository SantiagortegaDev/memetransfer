// Benchmark sintetico de la prueba final del plan: mensajes de 10, 50 y 150
// caracteres, "buena luz" (dificultad 0.3) y "luz media / angulo" (0.8).
// Cada video (training/make_video.py) arranca a mitad de una pasada, como
// cuando el receptor empieza a apuntar tarde. El receptor lo analiza en modo
// "Cargar video" a 15 frames/s; se mide cuanto video hizo falta para
// decodificar (= tiempo desde que se apunta la camara) y cuantas pasadas.
//
// Uso: PYTHON=/ruta/python node test/e2e/bench.mjs

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname, join, resolve } from "node:path";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const OUT = join(ROOT, "test-results", "bench");
const PY = process.env.PYTHON ?? "python3";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".jpg": "image/jpeg", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const MESSAGES = {
  10: "hola mundo",
  50: "https://github.com/santiagortegadev/memetransfer!!",
  150: "Meme Transfer v2: cada meme vale un byte, Reed-Solomon corrige los que se leen mal y el loop junta votos de varias pasadas. ¡Probemos con 150 chars!!!",
};
const LEVELS = { buena: 0.3, media: 0.8 };
const SPEED = process.env.SPEED ?? "normal";
const PERIOD = { lento: 900, normal: 650, rapido: 430 }[SPEED];

const server = createServer(async (req, res) => {
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
const base = `http://127.0.0.1:${server.address().port}/?nosw`;
await mkdir(OUT, { recursive: true });

const rows = [];
const browser = await chromium.launch();
for (const [len, text] of Object.entries(MESSAGES)) {
  for (const [level, difficulty] of Object.entries(LEVELS)) {
    const bytes = new TextEncoder().encode(text).length;
    const name = `msg${len}-${level}-${SPEED}`;
    const webm = join(OUT, `${name}.webm`);
    if (!existsSync(webm)) {
      execFileSync(PY, [join(ROOT, "training/make_video.py"), "--text", text, "--speed", SPEED, "--passes", "3.3", "--start-offset", "0.37", "--fps", "15", "--difficulty", String(difficulty), "--seed", String(Number(len) + Math.round(difficulty * 10)), "--webm", webm], {
        cwd: join(ROOT, "training"),
        stdio: ["ignore", "ignore", "inherit"],
      });
    }
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(base);
    await page.click("#tab-receive");
    await page.click(".debug summary");
    await page.check("#chk-debug");
    await page.setInputFiles("#video-file", webm);
    const ok = await page
      .waitForFunction(() => !document.getElementById("rx-result").classList.contains("hidden") || /Video analizado/.test(document.getElementById("rx-model-status").textContent), null, { timeout: 1800000 })
      .then(() => true)
      .catch(() => false);
    const r = await page.evaluate(() => {
      const l = window.__memetransfer.debugLog;
      const res = window.__memetransfer.lastResult;
      const frames = l.frames;
      return {
        text: res?.text ?? null,
        corrected: res?.corrected ?? null,
        videoSeconds: frames.length ? frames[frames.length - 1].t / 1000 : 0,
        frames: frames.length,
        acceptedFrames: frames.filter((f) => f.cls !== null && f.cls !== 258).length,
        memeFrames: frames.filter((f) => !f.gap).length,
        erasedSlots: l.slots.filter((s) => s.cls === null).length,
        slots: l.slots.length,
      };
    });
    await page.close();
    const symbols = Number(await (async () => {
      // largo de la transmision: START + codeword + END
      const { codewordLength } = await import("../../js/protocol.js");
      return codewordLength(bytes) + 2;
    })());
    const passSeconds = (symbols * PERIOD) / 1000;
    const row = {
      mensaje: `${len} chars (${bytes} B)`,
      luz: level,
      ok: ok && r.text === text && !errors.length,
      segundos: +r.videoSeconds.toFixed(1),
      pasadas: +(r.videoSeconds / passSeconds).toFixed(2),
      "s/pasada": +passSeconds.toFixed(1),
      "RS recuperó": r.corrected,
      "slots borrados": `${r.erasedSlots}/${r.slots}`,
      "frames aceptados": `${((100 * r.acceptedFrames) / Math.max(1, r.memeFrames)).toFixed(0)}%`,
      errores: errors.length ? errors.join(" | ").slice(0, 120) : "",
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}
await browser.close();
server.close();
await writeFile(join(OUT, `bench-${SPEED}.json`), JSON.stringify(rows, null, 1));
console.table(rows);
