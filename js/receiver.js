// Receptor: identifica memes por su contenido visual usando pHash en vez
// del viejo sistema de marcadores (esquinas + tira de bits).
//
// Para cada frame de camara:
//   1. Se re-dibuja el frame en un canvas chico (32x32) en escala de grises.
//   2. Se calcula el pHash (DCT-II 2D -> 256 bits, ver js/phash.js).
//   3. Se compara contra los pHashes pre-calculados de los 256 memes y las
//      2 imagenes de control (start, end). La distancia de Hamming minima
//      decide: si esta debajo del umbral, se reporta ese byte/START/END.
//   4. SymbolStream + FrameAssembler (sin cambios) se encargan de filtrar
//      ruido y armar la trama completa con CRC.
//
// Tolerancia a desalineacion: el receptor prueba multiples combinaciones
// de (escala, offset X, offset Y, rotacion) por cada frame de camara,
// porque el usuario no encuadra el meme perfectamente en el centro del
// frame, ni lo mantiene derecho, ni lo acerca al mismo zoom. Cada
// combinacion se llama una "ventana de busqueda" y se queda con el mejor
// match de todas las ventanas probadas.

import { computePHash, hashFromImageData, hammingDistance, PHASH_INPUT_SIZE } from "./phash.js";
import { SymbolStream } from "./matcher.js";
import { createAssemblyState, advanceAssembly } from "./frame-assembler.js";
import { START, END } from "./marker.js";

export const TICK_MS = 120;
export const STABLE_TICKS_REQUIRED = 3;

// Tiempo maximo SIN un simbolo nuevo confirmado antes de cancelar.
export const PER_SYMBOL_TIMEOUT_MS = 5000;

// Resolucion de trabajo para redimensionar cada frame de camara antes de
// hashear. Debe coincidir con PHASH_INPUT_SIZE (32). El pHash usa solo
// las frecuencias bajas de la DCT-II 2D, que sobreviven perfectamente a
// un downscale a 32x32.
export const WORKING_SIZE = PHASH_INPUT_SIZE;

// Umbral de distancia de Hamming: cuantos bits pueden diferir entre el
// frame y la imagen de referencia para que se considere un match. 256 bits
// totales. La distancia minima entre dos memes distintos del diccionario
// es ~84 bits (ver scripts/test_phash.js), asi que 60 deja un margen de
// 24 bits contra falsos positivos. La distorsion tipica de camara
// (auto-exposure, ligera perspectiva, leve blur, leves recortes, pequena
// rotacion de hasta ~8 grados) agrega 20-60 bits a la distancia, asi que
// 60 acepta la mayoria de los matches correctos. Si ves muchos falsos
// negativos en la practica, subir a 70. Si ves falsos positivos (meme mal
// identificado), bajar a 45.
export const MATCH_THRESHOLD = 60;

// Multi-escala: el receptor prueba varias "ventanas" de recorte del frame
// de camara, no solo el cuadrado central completo. Esto compensa que el
// meme no llene exactamente todo el frame (el usuario lo alinea
// aproximadamente con la guia visual, pero suele haber un borde oscuro
// alrededor). Cada escala es una fraccion del lado del frame; el receptor
// prueba cada una y se queda con el mejor match.
export const MATCH_SCALES = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5];

// Offsets de busqueda: para cada escala, prueba varios offsets centrados
// en (0, 0). Cada offset es una fraccion del lado del frame. El receptor
// prueba una grilla de 3x3 offsets (incluido el 0,0 = centro exacto).
// Esto compensa que el meme no este perfectamente centrado en el frame,
// que es el caso mas comun en uso real.
export const MATCH_OFFSETS = [-0.08, 0, 0.08];

// Rotaciones de busqueda: el receptor prueba varias rotaciones pequenas
// para compensar que el telefono del receptor no este perfectamente
// derecho respecto a la pantalla del emisor. pHash no es invariante a
// rotacion, asi que necesitamos probar varias. Cada rotacion se aplica al
// frame completo ANTES de recortar (mas eficiente que rotar despues del
// crop, y mas preciso porque no se pierde informacion por interpolacion
// multiple).
export const MATCH_ROTATIONS_DEG = [-5, -2.5, 0, 2.5, 5];

/**
 * Orquesta la recepcion: por cada frame de camara calcula el pHash y lo
 * compara contra el diccionario. El match mas cercano (si esta debajo
 * del umbral) se reporta como byte/START/END.
 */
