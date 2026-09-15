import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeByteToBits,
  decodeBitsToByte,
  bitModuleCenter,
  findCornerMarkers,
  readMarkerBits,
  CORNER_SIZE,
  CORNER_MARGIN,
  BIT_COUNT,
} from "../js/marker.js";
import { computeHomography, applyHomography, invertHomography } from "../js/homography.js";

test("encodeByteToBits/decodeBitsToByte round-trip for various bytes", () => {
  for (const byte of [0, 1, 255, 170, 85, 128, 42, 200]) {
    assert.equal(decodeBitsToByte(encodeByteToBits(byte)), byte);
  }
});

test("encodeByteToBits produces BIT_COUNT bits, MSB first", () => {
  assert.deepEqual(encodeByteToBits(0b10110000), [1, 0, 1, 1, 0, 0, 0, 0]);
  assert.equal(encodeByteToBits(5).length, BIT_COUNT);
});

/** Renderiza un marcador sintetico (para byte `byte`) proyectado dentro de
 * un frame de width x height, con las 4 esquinas reales dadas por
 * `realCorners` (topLeft, topRight, bottomRight, bottomLeft, en ese orden),
 * simulando una foto de camara con esa perspectiva. */
function renderSyntheticMarker(byte, realCorners, width, height, { background = 60 } = {}) {
  const canonicalCorners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const h = computeHomography(canonicalCorners, realCorners); // canonico -> frame real
  const hInv = invertHomography(h); // frame real -> canonico

  const bits = encodeByteToBits(byte);
  const gray = new Float64Array(width * height).fill(background);

  function inSquare(cx, cy, size, px, py) {
    return Math.abs(px - cx) <= size / 2 && Math.abs(py - cy) <= size / 2;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [cx, cy] = applyHomography(hInv, x, y);
      if (cx < 0 || cx > 1 || cy < 0 || cy > 1) continue; // fuera del marcador

      let value = 20; // borde negro por defecto

      const corners = [
        [CORNER_MARGIN + CORNER_SIZE / 2, CORNER_MARGIN + CORNER_SIZE / 2],
        [1 - CORNER_MARGIN - CORNER_SIZE / 2, CORNER_MARGIN + CORNER_SIZE / 2],
        [CORNER_MARGIN + CORNER_SIZE / 2, 1 - CORNER_MARGIN - CORNER_SIZE / 2],
        [1 - CORNER_MARGIN - CORNER_SIZE / 2, 1 - CORNER_MARGIN - CORNER_SIZE / 2],
      ];
      for (const [ccx, ccy] of corners) {
        if (inSquare(ccx, ccy, CORNER_SIZE, cx, cy)) value = 235;
      }

      for (let i = 0; i < BIT_COUNT; i++) {
        const [bcx, bcy] = bitModuleCenter(i);
        if (inSquare(bcx, bcy, CORNER_SIZE * 0.7, cx, cy)) {
          value = bits[i] ? 235 : 20;
        }
      }

      gray[y * width + x] = value;
    }
  }
  return gray;
}

test("findCornerMarkers locates a clean, axis-aligned marker", () => {
  const width = 200;
  const height = 200;
  const margin = 10;
  const realCorners = [
    [margin, margin],
    [width - margin, margin],
    [width - margin, height - margin],
    [margin, height - margin],
  ];
  const gray = renderSyntheticMarker(42, realCorners, width, height);
  const found = findCornerMarkers(gray, width, height);
  assert.ok(found, "deberia encontrar las 4 esquinas");
  assert.ok(Math.abs(found.topLeft[0] - (margin + CORNER_MARGIN * width + (CORNER_SIZE * width) / 2)) < 10);
});

test("readMarkerBits decodes the correct byte from a clean, axis-aligned marker", () => {
  const width = 200;
  const height = 200;
  const margin = 10;
  const realCorners = [
    [margin, margin],
    [width - margin, margin],
    [width - margin, height - margin],
    [margin, height - margin],
  ];
  for (const byte of [0, 1, 255, 170, 85, 128, 200]) {
    const gray = renderSyntheticMarker(byte, realCorners, width, height);
    const found = findCornerMarkers(gray, width, height);
    assert.ok(found, `deberia encontrar esquinas para byte ${byte}`);
    const decoded = readMarkerBits(gray, width, height, found);
    assert.equal(decoded, byte, `byte ${byte} deberia decodificar igual`);
  }
});

test("readMarkerBits decodes correctly through a realistic perspective distortion", () => {
  const width = 300;
  const height = 300;
  // trapezoide: simula una foto en angulo (no un rectangulo prolijo)
  const realCorners = [
    [40, 30],
    [270, 50],
    [280, 260],
    [20, 250],
  ];
  for (const byte of [7, 99, 250]) {
    const gray = renderSyntheticMarker(byte, realCorners, width, height);
    const found = findCornerMarkers(gray, width, height);
    assert.ok(found, `deberia encontrar esquinas para byte ${byte}`);
    const decoded = readMarkerBits(gray, width, height, found);
    assert.equal(decoded, byte, `byte ${byte} deberia decodificar igual bajo perspectiva`);
  }
});

test("findCornerMarkers returns null when there is no marker (flat frame)", () => {
  const gray = new Float64Array(100 * 100).fill(128);
  assert.equal(findCornerMarkers(gray, 100, 100), null);
});
