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
 * Precarga las 256 imagenes de datos con marcador (memes/marked/0.jpg ..
 * 255.jpg) mas las 2 imagenes de control (start.jpg, end.jpg) que delimitan
 * la transmision.
 * @param {{onProgress?: (loaded: number, total: number) => void}} options
 * @returns {Promise<{memes: {index: number, image: HTMLImageElement}[], startImage: HTMLImageElement, endImage: HTMLImageElement}>}
 */
export async function loadDictionary({ onProgress } = {}) {
  const memeCount = 256;
  const total = memeCount + 2;
  let loaded = 0;
  const memes = new Array(memeCount);
  for (let index = 0; index < memeCount; index++) {
    const image = await loadImage(`memes/marked/${index}.jpg`);
    memes[index] = { index, image };
    onProgress?.(++loaded, total);
  }
  const startImage = await loadImage("memes/marked/start.jpg");
  onProgress?.(++loaded, total);
  const endImage = await loadImage("memes/marked/end.jpg");
  onProgress?.(++loaded, total);
  return { memes, startImage, endImage };
}
