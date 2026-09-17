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

export const BIT_COUNT = 8; // bits de datos (el byte 0-255)
// Repeat data bits for robustness
export const REPEAT = 3;
// Patron fijo de sincronizacion: SIEMPRE vale esto, en todos los 256
// marcadores. No es dato - es una firma que un objeto/luz real tiene que
// acertar por pura casualidad (1 en 16) para que una lectura espuria pase
// como valida. Los 8 bits de datos siguen pudiendo ser cualquier valor
// 0-255 (incluido todo-blanco/todo-negro) sin restriccion: la firma es un
// modulo aparte, no una regla sobre el byte en si.
export const SYNC_BITS = [1, 0, 1, 0];
// Firma de los marcadores de CONTROL (inicio/fin de transmision): el
// complemento exacto de SYNC_BITS, asi un marcador de datos y uno de
// control jamas se confunden entre si (ademas de no confundirse con ruido).
// Reemplaza al viejo flash blanco/negro de pantalla completa (fragil:
// dependia de que el auto-exposure de la camara real llegara a un umbral
// de brillo global) por el mismo mecanismo robusto de esquinas+firma que ya
// usan los bytes de datos.
export const CONTROL_SYNC_BITS = [0, 1, 0, 1];
export const START_BYTE = 0xaa; // 170 - valor fijo arbitrario, solo distingue inicio de fin
export const END_BYTE = 0x55; // 85
export const START = "START";
export const END = "END";
const TOTAL_MODULES = BIT_COUNT + SYNC_BITS.length;

const BIT_STRIP_X_START = CORNER_MARGIN + CORNER_SIZE + 0.02;
const BIT_STRIP_X_END = 1 - CORNER_MARGIN - CORNER_SIZE - 0.02;
const BIT_STRIP_Y_CENTER = 1 - CORNER_MARGIN - CORNER_SIZE / 2;
const BIT_MODULE_WIDTH = (BIT_STRIP_X_END - BIT_STRIP_X_START) / TOTAL_MODULES;

/** Centro normalizado (0..1) del modulo `index` (0..7 = datos MSB primero, 8..11 = firma fija). */
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
  return sampleSquareStats(gray, width, height, cx, cy, size).mean;
}

/**
 * Media y desvio estandar de brillo dentro de un cuadrado centrado en
 * (cx,cy) (coords de pixeles reales), de lado `size` (en pixeles).
 * @param {Float64Array} gray
 * @param {number} width
 * @param {number} height
 */
function sampleSquareStats(gray, width, height, cx, cy, size) {
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
  if (count === 0) return { mean: 0, stdev: 0 };
  const mean = sum / count;
  let variance = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = gray[y * width + x] - mean;
      variance += d * d;
    }
  }
  return { mean, stdev: Math.sqrt(variance / count) };
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/**
 * Verifica que las 4 esquinas encontradas formen un cuadrilatero
 * geometricamente plausible para ser el marcador visto en perspectiva: (1)
 * convexo -si no, no puede ser una foto en perspectiva de un cuadrado real-,
 * (2) de tamano no degenerado, y (3) con lados razonablemente parecidos
 * entre si -una perspectiva realista distorsiona el cuadrado, pero no lo
 * vuelve un cuadrilatero arbitrariamente flaco-. Esto rechaza el caso de
 * "encontre 4 blobs brillantes sueltos que no tienen nada que ver entre
 * si" (texto, luces, fondo), que es distinto de "encontre las 4 esquinas
 * reales, solo que en angulo".
 * @param {{topLeft:[number,number], topRight:[number,number], bottomLeft:[number,number], bottomRight:[number,number]}} corners
 */
