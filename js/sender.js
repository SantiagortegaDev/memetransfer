export const FRAME_MS = 700; // cuanto se muestra cada meme
export const GAP_MS = 150; // pausa gris corta entre memes
export const ATTENTION_GAP_MS = 800; // pausa gris larga al arrancar (senal de "inicio real")

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

/**
 * Reproduce una trama de bytes como secuencia de memes en pantalla.
 * @param {object} params
 * @param {{index:number, image:HTMLImageElement}[]} params.dictionary
 * @param {Uint8Array} params.frame
 * @param {() => void} params.showBlank
 * @param {(image: HTMLImageElement) => void} params.showMeme
 * @param {(shown: number, total: number) => void} [params.onProgress]
 * @param {AbortSignal} [params.signal]
 */
export async function playFrame({ dictionary, frame, showBlank, showMeme, onProgress, signal }) {
  showBlank();
  await sleep(ATTENTION_GAP_MS, signal);

  for (let i = 0; i < frame.length; i++) {
    const byte = frame[i];
    const entry = dictionary[byte];
    showMeme(entry.image);
    await sleep(FRAME_MS, signal);
    showBlank();
    onProgress?.(i + 1, frame.length);
    if (i < frame.length - 1) {
      await sleep(GAP_MS, signal);
    }
  }
}
