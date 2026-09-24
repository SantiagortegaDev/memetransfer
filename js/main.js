// UI: pestanas Enviar / Recibir / Calibrar.

import { MAX_PAYLOAD, NONE, START, END, buildTransmission, codewordLength, encodeText } from "./protocol.js";
import { SPEEDS, play, loadImages, drawSymbol } from "./sender.js";
import { startCamera, stopCamera, nextVideoFrame, seekVideo } from "./camera.js";
import { FrameReader } from "./frame-reader.js";
import { Segmenter } from "./segmenter.js";
import { Receiver } from "./receiver.js";
import { Calibration, CALIBRATION_SEQUENCE } from "./calibration.js";

export const APP_VERSION = "2.0.0";

const $ = (id) => document.getElementById(id);
const state = { classifier: null, classFiles: null, rx: null, cal: null, session: null, debugLog: null };
window.__memetransfer = state; // para depurar desde la consola y para los tests de navegador

$("app-version").textContent = `v${APP_VERSION}`;

// ------------------------------------------------------------------ utilidades

async function classFiles() {
  if (!state.classFiles) {
    const manifest = await (await fetch("memes/manifest.json")).json();
    state.classFiles = [...manifest, "control-start.jpg", "control-end.jpg"];
  }
  return state.classFiles;
}

function classLabel(cls) {
  if (cls === null || cls === undefined) return "—";
  if (cls === START) return "INICIO";
  if (cls === END) return "FIN";
  if (cls === NONE) return "nada";
  const ch = cls >= 32 && cls < 127 ? ` «${String.fromCharCode(cls)}»` : "";
  return `byte ${cls}${ch}`;
}

async function getClassifier(statusEl) {
  if (state.classifier) return state.classifier;
  const { Classifier } = await import("./classifier.js");
  try {
    state.classifier = await Classifier.load(new URL("../model/", import.meta.url).href, (m) => (statusEl.textContent = m));
  } catch (err) {
    statusEl.textContent = "";
    throw new Error(`No se pudo cargar el modelo (model/memes.onnx): ${err.message}`);
  }
  statusEl.textContent = `Modelo listo (${state.classifier.meta.arch ?? "?"}, ${state.classifier.size}px).`;
  return state.classifier;
}

function download(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ------------------------------------------------------------------ pestanas

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab")) {
      const on = t === tab;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", String(on));
      $(t.dataset.panel).classList.toggle("hidden", !on);
    }
  });
}

// ------------------------------------------------------------------ enviar

const msgInput = $("message-input");
$("byte-max").textContent = MAX_PAYLOAD;

function updateSendInfo() {
  const bytes = encodeText(msgInput.value).length;
  const speed = SPEEDS[$("speed-select").value];
  const symbols = codewordLength(Math.min(bytes, MAX_PAYLOAD)) + 2;
  $("byte-count").textContent = bytes;
  $("symbol-count").textContent = symbols;
  $("pass-time").textContent = `${Math.round((symbols * (speed.symbolMs + speed.gapMs)) / 1000)} s`;
  const tooLong = bytes > MAX_PAYLOAD;
  $("send-error").textContent = tooLong ? `El mensaje ocupa ${bytes} bytes; el máximo es ${MAX_PAYLOAD}.` : "";
  $("send-error").classList.toggle("hidden", !tooLong);
  $("btn-transmit").disabled = bytes === 0 || tooLong;
}
msgInput.addEventListener("input", updateSendInfo);
$("speed-select").addEventListener("change", updateSendInfo);
updateSendInfo();

$("btn-transmit").addEventListener("click", async () => {
  const symbols = buildTransmission(encodeText(msgInput.value));
  const speed = SPEEDS[$("speed-select").value];
  await runStage(symbols, speed, ({ index, pass }) => `Pasada ${pass + 1} · meme ${index + 1}/${symbols.length}`);
});

// ------------------------------------------------------------------ escenario del emisor

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    else if (!on) {
      await wakeLock?.release();
      wakeLock = null;
    }
  } catch {
    // sin wake lock la pantalla puede apagarse: no es fatal
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && stageAbort && !wakeLock) keepAwake(true);
});

let stageAbort = null;

