import { rgbaToGrayscale, resizeGrayscale } from "./phash.js";

// Difference hash (dHash): compara pixeles adyacentes en vez de frecuencias
// DCT. Mucho mas barato de calcular que el pHash, pero para este diccionario
// de 256 memes tiene mucha peor separacion global (distancia minima medida
// de 4 bits sobre 64, contra 28/100 del pHash) - por eso NO se usa como
// clasificador principal, solo como desempate cuando el pHash deja dos
// candidatos demasiado cerca entre si (ver bestMatchWithTieBreak en
// receiver.js).
export const DHASH_SIZE = 8; // 64 bits

/**
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {number} hashSize
 * @returns {bigint}
 */
export function dhash(rgba, width, height, hashSize = DHASH_SIZE) {
  const gray = rgbaToGrayscale(rgba);
  const w = hashSize + 1;
  const h = hashSize;
  const resized = resizeGrayscale(gray, width, height, w, h);

  let hash = 0n;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < hashSize; x++) {
      const left = resized[y * w + x];
      const right = resized[y * w + x + 1];
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }
  return hash;
}
