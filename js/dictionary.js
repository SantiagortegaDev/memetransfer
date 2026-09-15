// Ya no hace falta un hash de referencia por meme: cada imagen (generada
// por scripts/generate_markers.py) lleva su propio byte codificado en el
// marcador (ver js/marker.js), asi que el receptor lo lee directamente de
// la foto sin comparar contra nada. El "diccionario" es simplemente el
// emisor precargando las 256 imagenes para poder mostrarlas al instante.
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    img.src = src;
  });
}

/**
 * Precarga las 256 imagenes con marcador (memes/marked/0.jpg .. 255.jpg).
 * @param {{onProgress?: (loaded: number, total: number) => void}} options
 * @returns {Promise<{index: number, image: HTMLImageElement}[]>}
 */
export async function loadDictionary({ onProgress } = {}) {
  const total = 256;
  const entries = new Array(total);
  for (let index = 0; index < total; index++) {
    const image = await loadImage(`memes/marked/${index}.jpg`);
    entries[index] = { index, image };
    onProgress?.(index + 1, total);
  }
  return entries;
}