async function runStage(symbols, speed, info) {
  const files = await classFiles();
  const stage = $("stage");
  const canvas = $("stage-canvas");
  $("stage-info").textContent = "Cargando memes…";
  stage.classList.remove("hidden");
  const fit = () => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(stage.clientWidth * dpr);
    canvas.height = Math.round(stage.clientHeight * dpr);
  };
  fit();
  drawSymbol(canvas.getContext("2d"), null);
  try {
    await stage.requestFullscreen?.({ navigationUI: "hide" });
  } catch {
    // iPhone no permite pantalla completa de un div: el div fijo alcanza
  }
  fit();
  window.addEventListener("resize", fit);
  await keepAwake(true);
  const images = await loadImages(files, symbols);
  stageAbort = new AbortController();
  await play({
    canvas,
    symbols,
    imageFor: (c) => images.get(c),
    ...speed,
    signal: stageAbort.signal,
    onSymbol: (s) => ($("stage-info").textContent = info(s)),
  });
  window.removeEventListener("resize", fit);
  stage.classList.add("hidden");
  await keepAwake(false);
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  stageAbort = null;
}

$("btn-stop").addEventListener("click", () => stageAbort?.abort());
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && stageAbort) stageAbort.abort();
});

// ------------------------------------------------------------------ vision (camara o video)

/**
 * Corre el lector de frames sobre la camara o un archivo de video.
 * @returns {{stop: () => void, done: Promise<void>}}
 */
function startVision({ source, file, video, overlay, statusEl, onObs, fps = 15 }) {
  const ctl = new AbortController();
  let stream = null;
  const done = (async () => {
    const classifier = await getClassifier(statusEl);
    const reader = new FrameReader(classifier);
    if (source === "camera") {
      stream = await startCamera(video);
      while (!ctl.signal.aborted) {
        await nextVideoFrame(video);
        if (ctl.signal.aborted || !video.videoWidth) continue;
        const work = reader.grab(video, video.videoWidth, video.videoHeight);
        const obs = await reader.process(work, performance.now());
        if (!ctl.signal.aborted) onObs(obs, reader, video);
      }
    } else {
      video.srcObject = null;
      video.src = URL.createObjectURL(file);
      await new Promise((res, rej) => {
        video.onloadeddata = res;
        video.onerror = () => rej(new Error("No se pudo abrir el video (¿formato soportado por el navegador?)."));
      });
      const dur = video.duration;
      for (let t = 0; t < dur && !ctl.signal.aborted; t += 1 / fps) {
        await seekVideo(video, t);
        const work = reader.grab(video, video.videoWidth, video.videoHeight);
        const obs = await reader.process(work, t * 1000);
        onObs(obs, reader, video);
        statusEl.textContent = `Analizando video: ${Math.round((100 * t) / dur)}%`;
      }
      statusEl.textContent = ctl.signal.aborted ? "Video detenido." : "Video analizado.";
      URL.revokeObjectURL(video.src);
    }
  })().finally(() => stopCamera(stream));
  return {
    stop: () => {
      ctl.abort();
      stopCamera(stream);
    },
    done,
  };
}

function drawOverlay(overlay, video, obs) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w) return;
  if (overlay.width !== w || overlay.height !== h) {
    overlay.width = w;
    overlay.height = h;
  }
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  if (!obs.quad) return;
  const s = w / 640;
  ctx.lineWidth = Math.max(3, w / 200);
  ctx.strokeStyle = obs.gap ? "#aaaaaa" : obs.cls !== null ? "#3ddc84" : "#ffb020";
  ctx.beginPath();
  obs.quad.forEach(([x, y], i) => (i ? ctx.lineTo(x * s, y * s) : ctx.moveTo(x * s, y * s)));
  ctx.closePath();
  ctx.stroke();
}

function slimObs(obs) {
  return {
    t: Math.round(obs.t * 10) / 10,
    gap: obs.gap,
    cls: obs.cls,
    p: Math.round(obs.p * 1000) / 1000,
    top1: obs.top1,
    top2: obs.top2 ?? null,
    margin: Math.round(obs.margin * 1000) / 1000,
    status: obs.status,
    residual: Math.round(obs.residual * 100) / 100,
    ms: Math.round(obs.ms * 10) / 10,
    inferMs: Math.round(obs.inferMs * 10) / 10,
  };
}

const perf = { n: 0, ms: 0, infer: 0, last: 0, fps: 0 };
function trackPerf(obs) {
  const now = performance.now();
  if (perf.last) perf.fps = 0.9 * perf.fps + 0.1 * (1000 / Math.max(1, now - perf.last));
  perf.last = now;
  perf.ms = 0.9 * perf.ms + 0.1 * obs.ms;
  if (obs.inferMs) perf.infer = 0.9 * perf.infer + 0.1 * obs.inferMs;
  if (++perf.n % 10 === 0) $("rx-perf").textContent = `${perf.fps.toFixed(1)} frames/s · ${perf.ms.toFixed(0)} ms por frame · modelo ${perf.infer.toFixed(0)} ms`;
}

