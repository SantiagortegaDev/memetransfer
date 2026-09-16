import { rgbaToGrayscale } from "./grayscale.js";
import { findCornerMarkers, readMarkerBits, readControlMarker } from "./marker.js";
import { SymbolStream } from "./matcher.js";
import { createAssemblyState, advanceAssembly } from "./frame-assembler.js";

export const TICK_MS = 120;
export const STABLE_TICKS_REQUIRED = 3;

// Tiempo maximo SIN un simbolo nuevo confirmado antes de cancelar (no el
// tiempo total del mensaje). Se reinicia con cada byte/marcador recibido.
export const PER_SYMBOL_TIMEOUT_MS = 5000;

// Resolucion de trabajo a la que se reduce cada frame de camara antes de
// buscar el marcador (ver js/marker.js). No hace falta que preserve el
// aspecto original: la homografia no le pide nada a la escala, solo a que
// las 4 esquinas encontradas sean consistentes entre si.
export const WORKING_SIZE = 240;

/**
 * Orquesta la recepcion: reduce cada frame de camara a una resolucion de
 * trabajo, busca el marcador (4 esquinas), y si lo encuentra intenta leerlo
 * primero como byte de datos y, si eso falla, como marcador de control
 * (inicio/fin de transmision) - ambos usan exactamente el mismo mecanismo
 * de esquinas+firma, solo cambia que firma se exige.
 */
export class Receiver {
  constructor({ videoEl, tickMs = TICK_MS, onProgress, onError, onSuccess, onDebug }) {
    this.videoEl = videoEl;
    this.tickMs = tickMs;
    this.onProgress = onProgress;
    this.onError = onError;
    this.onSuccess = onSuccess;
    this.onDebug = onDebug;

    this.symbolStream = new SymbolStream({ stableTicksRequired: STABLE_TICKS_REQUIRED });
    this.assemblyState = createAssemblyState();

    this.canvas = document.createElement("canvas");
    this.canvas.width = WORKING_SIZE;
    this.canvas.height = WORKING_SIZE;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });

    this.intervalId = null;
    this.timeoutId = null;
    this.rvfcId = null;
    this.usingRvfc = false;
    this.lastTickAt = 0;
  }

  /**
   * Arranca el loop de muestreo. Si el navegador soporta
   * requestVideoFrameCallback (Chrome/Android, Safari 16.4+) se usa para
   * garantizar que cada analisis parte de un frame de camara real y recien
   * compuesto. El analisis en si sigue corriendo como maximo cada `tickMs`
   * (se throttlea dentro del callback). Si no hay soporte (o videoEl es un
   * canvas, como en los tests), cae a setInterval.
   */
  start() {
    this.symbolStream.reset();
    this.assemblyState = createAssemblyState();
    this.lastTickAt = 0;

    if (typeof this.videoEl.requestVideoFrameCallback === "function") {
      this.usingRvfc = true;
      const loop = (now) => {
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
    this.ctx.drawImage(this.videoEl, 0, 0, vw, vh, 0, 0, WORKING_SIZE, WORKING_SIZE);
    const { data } = this.ctx.getImageData(0, 0, WORKING_SIZE, WORKING_SIZE);
    const gray = rgbaToGrayscale(data);

    const corners = findCornerMarkers(gray, WORKING_SIZE, WORKING_SIZE);
    let decodedByte = null;
    let controlMarker = null;
    if (corners) {
      decodedByte = readMarkerBits(gray, WORKING_SIZE, WORKING_SIZE, corners);
      if (decodedByte === null) {
        controlMarker = readControlMarker(gray, WORKING_SIZE, WORKING_SIZE, corners);
      }
    }

    const observedValue = decodedByte !== null ? decodedByte : controlMarker;
    // "UNREADABLE": se encontraron esquinas (algo con la forma de un
    // marcador) pero ni los datos ni la firma de control coincidieron - util
    // para diagnosticar en el log de debug, distinto de "no hay nada".
    const category = decodedByte !== null ? "MARKER" : controlMarker ? controlMarker : corners ? "UNREADABLE" : null;

    this.onDebug?.({
      category,
      decodedByte,
      cornersFound: !!corners,
      matched: observedValue !== null,
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
