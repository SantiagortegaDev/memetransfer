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
