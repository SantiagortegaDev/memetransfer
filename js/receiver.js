import { phash, HASH_SIZE, hammingDistance, rgbaToGrayscale } from "./phash.js";
import { dhash } from "./dhash.js";
import { classifyFrame, analyzeBrightness, START, END, TEXTURED } from "./classify.js";
import { SymbolStream } from "./matcher.js";
import { createAssemblyState, advanceAssembly } from "./frame-assembler.js";

// Distancia Hamming maxima para aceptar un match de meme (sobre hashes de 99
// bits). Ver docs/superpowers/specs para como se midio. Los marcadores de
// inicio/fin YA NO dependen de este umbral: se detectan por brillo
// (js/classify.js), mucho mas robusto a desenfoque y mal encuadre - pero
// OJO, este umbral tambien decide si una pausa gris/fondo plano puede
// "colarse" como match de meme por error: medido, una pantalla plana
// (blanco/negro/gris) esta a >=34 bits de CUALQUIERA de los 256 memes con
// el pipeline de resize actual (un solo resize directo, ver dictionary.js).
// Se probo un pipeline de resize "simetrico" con la camara para intentar
// arreglar unos memes de bajo contraste que necesitaban un umbral mayor,
// pero eso bajaba ese margen de 49 a 34 - con MATCH_THRESHOLD=40 la pausa
// gris terminaba matcheando como meme por error. Revertido: se prioriza
// nunca confundir un fondo plano con un meme por sobre reconocer el
// puñado de memes de bajo contraste que quedan afuera (ver spec).
export const MATCH_THRESHOLD = 32;
export const TICK_MS = 120;
export const STABLE_TICKS_REQUIRED = 3;

// Si el 2do mejor candidato por pHash queda a esta distancia o menos del
// mejor, se considera ambiguo y se desempata con dHash (ver bestMatch).
export const AMBIGUITY_MARGIN = 6;

// Tiempo maximo SIN un simbolo nuevo confirmado antes de cancelar (no el
// tiempo total del mensaje). Se reinicia con cada byte/marcador recibido.
export const PER_SYMBOL_TIMEOUT_MS = 5000;

// Que fraccion central del frame de camara se analiza, ignorando el borde
// (bisel de pantalla, fondo) que siempre aparece alrededor del meme en una
// captura real. Debe coincidir con el inset de .camera-guide en style.css.
export const CAPTURE_CROP_FRACTION = 0.8;

const SAMPLE_SIZE = HASH_SIZE * 4;

/**
 * Busca la entrada del diccionario mas parecida por pHash. Si el segundo
 * mejor candidato queda muy cerca del primero (caso ambiguo), desempata
 * comparando dHash en vez del pHash: el dHash tiene mucha peor separacion
 * global entre los 256 memes (medido: 4 bits minimos sobre 64, contra 28
 * sobre 100 del pHash) para servir de clasificador principal, pero es una
 * senal independiente util para resolver un empate puntual entre dos
 * candidatos ya identificados.
 * @param {bigint} hash pHash del frame capturado
 * @param {bigint} dHashValue dHash del frame capturado
 * @param {{hash: bigint, dhash: bigint}[]} dictionary
 */
export function bestMatch(hash, dHashValue, dictionary) {
  let best = null;
  let bestDistance = Infinity;
  let second = null;
  let secondDistance = Infinity;

  for (const entry of dictionary) {
    const distance = hammingDistance(hash, entry.hash);
    if (distance < bestDistance) {
      second = best;
      secondDistance = bestDistance;
      best = entry;
      bestDistance = distance;
    } else if (distance < secondDistance) {
      second = entry;
      secondDistance = distance;
    }
  }

  if (second && secondDistance - bestDistance <= AMBIGUITY_MARGIN) {
    const dBest = hammingDistance(dHashValue, best.dhash);
    const dSecond = hammingDistance(dHashValue, second.dhash);
    if (dSecond < dBest) {
      return { entry: second, distance: secondDistance };
    }
  }

  return { entry: best, distance: bestDistance };
}

