import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rgbaToGrayscale,
  resizeGrayscale,
  phash,
  hammingDistance,
  HASH_SIZE,
} from "../js/phash.js";

// Genera una imagen RGBA sintetica de width x height. `fn(x, y)` devuelve
// un valor de gris 0-255 para cada pixel.
function makeImage(width, height, fn) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = fn(x, y);
      const i = (y * width + x) * 4;
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

const W = 64;
const H = 64;

// Pseudo-textura deterministica con contenido de frecuencia amplio (parecida
// en espiritu a una foto real, a diferencia de un borde duro sintetico que
// concentra casi toda la energia DCT en un par de coeficientes y vuelve el
// umbral por mediana inestable ante ruido minimo).
const texture = (x, y) => (Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1) * 255;
const texture2 = (x, y) => (Math.abs(Math.sin(x * 93.989 + y * 17.233) * 12345.678) % 1) * 255;

const baseTexture = makeImage(W, H, texture);
const differentTexture = makeImage(W, H, texture2);
// Igual que baseTexture pero con un punado de pixeles sueltos invertidos
// (simula el ruido de una foto de camara): no deberia cambiar la estructura
// de baja frecuencia que domina el hash.
const noisyPixels = new Set(["3,3", "10,40", "40,10", "50,50", "5,60"]);
const baseTextureWithNoise = makeImage(W, H, (x, y) =>
  noisyPixels.has(`${x},${y}`) ? 255 - texture(x, y) : texture(x, y)
);

test("rgbaToGrayscale converts a solid color image to a constant value", () => {
  const rgba = makeImage(4, 4, () => 128);
  const gray = rgbaToGrayscale(rgba);
  assert.equal(gray.length, 16);
  assert.ok(gray.every((v) => Math.abs(v - 128) < 1e-9));
});

test("resizeGrayscale preserves a constant image", () => {
  const gray = new Float64Array(16).fill(100);
  const resized = resizeGrayscale(gray, 4, 4, 8, 8);
  assert.equal(resized.length, 64);
  assert.ok(resized.every((v) => v === 100));
});

test("phash of the same image is identical (distance 0)", () => {
  const a = phash(baseTexture, W, H);
  const b = phash(baseTexture, W, H);
  assert.equal(a, b);
  assert.equal(hammingDistance(a, b), 0);
});

test("phash is robust to minor pixel-level noise", () => {
  const clean = phash(baseTexture, W, H);
  const noisy = phash(baseTextureWithNoise, W, H);
  const distance = hammingDistance(clean, noisy);
  const totalBits = HASH_SIZE * HASH_SIZE - 1;
  assert.ok(
    distance <= totalBits * 0.1,
    `expected small distance for minor noise, got ${distance}/${totalBits}`
  );
});

test("phash clearly distinguishes structurally different images", () => {
  const a = phash(baseTexture, W, H);
  const c = phash(differentTexture, W, H);
  const distance = hammingDistance(a, c);
  const totalBits = HASH_SIZE * HASH_SIZE - 1;
  assert.ok(
    distance >= totalBits * 0.25,
    `expected large distance for different structure, got ${distance}/${totalBits}`
  );
});

test("hammingDistance is symmetric and zero for equal hashes", () => {
  const a = 0b1010n;
  const b = 0b1100n;
  assert.equal(hammingDistance(a, a), 0);
  assert.equal(hammingDistance(a, b), hammingDistance(b, a));
  assert.equal(hammingDistance(a, b), 2);
});
