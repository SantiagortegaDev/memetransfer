// Clasificador de memes: ONNX Runtime Web (backend WASM con SIMD).
//
// El modelo (model/memes.onnx) recibe RGB en [0,1], NCHW float32, de
// size x size (labels.json dice el tamano) y devuelve 259 logits:
// 0-255 bytes, 256 START, 257 END, 258 NONE. La normalizacion de ImageNet
// esta dentro del grafo.

import * as ort from "../lib/ort/ort.wasm.min.mjs";
import { ACCEPT_P, ACCEPT_MARGIN } from "./layout.js";
import { NONE } from "./protocol.js";

export class Classifier {
  constructor(session, meta) {
    this.session = session;
    this.meta = meta;
    this.size = meta.input_size;
    this.input = new Float32Array(3 * this.size * this.size);
    this.inputName = session.inputNames[0];
    this.outputName = session.outputNames[0];
  }

  /**
   * @param {string} baseUrl carpeta del modelo (con memes.onnx y labels.json)
   * @param {(msg: string) => void} [onStatus]
   */
  static async load(baseUrl = new URL("../model/", import.meta.url).href, onStatus) {
    ort.env.wasm.wasmPaths = new URL("../lib/ort/", import.meta.url).href;
    // Sin COOP/COEP (GitHub Pages) no hay SharedArrayBuffer: un solo hilo.
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    onStatus?.("Cargando etiquetas…");
    const meta = await (await fetch(new URL("labels.json", baseUrl))).json();
    onStatus?.("Cargando modelo…");
    const buf = await (await fetch(new URL(meta.model ?? "memes.onnx", baseUrl))).arrayBuffer();
    onStatus?.("Iniciando ONNX Runtime…");
    const session = await ort.InferenceSession.create(buf, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    const c = new Classifier(session, meta);
    await c.classify({ data: new Uint8ClampedArray(c.size * c.size * 4), width: c.size, height: c.size }); // calentamiento
    return c;
  }

  /**
   * @param {{data: Uint8ClampedArray, width: number, height: number}} crop RGBA size x size
   * @returns {Promise<{top1: number, p1: number, top2: number, p2: number, margin: number, accepted: boolean, probs: Float32Array, ms: number}>}
   */
  async classify(crop) {
    const S = this.size;
    if (crop.width !== S || crop.height !== S) throw new RangeError(`el recorte tiene que ser ${S}x${S}`);
    const t0 = performance.now();
    const x = this.input;
    const d = crop.data;
    const plane = S * S;
    for (let p = 0, i = 0; p < plane; p++, i += 4) {
      x[p] = d[i] / 255;
      x[plane + p] = d[i + 1] / 255;
      x[2 * plane + p] = d[i + 2] / 255;
    }
    const tensor = new ort.Tensor("float32", x, [1, 3, S, S]);
    const out = await this.session.run({ [this.inputName]: tensor });
    const logits = out[this.outputName].data;
    const probs = softmax(logits);
    let top1 = 0;
    let top2 = 1;
    if (probs[1] > probs[0]) [top1, top2] = [1, 0];
    for (let k = 2; k < probs.length; k++) {
      if (probs[k] > probs[top1]) {
        top2 = top1;
        top1 = k;
      } else if (probs[k] > probs[top2]) top2 = k;
    }
    const p1 = probs[top1];
    const p2 = probs[top2];
    return {
      top1,
      p1,
      top2,
      p2,
      margin: p1 - p2,
      accepted: p1 >= ACCEPT_P && p1 - p2 >= ACCEPT_MARGIN,
      probs,
      ms: performance.now() - t0,
    };
  }

  label(cls) {
    return this.meta.classes?.[cls] ?? String(cls);
  }
}

export function softmax(logits) {
  let mx = -Infinity;
  for (const v of logits) if (v > mx) mx = v;
  const out = new Float32Array(logits.length);
  let s = 0;
  for (let i = 0; i < logits.length; i++) {
    out[i] = Math.exp(logits[i] - mx);
    s += out[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= s;
  return out;
}

export { NONE };
