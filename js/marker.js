import { computeHomography, applyHomography, invertHomography } from "./homography.js";

// Layout del marcador, en coordenadas normalizadas 0..1 sobre un cuadrado.
// Estas mismas constantes las usa scripts/generate_markers.py para dibujar
// los 256 memes con marcador: si se cambia un valor aca, hay que
// regenerar las imagenes con el mismo cambio alla.
export const CORNER_SIZE = 0.09;
export const CORNER_MARGIN = 0.02;
// centro de cada marcador de esquina (cuadrado solido), en coords 0..1
export const CORNER_CENTERS = {
  topLeft: [CORNER_MARGIN + CORNER_SIZE / 2, CORNER_MARGIN + CORNER_SIZE / 2],
  topRight: [1 - CORNER_MARGIN - CORNER_SIZE / 2, CORNER_MARGIN + CORNER_SIZE / 2],
  bottomLeft: [CORNER_MARGIN + CORNER_SIZE / 2, 1 - CORNER_MARGIN - CORNER_SIZE / 2],
  bottomRight: [1 - CORNER_MARGIN - CORNER_SIZE / 2, 1 - CORNER_MARGIN - CORNER_SIZE / 2],
};

export const BIT_COUNT = 8;
const BIT_STRIP_X_START = CORNER_MARGIN + CORNER_SIZE + 0.02;
const BIT_STRIP_X_END = 1 - CORNER_MARGIN - CORNER_SIZE - 0.02;
const BIT_STRIP_Y_CENTER = 1 - CORNER_MARGIN - CORNER_SIZE / 2;
const BIT_MODULE_WIDTH = (BIT_STRIP_X_END - BIT_STRIP_X_START) / BIT_COUNT;

/** Centro normalizado (0..1) del modulo de bit `index` (0 = mas significativo). */
export function bitModuleCenter(index) {
  return [BIT_STRIP_X_START + BIT_MODULE_WIDTH * (index + 0.5), BIT_STRIP_Y_CENTER];
}

/**
 * @param {number} byte 0-255
 * @returns {number[]} 8 bits, [0] = mas significativo
 */
export function encodeByteToBits(byte) {
  const bits = new Array(BIT_COUNT);
  for (let i = 0; i < BIT_COUNT; i++) {
    bits[i] = (byte >> (BIT_COUNT - 1 - i)) & 1;
  }
  return bits;
}

/**
 * @param {number[]} bits 8 bits, [0] = mas significativo
 * @returns {number} byte 0-255
 */
export function decodeBitsToByte(bits) {
  let byte = 0;
  for (let i = 0; i < BIT_COUNT; i++) {
    byte = (byte << 1) | (bits[i] ? 1 : 0);
  }
  return byte;
}

/**
 * Promedio de brillo dentro de un cuadrado centrado en (cx,cy) (coords de
 * pixeles reales), de lado `size` (en pixeles).
 * @param {Float64Array} gray
 * @param {number} width
 * @param {number} height
 */
