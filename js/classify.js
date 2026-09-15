// Clasifica un frame por brillo/uniformidad promedio. IMPORTANTE: en
// receiver.js esto solo se consulta como FALLBACK, despues de intentar
// matchear contra el diccionario de memes (ver _tick) - varios memes reales
// son de bajo contraste (casi blancos o casi negros) y necesitan tener
// prioridad, si no este clasificador los interceptaria antes de llegar a
// pHash. Un flash sintetico de inicio/fin, en cambio, esta a distancia ~49
// de CUALQUIERA de los 256 memes (medido), muy por encima del umbral de
// match, asi que nunca hay riesgo de que un flash real se confunda con un
// meme por invertir el orden.
//
// Umbrales recalibrados tras pruebas en celular real: el auto-exposure de
// una camara real nunca deja que un blanco/negro solidos lleguen a los
// extremos (255/0) que asumia la primera version (210/45). Como ahora esto
// es solo un fallback (ya no compite con memes reales de bajo contraste),
// FLAT_STDEV_THRESHOLD tambien se afloja mas para tolerar el ruido de
// sensor real sobre un fondo genuinamente plano.
export const WHITE_MEAN_THRESHOLD = 180;
export const BLACK_MEAN_THRESHOLD = 65;
export const FLAT_STDEV_THRESHOLD = 40;

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