export class Receiver {
  /**
   * @param {object} params
   * @param {HTMLVideoElement} params.videoEl
   * @param {{index:number, image:HTMLImageElement, hash:Uint8Array}[]} params.dictionary 256 memes con su pHash
   * @param {Uint8Array} params.startHash pHash de memes/start.jpg
   * @param {Uint8Array} params.endHash pHash de memes/end.jpg
   * @param {number} [params.tickMs]
   * @param {number} [params.threshold] distancia de Hamming maxima para matchear
   * @param {(shown:number, total:number|null) => void} [params.onProgress]
   * @param {(text:string) => void} [params.onSuccess]
   * @param {(error:string) => void} [params.onError]
   * @param {(info:object) => void} [params.onDebug]
   */
  constructor({
    videoEl,
    dictionary,
    startHash,
    endHash,
    tickMs = TICK_MS,
    threshold = MATCH_THRESHOLD,
    onProgress,
    onError,
    onSuccess,
    onDebug,
  }) {
    this.videoEl = videoEl;
    this.dictionary = dictionary;
    this.startHash = startHash;
    this.endHash = endHash;
    this.tickMs = tickMs;
    this.threshold = threshold;
    this.onProgress = onProgress;
    this.onError = onError;
    this.onSuccess = onSuccess;
    this.onDebug = onDebug;

    this.symbolStream = new SymbolStream({ stableTicksRequired: STABLE_TICKS_REQUIRED });
    this.assemblyState = createAssemblyState();

    // Canvas de trabajo chico (32x32) donde se dibuja el crop final antes
    // de hashear.
    this.canvas = document.createElement("canvas");
    this.canvas.width = WORKING_SIZE;
    this.canvas.height = WORKING_SIZE;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });

    // Canvas mas grande para rotar el frame completo antes de recortarlo.
    // Tiene que ser al menos tan grande como el lado del frame de camara
    // (sqrt(2) * lado para que la diagonal de un frame rotado entre entera).
    // Lo creamos una sola vez y lo reusamos.
    this.rotateCanvas = document.createElement("canvas");
    this.rotateCanvas.width = 480;
    this.rotateCanvas.height = 480;
    this.rotateCtx = this.rotateCanvas.getContext("2d", { willReadFrequently: true });

    this.intervalId = null;
    this.timeoutId = null;
    this.rvfcId = null;
    this.usingRvfc = false;
    this.lastTickAt = 0;

    // Cache del mejor candidato entre ticks consecutivos, solo para
    // diagnostico en el panel de debug.
    this.lastBestMatch = null;
    this.lastBestDistance = 999;
  }

  /**
   * Arranca el loop de muestreo. Si el navegador soporta
   * requestVideoFrameCallback se usa para garantizar que cada analisis
   * parte de un frame de camara real recien compuesto. El analisis en si
   * sigue corriendo como maximo cada `tickMs`. Si no hay soporte cae a
   * setInterval.
   */
  start() {
    this.symbolStream.reset();
    this.assemblyState = createAssemblyState();
    this.lastTickAt = 0;
    this.lastBestMatch = null;
    this.lastBestDistance = 999;

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

  /**
   * Compara un hash contra todos los hashes del diccionario (256 memes +
   * start + end). Si encuentra uno mejor que el actual bestDistance,
   * actualiza bestValue/bestDistance/bestIdx.
   *
   * @returns {{value: number|string|null, distance: number, bestIdx: number|null, updated: boolean}}
   *   updated=true si mejoro el best en esta llamada (para diagnostico)
   */
  _compareHash(frameHash, bestValue, bestDistance, bestIdx) {
    // Chequea start/end primero
    const distStart = hammingDistance(frameHash, this.startHash);
    if (distStart < bestDistance) {
      bestDistance = distStart;
      bestValue = START;
      bestIdx = -1;
    }
    const distEnd = hammingDistance(frameHash, this.endHash);
    if (distEnd < bestDistance) {
      bestDistance = distEnd;
      bestValue = END;
      bestIdx = -2;
    }

    // Despues los memes
    for (let i = 0; i < this.dictionary.length; i++) {
      const d = hammingDistance(frameHash, this.dictionary[i].hash);
      if (d < bestDistance) {
        bestDistance = d;
        bestValue = i;
        bestIdx = i;
      }
    }

    return { value: bestValue, distance: bestDistance, bestIdx };
  }

  /**
   * Busca el mejor match del pHash del frame actual contra todos los
   * hashes del diccionario (256 memes + start + end). Devuelve:
   *   - { value: number } si matcheo un meme (byte 0-255)
   *   - { value: "START" } si matcheo start.jpg
   *   - { value: "END" } si matcheo end.jpg
   *   - null si ninguno estuvo debajo del umbral
   * Tambien devuelve la distancia del mejor candidato (para diagnostico).
   *
   * Busqueda exhaustiva: para cada combinacion de
   * (rotacion, escala, offsetX, offsetY) hace un crop del frame de camara,
   * lo hashea, y compara contra el diccionario. El mejor match de todas
   * las combinaciones gana.
   *
   * Total de combinaciones: 5 rotaciones x 4 escalas x 3 offsets x 3 offsets
   * = 180 hashes por frame. Cada hash toma ~0.5ms (DCT 32x32 + 256
   * distancias de Hamming), asi que ~90ms por frame. Con TICK_MS=120ms
   * sigue siendo real-time.
   *
   * @returns {{value: number|string|null, distance: number, bestIdx: number|null}}
   */
  _matchFrame() {
    const vw = this.videoEl.videoWidth || this.videoEl.width;
    const vh = this.videoEl.videoHeight || this.videoEl.height;
    if (!vw || !vh) return { value: null, distance: 999, bestIdx: null };

    let bestValue = null;
    let bestDistance = this.threshold + 1;
    let bestIdx = null;

    const minDim = Math.min(vw, vh);

    // Si el frame de camara es mas grande que el canvas de rotacion, lo
    // escalamos primero (rotar un frame enorme es caro y no aporta nada:
    // el pHash se calcula sobre un crop cuadrado chico).
    const maxSide = Math.min(this.rotateCanvas.width, vw, vh);
    const preScale = maxSide / Math.max(vw, vh);

    for (const rotDeg of MATCH_ROTATIONS_DEG) {
      // Dibuja el frame rotado en el rotateCanvas. La rotacion es sobre
      // el centro del canvas, no del frame. Como el canvas es cuadrado y
      // el frame es rectangular, primero lo escalamos para que el lado
      // mayor entre entero.
      this.rotateCtx.save();
      this.rotateCtx.fillStyle = "#000000";
      this.rotateCtx.fillRect(0, 0, this.rotateCanvas.width, this.rotateCanvas.height);
      this.rotateCtx.translate(this.rotateCanvas.width / 2, this.rotateCanvas.height / 2);
      if (rotDeg !== 0) {
        this.rotateCtx.rotate((rotDeg * Math.PI) / 180);
      }
      const dw = vw * preScale;
      const dh = vh * preScale;
      this.rotateCtx.drawImage(this.videoEl, -dw / 2, -dh / 2, dw, dh);
      this.rotateCtx.restore();

      // Ahora buscamos dentro del rotateCanvas (que ya tiene el frame
      // rotado). El "minDim" en este canvas es menor que el original
      // porque escalamos.
      const rMinDim = Math.min(this.rotateCanvas.width, this.rotateCanvas.height);

      for (const scale of MATCH_SCALES) {
        const side = Math.round(rMinDim * scale);
        if (side < 32) continue;
        const baseX = (this.rotateCanvas.width - side) / 2;
        const baseY = (this.rotateCanvas.height - side) / 2;

        for (const offsetX of MATCH_OFFSETS) {
          for (const offsetY of MATCH_OFFSETS) {
            const sx = baseX + side * offsetX;
            const sy = baseY + side * offsetY;
            // Recorta y dibuja al canvas chico de 32x32
            this.ctx.drawImage(
              this.rotateCanvas,
              sx,
              sy,
              side,
              side,
              0,
              0,
              WORKING_SIZE,
              WORKING_SIZE
            );
            const { data } = this.ctx.getImageData(0, 0, WORKING_SIZE, WORKING_SIZE);
            const frameHash = hashFromImageData(data);

            const result = this._compareHash(frameHash, bestValue, bestDistance, bestIdx);
            bestValue = result.value;
            bestDistance = result.distance;
            bestIdx = result.bestIdx;
          }
        }
      }
    }

    if (bestValue === null) {
      return { value: null, distance: bestDistance === this.threshold + 1 ? 999 : bestDistance, bestIdx };
    }
    return { value: bestValue, distance: bestDistance, bestIdx };
  }

  _tick() {
    const match = this._matchFrame();
    const observedValue = match.value;

    this.lastBestMatch = match.value;
    this.lastBestDistance = match.distance;

    // Categoria para el panel de debug
    let category = null;
    if (observedValue === START) category = "START";
    else if (observedValue === END) category = "END";
    else if (typeof observedValue === "number") category = "MARKER";
    else category = "GAP";

    this.onDebug?.({
      category,
      decodedByte: typeof observedValue === "number" ? observedValue : null,
      distance: match.distance,
      threshold: this.threshold,
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
