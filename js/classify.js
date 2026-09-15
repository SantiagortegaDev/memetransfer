// Clasifica un frame (ya en escala de grises) en una de 4 categorias, sin
// pasar por pHash: los flashes de inicio/fin y la pausa gris se distinguen
// por brillo/uniformidad promedio, mucho mas robusto a desenfoque y a un
// borde parcial en el encuadre que intentar reconocer 256 memes en esos casos.
export const WHITE_MEAN_THRESHOLD = 210;
export const BLACK_MEAN_THRESHOLD = 45;
export const FLAT_STDEV_THRESHOLD = 20;

export const START = "START";
export const END = "END";
export const GAP = null;
export const TEXTURED = "TEXTURED";

/**
 * @param {ArrayLike<number>} gray valores de luminancia 0-255
 * @returns {typeof START | typeof END | typeof GAP | typeof TEXTURED}
 */
export function classifyFrame(gray) {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  const mean = sum / gray.length;

  let variance = 0;
  for (let i = 0; i < gray.length; i++) {
    const d = gray[i] - mean;
    variance += d * d;
  }
  variance /= gray.length;
  const stdev = Math.sqrt(variance);

  if (stdev < FLAT_STDEV_THRESHOLD) {
    if (mean >= WHITE_MEAN_THRESHOLD) return START;
    if (mean <= BLACK_MEAN_THRESHOLD) return END;
    return GAP;
  }
  return TEXTURED;
}
