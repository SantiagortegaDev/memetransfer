import { getVisionEngine } from "./vision.js";
import { START, END } from "./symbols.js";
import { SymbolStream } from "./matcher.js";
import { createAssemblyState, advanceAssembly } from "./frame-assembler.js";

// Cada tick corre deteccion de bordes + ORB + matcheo contra las 258
// imagenes de referencia (ver js/vision.js) - mucho mas caro que comparar
// contra un marcador propio, asi que el intervalo es mas largo que en el
// diseno anterior. Se mide en la practica con performance.now() (ver
// onDebug) y se ajusta si hace falta.
export const TICK_MS = 280;
export const STABLE_TICKS_REQUIRED = 2;

// Tiempo maximo SIN un simbolo nuevo confirmado antes de cancelar (no el
// tiempo total del mensaje). Se reinicia con cada byte/marcador recibido.
export const PER_SYMBOL_TIMEOUT_MS = 6000;

/**
 * Orquesta la recepcion: para cada frame de camara, corre el pipeline de
 * js/vision.js (aislar la pantalla por contornos+homografia, extraer
 * features ORB, retrieve-and-rerank contra las 258 imagenes de referencia
 * con BFMatcher+RANSAC) para identificar cual imagen se esta mostrando,
 * sin necesitar ningun marcador visual superpuesto - reconoce el meme tal
 * cual.
 */
export class Receiver {
  constructor({ videoEl, tickMs = TICK_MS, onProgress, onError, onSuccess, onDebug, onEngineLoading }) {
    this.videoEl = videoEl;
    this.tickMs = tickMs;
    this.onProgress = onProgress;
    this.onError = onError;
    this.onSuccess = onSuccess;
    this.onDebug = onDebug;
    this.onEngineLoading = onEngineLoading;

    this.symbolStream = new SymbolStream({ stableTicksRequired: STABLE_TICKS_REQUIRED });
    this.assemblyState = createAssemblyState();

    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });

    this.engine = null;
    this.intervalId = null;
    this.timeoutId = null;
    this.rvfcId = null;
    this.usingRvfc = false;
    this.lastTickAt = 0;
    this.stopped = false;
  }

  /**
   * Carga el motor de vision (OpenCV.js + descriptores de referencia, ver
   * js/vision.js - cacheado a nivel de modulo, asi que solo pesa la
   * primera vez) y arranca el loop de muestreo.
   */
  async start() {
    this.symbolStream.reset();
    this.assemblyState = createAssemblyState();
    this.lastTickAt = 0;
    this.stopped = false;

    this.onEngineLoading?.(true);
    try {
      this.engine = await getVisionEngine({ onProgress: (stage) => this.onEngineLoading?.(true, stage) });
    } catch (err) {
      this.onEngineLoading?.(false);
      this.onError?.("engine-load-failed");
      return;
    }
    this.onEngineLoading?.(false);
    if (this.stopped) return; // se detuvo mientras cargaba el motor

    if (typeof this.videoEl.requestVideoFrameCallback === "function") {
      this.usingRvfc = true;
      const loop = (now) => {
        if (this.stopped) return;
        if (now - this.lastTickAt >= this.tickMs) {
          this.lastTickAt = now;
          this._tick();
        }
        this.rvfcId = this.videoEl.requestVideoFrameCallback(loop);
      };
      this.rvfcId = this.videoEl.requestVideoFrameCallback(loop);
    } else {
      this.usingRvfc = false;
      this.intervalId = setInterval(() => this._tick(), this.tickMs);
    }
  }

  stop() {
    this.stopped = true;
    if (this.usingRvfc && this.rvfcId !== null) {
      this.videoEl.cancelVideoFrameCallback?.(this.rvfcId);
      this.rvfcId = null;
    }
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this._clearTimeout();
  }

  _clearTimeout() {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  _armTimeout() {
    this._clearTimeout();
    this.timeoutId = setTimeout(() => {
      this.stop();
      this.symbolStream.reset();
      this.assemblyState = createAssemblyState();
      this.onError?.("timeout");
    }, PER_SYMBOL_TIMEOUT_MS);
  }

  _tick() {
    const vw = this.videoEl.videoWidth || this.videoEl.width;
    const vh = this.videoEl.videoHeight || this.videoEl.height;
    if (!vw || !vh) return;
    this.canvas.width = vw;
    this.canvas.height = vh;
    this.ctx.drawImage(this.videoEl, 0, 0, vw, vh);
    const imageData = this.ctx.getImageData(0, 0, vw, vh);

    const t0 = performance.now();
    const result = this.engine.match(imageData);
    const elapsedMs = performance.now() - t0;

    let observedValue = null;
    let category = null;
    if (result.index === "start") {
      observedValue = START;
      category = START;
    } else if (result.index === "end") {
      observedValue = END;
      category = END;
    } else if (result.index !== null) {
      observedValue = result.index;
      category = "MATCH";
    } else if (result.cornersFound) {
      category = "UNMATCHED";
    }

    this.onDebug?.({
      category,
      decodedIndex: category === "MATCH" ? result.index : null,
      inliers: result.inliers,
      cornersFound: result.cornersFound,
      elapsedMs,
      canvas: this.canvas,
    });

    const event = this.symbolStream.tick(observedValue);
    if (!event) return;

    const { state, done } = advanceAssembly(this.assemblyState, event);
    this.assemblyState = state;

    if (state.receiving) {
      this._armTimeout();
      this.onProgress?.(state.buffer.length, null);
    }

    if (done) {
      this.stop();
      if (done.ok) {
        this.onSuccess?.(done.text);
      } else {
        this.onError?.(done.error);
      }
    }
  }
}
