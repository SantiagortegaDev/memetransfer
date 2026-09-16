import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHomography, applyHomography, invertHomography } from "../js/homography.js";

function approxEqual(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

test("identity mapping: same points in and out map every point to itself", () => {
  const pts = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  const h = computeHomography(pts, pts);
  const [x, y] = applyHomography(h, 5, 5);
  assert.ok(approxEqual(x, 5) && approxEqual(y, 5));
});

test("pure translation maps every point by the same offset", () => {
  const src = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  const dst = [
    [3, 4],
    [13, 4],
    [13, 14],
    [3, 14],
  ];
  const h = computeHomography(src, dst);
  const [x, y] = applyHomography(h, 5, 5);
  assert.ok(approxEqual(x, 8) && approxEqual(y, 9));
});

test("pure scale maps every point proportionally", () => {
  const src = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  const dst = [
    [0, 0],
    [20, 0],
    [20, 20],
    [0, 20],
  ];
  const h = computeHomography(src, dst);
  const [x, y] = applyHomography(h, 5, 5);
  assert.ok(approxEqual(x, 10) && approxEqual(y, 10));
});

test("maps all 4 corners of a perspective-distorted quad exactly", () => {
  // simula una foto en angulo: el rectangulo de origen se ve como un
  // trapezoide en la camara (perspectiva)
  const canonical = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ];
  const photographedQuad = [
    [12, 8],
    [88, 15],
    [95, 90],
    [5, 85],
  ];
  // homografia que "endereza": del quad fotografiado al cuadrado canonico
  const h = computeHomography(photographedQuad, canonical);
  for (let i = 0; i < 4; i++) {
    const [x, y] = applyHomography(h, photographedQuad[i][0], photographedQuad[i][1]);
    assert.ok(approxEqual(x, canonical[i][0], 1e-3), `corner ${i} x`);
    assert.ok(approxEqual(y, canonical[i][1], 1e-3), `corner ${i} y`);
  }
});

test("invertHomography undoes the original transform", () => {
  const src = [
    [12, 8],
    [88, 15],
    [95, 90],
    [5, 85],
  ];
  const dst = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ];
  const h = computeHomography(src, dst);
  const hInv = invertHomography(h);
  const [X, Y] = applyHomography(h, 30, 40);
  const [x, y] = applyHomography(hInv, X, Y);
  assert.ok(approxEqual(x, 30, 1e-3) && approxEqual(y, 40, 1e-3));
});

test("computeHomography throws on wrong number of points", () => {
  assert.throws(() => computeHomography([[0, 0]], [[0, 0]]), RangeError);
});
