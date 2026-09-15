// Hash perceptual (pHash) de 100 bits (hashSize=10), calculado a mano sin
// dependencias: escala de grises -> resize -> DCT-II 2D -> bloque de baja
// frecuencia -> umbral por mediana. Ver docs/superpowers/specs para la
// justificacion de hashSize=10 (separacion medida entre los 256 memes).
export const HASH_SIZE = 10;
const RESIZE_FACTOR = 4; // tamano de resize = hashSize * RESIZE_FACTOR

/**
 * Convierte un buffer RGBA (como el de canvas getImageData) a escala de grises.
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @returns {Float64Array} un valor de luminancia por pixel
 */
export function rgbaToGrayscale(rgba) {
  const pixelCount = rgba.length / 4;
  const gray = new Float64Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return gray;
}

/**
 * Redimensiona una imagen en escala de grises (nearest-neighbor, alcanza
 * para el proposito de hashing perceptual).
 * @param {Float64Array} gray
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 */
export function resizeGrayscale(gray, srcW, srcH, dstW, dstH) {
  const out = new Float64Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const srcY = Math.min(srcH - 1, Math.floor((y * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const srcX = Math.min(srcW - 1, Math.floor((x * srcW) / dstW));
      out[y * dstW + x] = gray[srcY * srcW + srcX];
    }
  }
  return out;
}

// Tabla de cosenos precalculada por tamano, para no recalcular en cada llamada.
const cosTableCache = new Map();
function cosTable(n) {
  let table = cosTableCache.get(n);
  if (table) return table;
  table = new Float64Array(n * n);
  for (let u = 0; u < n; u++) {
    for (let x = 0; x < n; x++) {
      table[u * n + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * n));
    }
  }
  cosTableCache.set(n, table);
  return table;
}

/**
 * DCT-II 2D de una matriz cuadrada n x n (array plano, row-major).
 * @param {Float64Array} matrix
 * @param {number} n
 * @returns {Float64Array} coeficientes DCT, mismo tamano que la entrada
 */
export function dct2d(matrix, n) {
  const cos = cosTable(n);
  const alpha = (u) => (u === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n));

  // DCT por filas
  const rows = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let u = 0; u < n; u++) {
      let sum = 0;
      for (let x = 0; x < n; x++) {
        sum += matrix[y * n + x] * cos[u * n + x];
      }
      rows[y * n + u] = alpha(u) * sum;
    }
  }

  // DCT por columnas sobre el resultado anterior
  const out = new Float64Array(n * n);
  for (let u = 0; u < n; u++) {
    for (let v = 0; v < n; v++) {
      let sum = 0;
      for (let y = 0; y < n; y++) {
        sum += rows[y * n + u] * cos[v * n + y];
      }
      out[v * n + u] = alpha(v) * sum;
    }
  }
  return out;
}

/**
 * Toma el bloque hashSize x hashSize de baja frecuencia (esquina superior
 * izquierda) de una matriz DCT de tamano n x n, excluye el coeficiente DC
 * (0,0) y aplica umbral por mediana para obtener bits.
 * @param {Float64Array} dctMatrix
 * @param {number} n tamano de dctMatrix (n x n)
 * @param {number} hashSize
 * @returns {bigint} hash empaquetado en un BigInt de hashSize*hashSize - 1 bits
 */
export function hashFromDct(dctMatrix, n, hashSize) {
  const values = [];
  for (let v = 0; v < hashSize; v++) {
    for (let u = 0; u < hashSize; u++) {
      if (u === 0 && v === 0) continue; // excluye DC
      values.push(dctMatrix[v * n + u]);
    }
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  let hash = 0n;
  for (const value of values) {
    hash = (hash << 1n) | (value > median ? 1n : 0n);
  }
  return hash;
}

/**
 * Calcula el pHash de una imagen a partir de sus pixeles RGBA.
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {number} hashSize
 * @returns {bigint}
 */
export function phash(rgba, width, height, hashSize = HASH_SIZE) {
  const gray = rgbaToGrayscale(rgba);
  const size = hashSize * RESIZE_FACTOR;
  const resized = resizeGrayscale(gray, width, height, size, size);
  const dct = dct2d(resized, size);
  return hashFromDct(dct, size, hashSize);
}

/**
 * Distancia de Hamming entre dos hashes (BigInt).
 * @param {bigint} a
 * @param {bigint} b
 */
export function hammingDistance(a, b) {
  let xor = a ^ b;
  let count = 0;
  while (xor > 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}
