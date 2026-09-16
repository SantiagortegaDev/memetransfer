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
 * encerrada entre el marcador de inicio y el de fin (las mismas imagenes
 * con esquinas+firma que un byte de datos, solo que con la firma de
 * control) para que el receptor los detecte con el mismo mecanismo robusto,
 * sin depender de un flash de brillo de pantalla completa.
 * @param {object} params
 * @param {HTMLImageElement} params.startImage
 * @param {HTMLImageElement} params.endImage
 * @param {{index:number, image:HTMLImageElement}[]} params.dictionary
 * @param {Uint8Array} params.frame
 * @param {() => void} params.showBlank pausa gris entre memes
 * @param {(image: HTMLImageElement) => void} params.showMeme
 * @param {(shown: number, total: number) => void} [params.onProgress]
 * @param {AbortSignal} [params.signal]
 */
export async function playFrame({
  startImage,
  endImage,
  dictionary,
  frame,
  showBlank,
  showMeme,
  onProgress,
  signal,
}) {
  showMeme(startImage);
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

  showMeme(endImage);
  await sleep(MARKER_MS, signal);
  showBlank();
}
