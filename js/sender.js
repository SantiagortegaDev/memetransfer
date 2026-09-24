// Emisor: dibuja cada simbolo como un meme dentro de un marco magenta liso
// (sin datos: solo sirve para que el receptor lo ubique y recorte), con un
// gap gris entre simbolos, y repite la secuencia en loop hasta que se detiene.
//
// La temporizacion se engancha a requestAnimationFrame con el reloj real
// (performance.now), asi no acumula deriva como una cadena de setTimeout.

import { FRAME_COLOR, BORDER, OUTER_FRACTION, GAP_GRAY } from "./layout.js";

export const SPEEDS = {
  lento: { symbolMs: 700, gapMs: 200 },
  normal: { symbolMs: 500, gapMs: 150 },
  rapido: { symbolMs: 320, gapMs: 110 },
};

/** Geometria del cuadrado exterior del marco dentro de un canvas w x h. */
export function frameGeometry(w, h) {
  const side = Math.round(OUTER_FRACTION * Math.min(w, h));
  const b = Math.round(side * BORDER);
  const x = Math.round((w - side) / 2);
  const y = Math.round((h - side) / 2);
  return { x, y, side, border: b, inner: side - 2 * b };
}

/**
 * Dibuja un simbolo en el canvas.
 * @param {CanvasRenderingContext2D} ctx
 * @param {CanvasImageSource|null} image meme a mostrar, o null para el gap gris
 */
export function drawSymbol(ctx, image) {
  const { width: w, height: h } = ctx.canvas;
  const g = frameGeometry(w, h);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = FRAME_COLOR;
  ctx.fillRect(g.x, g.y, g.side, g.side);
  const ix = g.x + g.border;
  const iy = g.y + g.border;
  if (image) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // estirado a proposito: el modelo se entrena con el meme deformado al cuadrado
    ctx.drawImage(image, ix, iy, g.inner, g.inner);
  } else {
    ctx.fillStyle = `rgb(${GAP_GRAY},${GAP_GRAY},${GAP_GRAY})`;
    ctx.fillRect(ix, iy, g.inner, g.inner);
  }
}

/**
 * Reproduce la secuencia en loop.
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas
 * @param {number[]} o.symbols clases a mostrar (0-257)
 * @param {(cls: number) => CanvasImageSource} o.imageFor
 * @param {number} o.symbolMs
 * @param {number} o.gapMs
 * @param {boolean} [o.loop=true]
 * @param {(info: {index: number, pass: number, symbol: number|null}) => void} [o.onSymbol]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<void>} se resuelve al detener (o al terminar si loop=false)
 */
export function play({ canvas, symbols, imageFor, symbolMs, gapMs, loop = true, onSymbol, signal }) {
  const ctx = canvas.getContext("2d");
  const period = symbolMs + gapMs;
  const total = symbols.length * period;
  return new Promise((resolve) => {
    let start = null;
    let lastKey = null;
    const frame = (now) => {
      if (signal?.aborted) return resolve();
      if (start === null) start = now;
      const elapsed = now - start;
      if (!loop && elapsed >= total) {
        drawSymbol(ctx, null);
        return resolve();
      }
      const pass = Math.floor(elapsed / total);
      const inPass = elapsed - pass * total;
      const index = Math.min(symbols.length - 1, Math.floor(inPass / period));
      const isGap = inPass - index * period >= symbolMs;
      const key = `${pass}:${index}:${isGap}`;
      if (key !== lastKey) {
        lastKey = key;
        const sym = isGap ? null : symbols[index];
        drawSymbol(ctx, sym === null ? null : imageFor(sym));
        onSymbol?.({ index, pass, symbol: sym });
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/** Carga las imagenes de las clases pedidas. files[cls] = nombre de archivo. */
export async function loadImages(files, classes, baseUrl = new URL("../memes/", import.meta.url).href) {
  const out = new Map();
  await Promise.all(
    [...new Set(classes)].map(async (cls) => {
      const img = new Image();
      img.decoding = "async";
      img.src = new URL(files[cls], baseUrl).href;
      await img.decode();
      out.set(cls, img);
    })
  );
  return out;
}
