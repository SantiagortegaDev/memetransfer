// Diccionario de memes + imagenes de control con su pHash pre-calculado.
//
// Ya no hace falta el marcador visual (esquinas + tira de bits) encima de
// cada meme: el receptor identifica el meme por su contenido visual usando
// pHash (ver js/phash.js). El "diccionario" carga las 256 imagenes
// originales de memes, mas 2 imagenes de control (start.jpg, end.jpg) que
// delimitan la transmision, y pre-calcula el pHash de cada una para poder
// comparar rapido contra cada frame de camara en el receptor.

import { computePHash, hashFromImageData, PHASH_INPUT_SIZE } from "./phash.js";

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    img.src = src;
  });
}

/**
 * Calcula el pHash de una imagen "como la ve el receptor".
 *
 * El emisor muestra cada meme en un contenedor cuadrado con
 * object-fit: contain (letterbox/pillarbox segun el aspect ratio del
 * meme). El receptor captura ese cuadrado con la camara y recorta el
 * centro a un cuadrado. Asi que el pHash limpio de referencia debe ser
 * calculado sobre el meme RENDERIZADO en un cuadrado con contain, no
 * sobre el meme estirado a cuadrado (que seria otra cosa distinta y
 * no matchearia con lo que el receptor ve).
 *
 * Pasos:
 *   1. Crear un canvas cuadrado (SQUARE_REF_SIZE x SQUARE_REF_SIZE).
 *   2. Calcular el tamanio que tendria el meme con contain (preserva
 *      aspect ratio, entra completo).
 *   3. Rellenar el canvas con negro (el "fondo" alrededor del meme).
 *   4. Dibujar el meme centrado con su tamanio contain.
 *   5. Re-dibujar ese cuadrado al canvas chico de 32x32 del pHash.
 *   6. Calcular pHash sobre el resultado.
 *
 * @param {HTMLImageElement} image imagen ya cargada
 * @param {HTMLCanvasElement} squareCanvas canvas cuadrado reutilizable
 * @param {CanvasRenderingContext2D} squareCtx contexto del canvas cuadrado
 * @param {HTMLCanvasElement} hashCanvas canvas de 32x32 reutilizable
 * @param {CanvasRenderingContext2D} hashCtx contexto del canvas de 32x32
 * @returns {Uint8Array} 8 bytes (64 bits)
 */
const SQUARE_REF_SIZE = 320;

function hashImageAsDisplayed(image, squareCanvas, squareCtx, hashCanvas, hashCtx) {
  if (squareCanvas.width !== SQUARE_REF_SIZE) {
    squareCanvas.width = SQUARE_REF_SIZE;
    squareCanvas.height = SQUARE_REF_SIZE;
  }
  // Fondo negro (matchea el contenedor .meme-screen del CSS)
  squareCtx.fillStyle = "#000000";
  squareCtx.fillRect(0, 0, SQUARE_REF_SIZE, SQUARE_REF_SIZE);

  const w = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  if (w > 0 && h > 0) {
    // contain: escala preservando aspect ratio, entra completo
    const scale = Math.min(SQUARE_REF_SIZE / w, SQUARE_REF_SIZE / h);
    const drawW = w * scale;
    const drawH = h * scale;
    const dx = (SQUARE_REF_SIZE - drawW) / 2;
    const dy = (SQUARE_REF_SIZE - drawH) / 2;
    squareCtx.drawImage(image, dx, dy, drawW, drawH);
  }

  // Ahora el cuadrado contiene el meme como lo mostraria el emisor.
  // Lo pasamos al canvas chico de 32x32 para el pHash.
  if (hashCanvas.width !== PHASH_INPUT_SIZE) {
    hashCanvas.width = PHASH_INPUT_SIZE;
    hashCanvas.height = PHASH_INPUT_SIZE;
  }
  hashCtx.drawImage(squareCanvas, 0, 0, SQUARE_REF_SIZE, SQUARE_REF_SIZE, 0, 0, PHASH_INPUT_SIZE, PHASH_INPUT_SIZE);
  const { data } = hashCtx.getImageData(0, 0, PHASH_INPUT_SIZE, PHASH_INPUT_SIZE);
  return hashFromImageData(data);
}

/**
 * Precarga las 256 imagenes originales de memes (memes/<id>.jpg) y las 2
 * imagenes de control (memes/start.jpg, memes/end.jpg), y pre-calcula el
 * pHash de cada una para que el receptor pueda comparar contra cada frame
 * de camara en O(1) por hamming distance.
 *
 * @param {{onProgress?: (loaded: number, total: number) => void}} options
 * @returns {Promise<{memes: {index: number, image: HTMLImageElement, hash: Uint8Array}[], startImage: HTMLImageElement, startHash: Uint8Array, endImage: HTMLImageElement, endHash: Uint8Array}>}
 */
export async function loadDictionary({ onProgress } = {}) {
  // Carga el manifest para saber el nombre de archivo de cada meme
  const manifestResp = await fetch("memes/manifest.json");
  if (!manifestResp.ok) {
    throw new Error(`No se pudo cargar memes/manifest.json: ${manifestResp.status}`);
  }
  const manifest = await manifestResp.json();
  if (!Array.isArray(manifest) || manifest.length !== 256) {
    throw new Error(`Manifest invalido: se esperaban 256 memes, hay ${Array.isArray(manifest) ? manifest.length : "no-array"}`);
  }

  const memeCount = 256;
  const total = memeCount + 2;
  let loaded = 0;

  // Canvas offscreen reutilizables: uno cuadrado grande para renderizar
  // "como el emisor muestra", uno chico de 32x32 para el pHash.
  const squareCanvas = document.createElement("canvas");
  squareCanvas.width = SQUARE_REF_SIZE;
  squareCanvas.height = SQUARE_REF_SIZE;
  const squareCtx = squareCanvas.getContext("2d");

  const hashCanvas = document.createElement("canvas");
  hashCanvas.width = PHASH_INPUT_SIZE;
  hashCanvas.height = PHASH_INPUT_SIZE;
  const hashCtx = hashCanvas.getContext("2d", { willReadFrequently: true });

  const memes = new Array(memeCount);
  for (let index = 0; index < memeCount; index++) {
    const image = await loadImage(`memes/${manifest[index]}`);
    const hash = hashImageAsDisplayed(image, squareCanvas, squareCtx, hashCanvas, hashCtx);
    memes[index] = { index, image, hash };
    onProgress?.(++loaded, total);
  }

  const startImage = await loadImage("memes/start.jpg");
  const startHash = hashImageAsDisplayed(startImage, squareCanvas, squareCtx, hashCanvas, hashCtx);
  onProgress?.(++loaded, total);

  const endImage = await loadImage("memes/end.jpg");
  const endHash = hashImageAsDisplayed(endImage, squareCanvas, squareCtx, hashCanvas, hashCtx);
  onProgress?.(++loaded, total);

  return { memes, startImage, startHash, endImage, endHash };
}

