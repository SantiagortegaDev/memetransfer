// El emisor precarga los memes originales (sin ningun marcador superpuesto
// - el receptor los reconoce directamente por su contenido, ver
// js/vision.js) mas las 2 imagenes de control que delimitan la
// transmision, para poder mostrarlas al instante.
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    img.src = src;
  });
}

/**
 * Precarga los 256 memes originales (memes/manifest.json) mas las 2
 * imagenes de control (memes/control-start.jpg, control-end.jpg) que
 * delimitan la transmision.
 * @param {{onProgress?: (loaded: number, total: number) => void}} options
 * @returns {Promise<{memes: {index: number, image: HTMLImageElement}[], startImage: HTMLImageElement, endImage: HTMLImageElement}>}
 */
export async function loadDictionary({ onProgress } = {}) {
  const manifest = await fetch("memes/manifest.json").then((r) => r.json());
  const memeCount = manifest.length;
  const total = memeCount + 2;
  let loaded = 0;
  const memes = new Array(memeCount);
  for (let index = 0; index < memeCount; index++) {
    const image = await loadImage(`memes/${manifest[index]}`);
    memes[index] = { index, image };
    onProgress?.(++loaded, total);
  }
  const startImage = await loadImage("memes/control-start.jpg");
  onProgress?.(++loaded, total);
  const endImage = await loadImage("memes/control-end.jpg");
  onProgress?.(++loaded, total);
  return { memes, startImage, endImage };
}