// ------------------------------------------------------------------ recibir

const rxVideo = $("rx-video");
const rxOverlay = $("rx-overlay");
const cropCtx = $("rx-crop").getContext("2d");

function newReceiveState() {
  const rx = new Receiver();
  const log = $("chk-debug").checked ? { version: APP_VERSION, userAgent: navigator.userAgent, started: new Date().toISOString(), frames: [], slots: [], result: null } : null;
  state.debugLog = log ?? state.debugLog;
  const seg = new Segmenter({
    onSlot: (slot) => {
      if (log) log.slots.push({ ...slot });
      const res = rx.pushSlot(slot);
      renderSlots(rx);
      if (res) showResult(res);
    },
  });
  state.rx = { rx, seg, log };
  return state.rx;
}

function renderSlots(rx) {
  const pass = rx.currentPass;
  const n = rx.expectedLength;
  const el = $("rx-slots");
  const syms = pass?.symbols ?? [];
  const total = Math.max(n, syms.length);
  el.replaceChildren(
    ...Array.from({ length: total }, (_, i) => {
      const d = document.createElement("div");
      d.className = "slot" + (i < syms.length ? (syms[i] === null ? " erased" : " read") : "");
      d.textContent = i < syms.length ? (syms[i] === null ? "?" : "✓") : "";
      return d;
    })
  );
  const passes = rx.passes.length;
  const erased = syms.filter((s) => s === null).length;
  $("rx-status").textContent = pass
    ? `${pass.hasStart ? "Pasada en curso" : "Enganchado a mitad de pasada"} · ${syms.length}/${n || "?"} memes · ${erased} dudosos · ${passes} pasadas guardadas`
    : "Esperando el meme de INICIO…";
}

function showResult(res) {
  $("rx-text").textContent = res.text;
  const links = $("rx-links");
  links.replaceChildren();
  for (const m of res.text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const a = document.createElement("a");
    a.href = m[0];
    a.textContent = m[0];
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    const p = document.createElement("p");
    p.append(a);
    links.append(p);
  }
  $("rx-result-meta").textContent = `${res.payload.length} bytes · ${res.corrected} símbolos corregidos por Reed-Solomon`;
  $("rx-result").classList.remove("hidden");
  if (state.rx?.log) state.rx.log.result = { text: res.text, corrected: res.corrected, n: res.n };
  state.lastResult = res;
  stopReceive();
}

function stopReceive() {
  state.session?.stop();
  state.session = null;
  state.rx?.seg.flush();
  $("btn-camera").textContent = "Activar cámara";
}

function startReceive(source, file) {
  stopReceive();
  $("rx-result").classList.add("hidden");
  const { seg, log } = newReceiveState();
  renderSlots(state.rx.rx);
  $("btn-camera").textContent = "Detener";
  state.session = startVision({
    source,
    file,
    video: rxVideo,
    overlay: rxOverlay,
    statusEl: $("rx-model-status"),
    fps: Number($("video-fps").value),
    onObs: (obs) => {
      drawOverlay(rxOverlay, rxVideo, obs);
      cropCtx.putImageData(new ImageData(downsample(obs.crop, 64), 64, 64), 0, 0);
      $("rx-label").textContent = obs.gap ? "(gap)" : obs.cls !== null ? classLabel(obs.cls) : "?";
      $("rx-conf").textContent = obs.gap ? "" : `${classLabel(obs.top1)} · p=${obs.p.toFixed(2)}`;
      $("rx-hint").textContent =
        obs.status === "cut" ? "El marco se sale de la imagen: aleja un poco el teléfono." : obs.status === "none" ? "No veo el marco magenta." : "";
      $("rx-hint").classList.toggle("hidden", obs.status === "ok");
      const s = slimObs(obs);
      if (log) log.frames.push(s);
      trackPerf(obs);
      seg.push(s);
    },
  });
  state.session.done.catch((err) => {
    $("rx-status").textContent = err.message;
    stopReceive();
  });
  state.session.done.then(() => {
    if (source === "video") seg.flush();
  });
}