function sampleSquareMean(gray, width, height, cx, cy, size) {
  const half = size / 2;
  const x0 = Math.max(0, Math.round(cx - half));
  const x1 = Math.min(width - 1, Math.round(cx + half));
  const y0 = Math.max(0, Math.round(cy - half));
  const y1 = Math.min(height - 1, Math.round(cy + half));
  let sum = 0;
  let count = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      sum += gray[y * width + x];
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Busca, dentro de una ventana rectangular (en coords de pixeles reales),
 * el blob brillante conectado que mas se parece al marcador de esquina
 * esperado: aproximadamente cuadrado y de un tamano cercano a
 * `expectedArea` (en pixeles al cuadrado). Se compara por forma y tamano
 * -no solo "el mas grande"- porque una foto real puede tener sus propias
 * zonas brillantes (fondo claro, una cara, texto) mas grandes que el
 * marcador; sin este filtro esas zonas le ganan al marcador real.
 * @returns {[number, number]|null} centroide [x,y], o null si no hay
 *   suficiente contraste en la ventana, o ningun blob se parece a un marcador
 */
function findBrightCentroid(gray, width, height, winX0, winY0, winX1, winY1, expectedArea) {
  let min = Infinity;
  let max = -Infinity;
  for (let y = winY0; y <= winY1; y++) {
    for (let x = winX0; x <= winX1; x++) {
      const v = gray[y * width + x];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (max - min < 40) return null; // muy poco contraste, no hay marcador confiable aca

  const threshold = (min + max) / 2;
  const winWidth = winX1 - winX0 + 1;
  const winHeight = winY1 - winY0 + 1;
  const visited = new Uint8Array(winWidth * winHeight);

  let bestScore = -Infinity;
  let bestCentroid = null;

  for (let y = winY0; y <= winY1; y++) {
    for (let x = winX0; x <= winX1; x++) {
      const startIdx = (y - winY0) * winWidth + (x - winX0);
      if (visited[startIdx] || gray[y * width + x] < threshold) continue;

      const stack = [[x, y]];
      visited[startIdx] = 1;
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      while (stack.length > 0) {
        const [px, py] = stack.pop();
        sumX += px;
        sumY += py;
        count++;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        const neighbors = [
          [px + 1, py],
          [px - 1, py],
          [px, py + 1],
          [px, py - 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < winX0 || nx > winX1 || ny < winY0 || ny > winY1) continue;
          const idx = (ny - winY0) * winWidth + (nx - winX0);
          if (visited[idx] || gray[ny * width + nx] < threshold) continue;
          visited[idx] = 1;
          stack.push([nx, ny]);
        }
      }

      const boxWidth = maxX - minX + 1;
      const boxHeight = maxY - minY + 1;
      const squareness = Math.min(boxWidth, boxHeight) / Math.max(boxWidth, boxHeight);
      if (squareness < 0.4) continue; // forma demasiado alargada para ser un marcador

      const sizeRatio = count / expectedArea;
      const sizeScore = -Math.abs(Math.log(sizeRatio)); // 0 = tamano ideal, mas negativo cuanto mas se aleja
      const score = sizeScore + squareness;
      if (score > bestScore) {
        bestScore = score;
        bestCentroid = [sumX / count, sumY / count];
      }
    }
  }

  return bestCentroid;
}

/**
 * Busca los 4 marcadores de esquina dentro del frame completo, cada uno en
 * una ventana de busqueda cerca de la esquina esperada (asumiendo que el
 * usuario encuadro aproximadamente el marcador completo en la camara, con
 * la guia visual de la UI).
 * @param {Float64Array} gray
 * @param {number} width
 * @param {number} height
 * @param {number} searchFraction que fraccion del frame (desde cada esquina)
 *   se explora en busca del marcador (tolerancia a mal encuadre)
 * @returns {{topLeft:[number,number], topRight:[number,number], bottomLeft:[number,number], bottomRight:[number,number]}|null}
 */
export function findCornerMarkers(gray, width, height, searchFraction = 0.45) {
  const wx = Math.round(width * searchFraction);
  const wy = Math.round(height * searchFraction);
  // area esperada del marcador de esquina en pixeles^2, asumiendo que el
  // marcador ocupa aproximadamente todo el frame (CORNER_SIZE es una
  // fraccion del lado del marcador completo, no del frame de camara, pero
  // como referencia de orden de magnitud alcanza para descartar blobs
  // mucho mas grandes o mas chicos que un marcador real)
  const expectedArea = (CORNER_SIZE * width) * (CORNER_SIZE * height);

  const topLeft = findBrightCentroid(gray, width, height, 0, 0, wx, wy, expectedArea);
  const topRight = findBrightCentroid(gray, width, height, width - 1 - wx, 0, width - 1, wy, expectedArea);
  const bottomLeft = findBrightCentroid(gray, width, height, 0, height - 1 - wy, wx, height - 1, expectedArea);
  const bottomRight = findBrightCentroid(
    gray,
    width,
    height,
    width - 1 - wx,
    height - 1 - wy,
    width - 1,
    height - 1,
    expectedArea
  );

  if (!topLeft || !topRight || !bottomLeft || !bottomRight) return null;
  return { topLeft, topRight, bottomLeft, bottomRight };
}

/**
 * Dado un frame (grises) y las 4 esquinas encontradas en el, calcula la
 * homografia que las endereza a un cuadrado canonico de `outSize` x `outSize`,
 * "re-muestrea" (warp) ese frame al cuadrado enderezado, y lee los 8 bits
 * del marcador comparando contra el brillo de los propios marcadores de
 * esquina (blanco) y del borde entre ellos (negro) del frame ORIGINAL - no
 * hace falta un umbral absoluto fijo, se calibra solo por frame.
 * @param {Float64Array} gray frame completo en escala de grises
 * @param {number} width
 * @param {number} height
 * @param {{topLeft:[number,number], topRight:[number,number], bottomLeft:[number,number], bottomRight:[number,number]}} corners
 * @returns {number|null} byte 0-255, o null si los bits no son lo bastante claros
 */
export function readMarkerBits(gray, width, height, corners) {
  const canonical = [
    CORNER_CENTERS.topLeft,
    CORNER_CENTERS.topRight,
    CORNER_CENTERS.bottomRight,
    CORNER_CENTERS.bottomLeft,
  ];
  const src = [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft];
  const h = computeHomography(canonical, src);
  if (!h) return null;

  // brillo esperado de "blanco" (esquinas) y de "negro" (borde, muestreado
  // a mitad de camino entre dos esquinas contiguas) en el frame real.
  // Escala: cuantos pixeles reales corresponden a 1 unidad canonica,
  // medido sobre el borde superior (distancia real entre las 2 esquinas
  // de arriba, dividido la distancia canonica que las separa).
  const topEdgeCanonicalDist = CORNER_CENTERS.topRight[0] - CORNER_CENTERS.topLeft[0];
  const topEdgeRealDist = Math.hypot(src[1][0] - src[0][0], src[1][1] - src[0][1]);
  const pixelsPerCanonicalUnit = topEdgeRealDist / topEdgeCanonicalDist;
  const cornerSize = CORNER_SIZE * pixelsPerCanonicalUnit;
  const whiteRef =
    (sampleAtCanonical(gray, width, height, h, ...CORNER_CENTERS.topLeft, cornerSize) +
      sampleAtCanonical(gray, width, height, h, ...CORNER_CENTERS.bottomRight, cornerSize)) /
    2;
  const midTopEdge = [0.5, CORNER_MARGIN + CORNER_SIZE / 2];
  const blackRef = sampleAtCanonical(gray, width, height, h, ...midTopEdge, cornerSize);

  if (whiteRef - blackRef < 25) return null; // sin contraste suficiente, no confiar en la lectura

  const midThreshold = (whiteRef + blackRef) / 2;
  const bits = new Array(BIT_COUNT);
  for (let i = 0; i < BIT_COUNT; i++) {
    const [cx, cy] = bitModuleCenter(i);
    const value = sampleAtCanonical(gray, width, height, h, cx, cy, cornerSize * 0.6);
    bits[i] = value >= midThreshold ? 1 : 0;
  }
  return decodeBitsToByte(bits);
}

/** Muestrea el brillo promedio de un cuadrado (en coords canonicas 0..1) proyectado al frame real via la homografia inversa. */
function sampleAtCanonical(gray, width, height, h, cx, cy, sizeInSrcPixels) {
  const [x, y] = applyHomography(h, cx, cy);
  return sampleSquareMean(gray, width, height, x, y, sizeInSrcPixels);
}
