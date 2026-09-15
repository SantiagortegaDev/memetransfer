export const FRAME_MS = 700; // cuanto se muestra cada meme
export const GAP_MS = 150; // pausa gris corta entre memes
// Duracion del flash blanco (inicio) y negro (fin). Mas largo que el resto
// de los tiempos a proposito: un cambio brusco de brillo dispara el
// auto-exposure/autofocus de una camara real, que tarda un rato en
// estabilizarse; un flash mas largo aumenta las chances de que los frames
// que confirman el marcador (los ultimos de la ventana estable) ya esten
// bien expuestos.
export const MARKER_MS = 900;

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
 * Reproduce una trama de bytes como secuencia de memes en pantalla,
 * encerrada entre un flash blanco (inicio) y uno negro (fin) que el
 * receptor detecta por brillo, sin depender de reconocer ningun meme.
 * @param {object} params
 * @param {{index:number, image:HTMLImageElement}[]} params.dictionary
 * @param {Uint8Array} params.frame
 * @param {() => void} params.showBlank pausa gris entre memes
 * @param {() => void} params.showStart flash blanco de inicio
 * @param {() => void} params.showEnd flash negro de fin
 * @param {(image: HTMLImageElement) => void} params.showMeme
 * @param {(shown: number, total: number) => void} [params.onProgress]
 * @param {AbortSignal} [params.signal]
 */
export async function playFrame({
  dictionary,
  frame,
  showBlank,
  showStart,
  showEnd,
  showMeme,
  onProgress,
  signal,
}) {
  showStart();
  await sleep(MARKER_MS, signal);
  showBlank();
  await sleep(GAP_MS, signal);

  for (let i = 0; i < frame.length; i++) {
    const byte = frame[i];
    const entry = dictionary[byte];
    showMeme(entry.image);
    await sleep(FRAME_MS, signal);
    showBlank();
    onProgress?.(i + 1, frame.length);
    await sleep(GAP_MS, signal);
  }

  showEnd();
  await sleep(MARKER_MS, signal);
  showBlank();
}
