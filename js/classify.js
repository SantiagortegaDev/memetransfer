// Clasifica un frame (ya en escala de grises) en una de 4 categorias, sin
// pasar por pHash: los flashes de inicio/fin y la pausa gris se distinguen
// por brillo/uniformidad promedio, mucho mas robusto a desenfoque y a un
// borde parcial en el encuadre que intentar reconocer 256 memes en esos casos.
//
// Umbrales recalibrados tras pruebas en celular real: el auto-exposure de
// una camara real nunca deja que un blanco/negro solidos lleguen a los
// extremos (255/0) que asumia la primera version (210/45) - el algoritmo
// de exposicion ajusta para no "quemar" ni "tapar" la imagen. Se aflojan a
// un rango con margen amplio respecto al gris de pausa (~128) pero
// alcanzable por una camara real con auto-exposure.
export const WHITE_MEAN_THRESHOLD = 180;
export const BLACK_MEAN_THRESHOLD = 65;
export const FLAT_STDEV_THRESHOLD = 28;

export const START = "START";
export const END = "END";
export const GAP = null;
export const TEXTURED = "TEXTURED";

/**
 * @param {ArrayLike<number>} gray valores de luminancia 0-255
 * @returns {{mean: number, stdev: number}}
 */
export function analyzeBrightness(gray) {
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

  return { mean, stdev };
}

/**
 * @param {ArrayLike<number>} gray valores de luminancia 0-255
 * @returns {{category: typeof START | typeof END | typeof GAP | typeof TEXTURED, mean: number, stdev: number}}
 */
export function classifyFrame(gray) {
  const { mean, stdev } = analyzeBrightness(gray);

  let category = TEXTURED;
  if (stdev < FLAT_STDEV_THRESHOLD) {
    if (mean >= WHITE_MEAN_THRESHOLD) category = START;
    else if (mean <= BLACK_MEAN_THRESHOLD) category = END;
    else category = GAP;
  }

  return { category, mean, stdev };
}