export function isPlausibleQuad(corners) {
  const pts = [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft];

  const crosses = pts.map((_, i) => cross(pts[i], pts[(i + 1) % 4], pts[(i + 2) % 4]));
  const allSameSign = crosses.every((c) => c > 0) || crosses.every((c) => c < 0);
  if (!allSameSign) return false;

  const sides = [distance(pts[0], pts[1]), distance(pts[1], pts[2]), distance(pts[2], pts[3]), distance(pts[3], pts[0])];
  const minSide = Math.min(...sides);
  const maxSide = Math.max(...sides);
  if (minSide < 8) return false; // demasiado chico, probablemente ruido
  if (maxSide / minSide > 2.5) return false; // demasiado deforme para ser una perspectiva realista

  return true;
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
      if (sizeRatio < 0.15 || sizeRatio > 6) continue; // demasiado chico o grande para ser el marcador, sea cual sea la forma

      const sizeScore = -Math.abs(Math.log(sizeRatio)); // 0 = tamano ideal, mas negativo cuanto mas se aleja
      const score = sizeScore + squareness;
      if (score > bestScore) {
        bestScore = score;
        bestCentroid = { point: [sumX / count, sumY / count], size: count };
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

  // Los 4 blobs encontrados deben tener un tamano parecido entre si: si
  // uno es varias veces mas grande/chico que los demas, lo mas probable es
  // que sea ruido de fondo (texto, luz) y no la misma esquina real vista
  // en perspectiva. Corners genuinos en perspectiva difieren en tamano,
  // pero no dramaticamente.
  const sizes = [topLeft.size, topRight.size, bottomLeft.size, bottomRight.size];
  if (Math.max(...sizes) / Math.min(...sizes) > 4) return null;

  const corners = {
    topLeft: topLeft.point,
    topRight: topRight.point,
    bottomLeft: bottomLeft.point,
    bottomRight: bottomRight.point,
  };
  if (!isPlausibleQuad(corners)) return null;

  return corners;
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
  const modules = readModules(gray, width, height, corners);
  if (!modules) return null;

  // los ultimos modulos son la firma fija: si no coinciden exacto, se
  // descarta la lectura entera sin importar que darian los bits de datos.
  // Un fondo/luz real que por casualidad forme un cuadrilatero plausible
  // con borde oscuro y centro texturado todavia tiene que acertar esta
  // firma (1 en 2^SYNC_BITS.length) para colarse.
  const syncBits = modules.slice(BIT_COUNT);
  const syncMatches = syncBits.every((bit, i) => bit === SYNC_BITS[i]);
  if (!syncMatches) return null;

  return decodeBitsToByte(modules.slice(0, BIT_COUNT));
}

/**
 * Igual que readMarkerBits, pero para los marcadores de CONTROL (inicio/fin
 * de transmision): en vez de exigir la firma SYNC_BITS de datos, exige la
 * firma CONTROL_SYNC_BITS y traduce el byte fijo resultante a START/END.
 * Reutiliza exactamente las mismas verificaciones de calidad (contraste,
 * borde oscuro en 3 puntos, textura de centro) que la lectura de datos, asi
 * que un marcador de inicio/fin es tan robusto contra falsos positivos como
 * cualquier byte de datos.
 * @returns {typeof START | typeof END | null}
 */
export function readControlMarker(gray, width, height, corners) {
  const modules = readModules(gray, width, height, corners);
  if (!modules) return null;

  const syncBits = modules.slice(BIT_COUNT);
  const syncMatches = syncBits.every((bit, i) => bit === CONTROL_SYNC_BITS[i]);
  if (!syncMatches) return null;

  const byte = decodeBitsToByte(modules.slice(0, BIT_COUNT));
  if (byte === START_BYTE) return START;
  if (byte === END_BYTE) return END;
  return null;
}

/**
 * Verifica esquinas/borde/textura y muestrea los TOTAL_MODULES bits crudos
 * de la tira (datos + firma, sin decidir todavia si la firma es de datos o
 * de control). Devuelve null si el marcador no pasa alguna de las
 * verificaciones de calidad.
 * @returns {number[]|null}
 */
function readModules(gray, width, height, corners) {
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
  // se promedian 3 puntos del borde (arriba, izquierda, derecha - el de
  // abajo se pisaria con la tira de bits) en vez de uno solo: si el
  // "marcador" encontrado es en realidad un objeto cualquiera, es dificil
  // que ademas tenga sus 3 bordes oscuros de casualidad.
  const midTopEdge = [0.5, CORNER_MARGIN + CORNER_SIZE / 2];
  const midLeftEdge = [CORNER_MARGIN + CORNER_SIZE / 2, 0.5];
  const midRightEdge = [1 - CORNER_MARGIN - CORNER_SIZE / 2, 0.5];
  const borderSamples = [
    sampleAtCanonical(gray, width, height, h, ...midTopEdge, cornerSize),
    sampleAtCanonical(gray, width, height, h, ...midLeftEdge, cornerSize),
    sampleAtCanonical(gray, width, height, h, ...midRightEdge, cornerSize),
  ];
  const blackRef = borderSamples.reduce((a, b) => a + b, 0) / borderSamples.length;

  if (whiteRef - blackRef < 25) return null; // sin contraste suficiente, no confiar en la lectura
  // cada punto del borde por separado debe ser razonablemente oscuro, no
  // solo el promedio: evita aceptar un "marcador" donde solo una parte del
  // borde es oscura por casualidad y el resto es contenido random.
  const darkCeiling = (whiteRef + blackRef) / 2;
  if (borderSamples.some((v) => v > darkCeiling)) return null;

  // el centro del marcador deberia ser la foto del meme: tiene que tener
  // textura real (desvio de brillo alto), no ser una zona lisa/pareja. Un
  // objeto cualquiera del entorno que por casualidad tenga 4 esquinas
  // brillantes muy dificilmente tambien tenga una zona con esta textura
  // exactamente en el medio.
  const centerStats = sampleStatsAtCanonical(gray, width, height, h, 0.5, 0.5, cornerSize * 3);
  if (centerStats.stdev < 12) return null;

  const midThreshold = (whiteRef + blackRef) / 2;
  const moduleSampleSize = BIT_MODULE_WIDTH * pixelsPerCanonicalUnit * 0.7;
  const modules = new Array(TOTAL_MODULES);
  for (let i = 0; i < TOTAL_MODULES; i++) {
    const [cx, cy] = bitModuleCenter(i);
    const value = sampleAtCanonical(gray, width, height, h, cx, cy, moduleSampleSize);
    modules[i] = value >= midThreshold ? 1 : 0;
  }

  return modules;
}

/** Muestrea el brillo promedio de un cuadrado (en coords canonicas 0..1) proyectado al frame real via la homografia inversa. */
function sampleAtCanonical(gray, width, height, h, cx, cy, sizeInSrcPixels) {
  const [x, y] = applyHomography(h, cx, cy);
  return sampleSquareMean(gray, width, height, x, y, sizeInSrcPixels);
}

/** Como sampleAtCanonical, pero devuelve {mean, stdev} en vez de solo el promedio. */
function sampleStatsAtCanonical(gray, width, height, h, cx, cy, sizeInSrcPixels) {
  const [x, y] = applyHomography(h, cx, cy);
  return sampleSquareStats(gray, width, height, x, y, sizeInSrcPixels);
}
