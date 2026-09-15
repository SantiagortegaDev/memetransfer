import { phash, HASH_SIZE, hammingDistance } from "./phash.js";
import { SymbolStream } from "./matcher.js";
import { createAssemblyState, advanceAssembly } from "./frame-assembler.js";

// Distancia Hamming maxima para aceptar un match (sobre hashes de 99 bits).
// Medido en el navegador (ver docs/superpowers/specs): incluso con encuadre
// perfecto, pasar la imagen por un canvas intermedio (como hace una captura
// de camara real) ya cuesta ~4 bits de distancia contra el hash precalculado
// del diccionario; un 5% de borde/mal encuadre alrededor del meme sube eso a
// 18-30 bits segun el meme, aunque el meme correcto siguio siendo, en todas
// las pruebas, el mas cercano del diccionario (bestMatch nunca fallo por
// debajo de ~35 bits de distancia). La separacion minima real entre dos
// memes del diccionario es 28 bits (hash_size=10): un umbral por encima de
// eso ya no rechaza objetos random del entorno con tanta certeza, pero un
// decode erroneo lo atrapa igual el CRC-8 final (ver protocol.js) y el
// usuario simplemente reintenta. MATCH_THRESHOLD=32 prioriza tolerar el mal
// encuadre de una camara real; es el primer valor a recalibrar durante las
// pruebas manuales con hardware real (ver README).
export const MATCH_THRESHOLD = 32;
export const TICK_MS = 120;
export const STABLE_TICKS_REQUIRED = 3;
export const LONG_GAP_TICKS_REQUIRED = 5;
// Tiempo maximo SIN un simbolo nuevo confirmado antes de cancelar (no el
// tiempo total del mensaje: un mensaje largo tarda mucho mas que esto en
// llegar completo, pero cada simbolo individual deberia llegar mucho antes).
// Se reinicia con cada byte recibido, asi escala solo con mensajes largos en
// vez de cortar una transmision real a mitad de camino.
export const PER_SYMBOL_TIMEOUT_MS = 5000;

const SAMPLE_SIZE = HASH_SIZE * 4;

/** Busca la entrada del diccionario mas parecida a un hash dado. */
export function bestMatch(hash, dictionary) {
  let best = null;
  let bestDistance = Infinity;
  for (const entry of dictionary) {
    const distance = hammingDistance(hash, entry.hash);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry;
    }
  }
  return { entry: best, distance: bestDistance };
}

/**
 * Orquesta la recepcion: samplea la camara a intervalos regulares, resuelve
 * cada frame a un simbolo (o gap) via bestMatch + SymbolStream, y ensambla
 * los simbolos confirmados en un mensaje via frame-assembler.
 */
export class Receiver {
  constructor({
    dictionary,
    videoEl,
    matchThreshold = MATCH_THRESHOLD,
    tickMs = TICK_MS,
    onProgress,
    onError,
    onSuccess,
  }) {
    this.dictionary = dictionary;
    this.videoEl = videoEl;
    this.matchThreshold = matchThreshold;
    this.tickMs = tickMs;
    this.onProgress = onProgress;
    this.onError = onError;
    this.onSuccess = onSuccess;

    this.symbolStream = new SymbolStream({
      stableTicksRequired: STABLE_TICKS_REQUIRED,
      longGapTicksRequired: LONG_GAP_TICKS_REQUIRED,
    });
    this.assemblyState = createAssemblyState();

    this.canvas = document.createElement("canvas");
    this.canvas.width = SAMPLE_SIZE;
    this.canvas.height = SAMPLE_SIZE;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });

    this.intervalId = null;
    this.timeoutId = null;
  }

  start() {
    this.symbolStream.reset();
    this.assemblyState = createAssemblyState();
    this.intervalId = setInterval(() => this._tick(), this.tickMs);
  }

  stop() {
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

  _sampleHash() {
    this.ctx.drawImage(this.videoEl, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const { data } = this.ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    return phash(data, SAMPLE_SIZE, SAMPLE_SIZE, HASH_SIZE);
  }

  _tick() {
    const hash = this._sampleHash();
    const { entry, distance } = bestMatch(hash, this.dictionary);
    const observedIndex = entry && distance <= this.matchThreshold ? entry.index : null;

    const event = this.symbolStream.tick(observedIndex);
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