function downsample(crop, size) {
  const out = new Uint8ClampedArray(size * size * 4);
  const f = crop.width / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (Math.floor(y * f) * crop.width + Math.floor(x * f)) * 4;
      out.set(crop.data.subarray(i, i + 4), (y * size + x) * 4);
    }
  }
  return out;
}

$("btn-camera").addEventListener("click", () => {
  if (state.session) stopReceive();
  else startReceive("camera");
});
$("video-file").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) startReceive("video", file);
  e.target.value = "";
});
$("btn-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("rx-text").textContent);
    $("btn-copy").textContent = "¡Copiado!";
    setTimeout(() => ($("btn-copy").textContent = "Copiar"), 1500);
  } catch {
    $("btn-copy").textContent = "No se pudo copiar";
  }
});
$("btn-rx-reset").addEventListener("click", () => startReceive("camera"));
$("btn-log-export").addEventListener("click", () => {
  if (!state.debugLog) return alert("Activa «Guardar log de cada frame» antes de recibir.");
  download(`memetransfer-log-${Date.now()}.json`, state.debugLog);
});

// ------------------------------------------------------------------ calibrar

$("btn-cal-show").addEventListener("click", async () => {
  const speed = SPEEDS[$("speed-select").value];
  await runStage(CALIBRATION_SEQUENCE, speed, ({ index, pass }) => `Calibración · pasada ${pass + 1} · ${classLabel(CALIBRATION_SEQUENCE[index])}`);
});

function startCalibration(source, file) {
  stopCalibration();
  const cal = new Calibration();
  const frames = [];
  const seg = new Segmenter({
    keepFrames: true,
    onSlot: (slot) => {
      cal.pushSlot(slot);
      renderCalibration(cal);
    },
  });
  state.cal = { cal, seg, frames };
  $("cal-viewer").classList.remove("hidden");
  state.calSession = startVision({
    source,
    file,
    video: $("cal-video"),
    overlay: $("cal-overlay"),
    statusEl: $("cal-model-status"),
    fps: Number($("video-fps").value),
    onObs: (obs) => {
      drawOverlay($("cal-overlay"), $("cal-video"), obs);
      const s = slimObs(obs);
      frames.push(s);
      seg.push(s);
    },
  });
  state.calSession.done
    .then(() => {
      seg.flush();
      renderCalibration(cal);
    })
    .catch((err) => ($("cal-model-status").textContent = err.message));
}

function stopCalibration() {
  state.calSession?.stop();
  state.calSession = null;
  state.cal?.seg.flush();
}

const pct = (v) => (v === null ? "—" : `${(100 * v).toFixed(1)}%`);

async function renderCalibration(cal) {
  const s = cal.summary();
  $("cal-slots").textContent = s.slots;
  $("cal-seen").textContent = `${s.classesSeen} / 258`;
  $("cal-slot-acc").textContent = pct(s.slotAccuracy);
  $("cal-precision").textContent = pct(s.precisionAccepted);
  $("cal-false").textContent = pct(s.falseAcceptRate);
  $("cal-accept").textContent = pct(s.acceptRate);
  const files = await classFiles();
  const problems = cal.problems();
  const list = $("cal-problems");
  if (!problems.length) {
    list.innerHTML = '<li class="meta">Todavía nada.</li>';
    return;
  }
  list.replaceChildren(
    ...problems.map((p) => {
      const li = document.createElement("li");
      const img = document.createElement("img");
      img.src = `memes/${files[p.cls]}`;
      img.alt = "";
      li.append(img, `${classLabel(p.cls)}: ${pct(p.slotAccuracy)} slots, ${pct(p.precision)} precisión`);
      if (p.confusions.length) li.append(` · se confunde con ${p.confusions.map((c) => classLabel(c.cls)).join(", ")}`);
      return li;
    })
  );
}

$("btn-cal-measure").addEventListener("click", () => startCalibration("camera"));
$("cal-video-file").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) startCalibration("video", file);
  e.target.value = "";
});
$("btn-cal-stop").addEventListener("click", stopCalibration);
$("btn-cal-export").addEventListener("click", () => {
  if (!state.cal) return;
  download(`memetransfer-calibracion-${Date.now()}.json`, {
    version: APP_VERSION,
    userAgent: navigator.userAgent,
    summary: state.cal.cal.summary(),
    perClass: state.cal.cal.perClass,
    problems: state.cal.cal.problems(258),
    frames: state.cal.frames,
  });
});

// ------------------------------------------------------------------ PWA

if ("serviceWorker" in navigator && !new URLSearchParams(location.search).has("nosw")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
