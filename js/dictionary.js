import { phash, HASH_SIZE } from "./phash.js";
import { dhash } from "./dhash.js";

const SAMPLE_SIZE = HASH_SIZE * 4; // 40: mismo tamano usado al samplear la camara

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    img.src = src;
  });
}

/**
 * Carga los 256 memes listados en memes/manifest.json, precalcula su pHash
 * y dHash (dibujandolos en un canvas de 40x40, la misma resolucion que se
 * usa para samplear la camara) y devuelve un array donde la posicion == el
 * indice == el valor de byte que representa cada meme.
 * @param {{onProgress?: (loaded: number, total: number) => void}} options
 * @returns {Promise<{index: number, filename: string, image: HTMLImageElement, hash: bigint, dhash: bigint}[]>}
 */
export async function loadDictionary({ onProgress } = {}) {
  const response = await fetch("memes/manifest.json");
  if (!response.ok) {
    throw new Error(`No se pudo cargar memes/manifest.json (${response.status})`);
  }
  const filenames = await response.json();

  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const entries = new Array(filenames.length);
  for (let index = 0; index < filenames.length; index++) {
    const filename = filenames[index];
    const image = await loadImage(`memes/${filename}`);
    ctx.clearRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    ctx.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const hash = phash(data, SAMPLE_SIZE, SAMPLE_SIZE, HASH_SIZE);
    const dHashValue = dhash(data, SAMPLE_SIZE, SAMPLE_SIZE);
    entries[index] = { index, filename, image, hash, dhash: dHashValue };
    onProgress?.(index + 1, filenames.length);
  }

  return entries;
}