/**
 * Orquesta la recepcion: samplea el centro de la camara, clasifica cada
 * frame (marcador START/END, pausa, o candidato a meme), resuelve los
 * candidatos a meme via bestMatch, y ensambla los simbolos confirmados en
 * un mensaje via frame-assembler.
 */
export class Receiver {
  constructor({
    dictionary,
    videoEl,
    matchThreshold = MATCH_THRESHOLD,
    tickMs = TICK_MS,
    cropFraction = CAPTURE_CROP_FRACTION,
    onProgress,
    onError,
    onSuccess,
    onDebug,
  }) {
    this.dictionary = dictionary;
    this.videoEl = videoEl;
    this.matchThreshold = matchThreshold;
    this.tickMs = tickMs;
    this.cropFraction = cropFraction;
    this.onProgress = onProgress;
    this.onError = onError;
    this.onSuccess = onSuccess;
    this.onDebug = onDebug;

    this.symbolStream = new SymbolStream({ stableTicksRequired: STABLE_TICKS_REQUIRED });
    this.assemblyState = createAssemblyState();

    this.canvas = document.createElement("canvas");
    this.canvas.width = SAMPLE_SIZE;
    this.canvas.height = SAMPLE_SIZE;
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
   * compuesto, en vez de un timer a ciegas que puede caer sobre un frame
   * repetido o a mitad de una transicion. El analisis en si sigue corriendo
   * como maximo cada `tickMs` (se throttlea dentro del callback) para no
   * tocar la calibracion de estabilidad/umbral, pensada para esa cadencia.
   * Si no hay soporte (u videoEl es un canvas, como en los tests), cae a
   * setInterval.
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

  /** Dibuja solo la porcion central del frame (ignora el borde de encuadre real). */
  _drawCroppedSample() {
    const vw = this.videoEl.videoWidth || this.videoEl.width;
    const vh = this.videoEl.videoHeight || this.videoEl.height;
    const cropW = vw * this.cropFraction;
    const cropH = vh * this.cropFraction;
    const sx = (vw - cropW) / 2;
    const sy = (vh - cropH) / 2;
    this.ctx.drawImage(this.videoEl, sx, sy, cropW, cropH, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    return this.ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  }

  _tick() {
    const { data } = this._drawCroppedSample();

    // El match contra el diccionario se intenta SIEMPRE primero, sin
    // importar el brillo del frame: algunos memes reales son casi blancos o
    // casi negros (bajo contraste), y un flash sintetico de inicio/fin esta
    // a distancia ~49 de CUALQUIERA de los 256 memes (medido, muy por
    // encima de MATCH_THRESHOLD) - asi que nunca hay riesgo de confundir un
    // flash real con un meme. Si se chequeara el brillo primero, esos memes
    // de bajo contraste nunca llegarian a compararse contra el diccionario.
    const hash = phash(data, SAMPLE_SIZE, SAMPLE_SIZE, HASH_SIZE);
    const dHashValue = dhash(data, SAMPLE_SIZE, SAMPLE_SIZE);
    const { entry: bestEntry, distance: bestDistance } = bestMatch(hash, dHashValue, this.dictionary);
    const memeMatched = bestEntry && bestDistance <= this.matchThreshold;

    let category;
    let mean;
    let stdev;
    let observedValue;
    if (memeMatched) {
      category = TEXTURED;
      observedValue = bestEntry.index;
      ({ mean, stdev } = analyzeBrightness(rgbaToGrayscale(data)));
    } else {
      const gray = rgbaToGrayscale(data);
      ({ category, mean, stdev } = classifyFrame(gray));
      observedValue = category === START || category === END ? category : null;
    }

    this.onDebug?.({
      category,
      mean,
      stdev,
      bestFilename: bestEntry?.filename ?? null,
      bestDistance,
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
