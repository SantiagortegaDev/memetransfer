// Procesa un frame (de la camara o de un video): localiza el marco,
// recorta el interior, detecta el gap gris y clasifica el meme.
// Devuelve la observacion que consume el segmentador.

import { locateFrame, cropInterior, centerCrop, gapResidual } from "./locator.js";
import { LOCATE_WIDTH, GAP_RESIDUAL_MAX, GAP_RESIDUAL_NONE_MAX } from "./layout.js";
import { NONE } from "./protocol.js";

// El frame de trabajo mide el doble del ancho del localizador: la imagen
// chica sale de promediar bloques de 2x2 (igual que cv2.INTER_AREA en el
// entrenamiento) y el recorte se toma de la grande.
export const WORK_WIDTH = 2 * LOCATE_WIDTH;

export function halve(img) {
  const w = img.width >> 1;
  const h = img.height >> 1;
  const src = img.data;
  const out = new Uint8ClampedArray(w * h * 4);
  const W = img.width;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (2 * y * W + 2 * x) * 4;
      const j = i + W * 4;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = (src[i + c] + src[i + 4 + c] + src[j + c] + src[j + 4 + c] + 2) >> 2;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

export class FrameReader {
  /** @param {import("./classifier.js").Classifier} classifier */
  constructor(classifier) {
    this.classifier = classifier;
    this.canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(WORK_WIDTH, WORK_WIDTH) : document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
  }

  /** Dibuja la fuente (video/imagen) en el canvas de trabajo y devuelve sus pixeles. */
  grab(source, srcWidth, srcHeight) {
    const w = WORK_WIDTH;
    let h = Math.round((w * srcHeight) / srcWidth);
    h -= h % 2;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = "high";
    this.ctx.drawImage(source, 0, 0, w, h);
    return this.ctx.getImageData(0, 0, w, h);
  }

  /**
   * @param {{data, width, height}} work imagen de trabajo (WORK_WIDTH de ancho)
   * @param {number} t tiempo del frame en ms
   */
  async process(work, t) {
    const t0 = performance.now();
    const small = halve(work);
    const { quad, status } = locateFrame(small);
    const size = this.classifier.size;
    const quadWork = quad ? quad.map(([x, y]) => [2 * x, 2 * y]) : null;
    const crop = quadWork ? cropInterior(work, quadWork, size) : centerCrop(work, size);
    const residual = gapResidual(crop);
    const obs = { t, status, quad: quadWork, residual, crop, gap: false, cls: null, p: 0, top1: null, margin: 0, inferMs: 0 };
    if (residual < GAP_RESIDUAL_MAX) {
      obs.gap = true;
    } else {
      const r = await this.classifier.classify(crop);
      obs.top1 = r.top1;
      obs.p = r.p1;
      obs.margin = r.margin;
      obs.top2 = r.top2;
      obs.inferMs = r.ms;
      if (r.top1 === NONE && r.p1 >= 0.5 && residual < GAP_RESIDUAL_NONE_MAX) obs.gap = true;
      else if (r.accepted) obs.cls = r.top1;
    }
    obs.ms = performance.now() - t0;
    return obs;
  }
}
