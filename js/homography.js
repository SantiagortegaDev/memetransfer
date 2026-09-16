// Matematica pura de perspectiva: dado 4 puntos de origen y sus 4 puntos de
// destino correspondientes, calcula la matriz de homografia 3x3 que mapea
// uno al otro (Direct Linear Transform de 4 puntos), y la usa para
// "enderezar" digitalmente una imagen capturada en angulo/perspectiva.

/**
 * Resuelve un sistema lineal Ax=b por eliminacion gaussiana con pivoteo
 * parcial. Muta A y b.
 * @param {number[][]} A matriz n x n
 * @param {number[]} b vector n
 * @returns {number[]|null} solucion x, o null si el sistema es singular
 */
function solveLinearSystem(A, b) {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxVal = Math.abs(A[col][col]);
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > maxVal) {
        maxVal = Math.abs(A[row][col]);
        pivotRow = row;
      }
    }
    if (maxVal < 1e-12) return null;
    if (pivotRow !== col) {
      [A[col], A[pivotRow]] = [A[pivotRow], A[col]];
      [b[col], b[pivotRow]] = [b[pivotRow], b[col]];
    }
    for (let row = col + 1; row < n; row++) {
      const factor = A[row][col] / A[col][col];
      for (let k = col; k < n; k++) A[row][k] -= factor * A[col][k];
      b[row] -= factor * b[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = b[row];
    for (let k = row + 1; k < n; k++) sum -= A[row][k] * x[k];
    x[row] = sum / A[row][row];
  }
  return x;
}

/**
 * Calcula la homografia 3x3 (como array de 9 numeros, row-major, h[8]=1)
 * que mapea cada srcPoints[i] a dstPoints[i]. Exactamente 4 puntos.
 * @param {[number,number][]} srcPoints
 * @param {[number,number][]} dstPoints
 * @returns {number[]|null} [h11,h12,h13,h21,h22,h23,h31,h32,1], o null si es degenerada
 */
export function computeHomography(srcPoints, dstPoints) {
  if (srcPoints.length !== 4 || dstPoints.length !== 4) {
    throw new RangeError("computeHomography necesita exactamente 4 puntos");
  }
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = srcPoints[i];
    const [X, Y] = dstPoints[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(Y);
  }
  const h = solveLinearSystem(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/**
 * Aplica una homografia a un punto (x,y) -> (X,Y).
 * @param {number[]} h homografia de 9 numeros
 * @param {number} x
 * @param {number} y
 * @returns {[number, number]}
 */
export function applyHomography(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

/**
 * Invierte una homografia 3x3 (para mapear del destino de vuelta al origen).
 * @param {number[]} h
 * @returns {number[]|null}
 */
export function invertHomography(h) {
  const [a, b, c, d, e, f, g, i, j] = h;
  const det = a * (e * j - f * i) - b * (d * j - f * g) + c * (d * i - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  return [
    (e * j - f * i) * invDet,
    (c * i - b * j) * invDet,
    (b * f - c * e) * invDet,
    (f * g - d * j) * invDet,
    (a * j - c * g) * invDet,
    (c * d - a * f) * invDet,
    (d * i - e * g) * invDet,
    (b * g - a * i) * invDet,
    (a * e - b * d) * invDet,
  ];
}
