import { test } from "node:test";
import assert from "node:assert/strict";
import { dhash, DHASH_SIZE } from "../js/dhash.js";
import { hammingDistance } from "../js/phash.js";

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
const texture = (x, y) => (Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1) * 255;
const texture2 = (x, y) => (Math.abs(Math.sin(x * 93.989 + y * 17.233) * 12345.678) % 1) * 255;

const baseTexture = makeImage(W, H, texture);
const differentTexture = makeImage(W, H, texture2);
const noisyPixels = new Set(["3,3", "10,40", "40,10", "50,50", "5,60"]);
const baseTextureWithNoise = makeImage(W, H, (x, y) =>
  noisyPixels.has(`${x},${y}`) ? 255 - texture(x, y) : texture(x, y)
);

test("dhash of the same image is identical (distance 0)", () => {
  const a = dhash(baseTexture, W, H);
  const b = dhash(baseTexture, W, H);
  assert.equal(a, b);
  assert.equal(hammingDistance(a, b), 0);
});

test("dhash produces a hash of DHASH_SIZE^2 bits", () => {
  const h = dhash(baseTexture, W, H, 8);
  assert.ok(h < 2n ** 64n);
});

test("dhash is robust to minor pixel-level noise", () => {
  const clean = dhash(baseTexture, W, H);
  const noisy = dhash(baseTextureWithNoise, W, H);
  const distance = hammingDistance(clean, noisy);
  const totalBits = DHASH_SIZE * DHASH_SIZE;
  assert.ok(distance <= totalBits * 0.15, `expected small distance, got ${distance}/${totalBits}`);
});

test("dhash distinguishes structurally different images", () => {
  const a = dhash(baseTexture, W, H);
  const c = dhash(differentTexture, W, H);
  const distance = hammingDistance(a, c);
  assert.ok(distance > 0);
});
