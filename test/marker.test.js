import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeByteToBits,
  decodeBitsToByte,
  bitModuleCenter,
  findCornerMarkers,
  readMarkerBits,
  readControlMarker,
  CORNER_SIZE,
  CORNER_MARGIN,
  BIT_COUNT,
  SYNC_BITS,
  CONTROL_SYNC_BITS,
  START_BYTE,
  END_BYTE,
  START,
  END,
} from "../js/marker.js";

const MODULE_PITCH = bitModuleCenter(1)[0] - bitModuleCenter(0)[0];
const MODULE_DRAW_SIZE = MODULE_PITCH * 0.85;
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
function renderSyntheticMarker(byte, realCorners, width, height, { background = 60, syncBits = SYNC_BITS } = {}) {
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

      // area del "meme": textura con contenido de frecuencia amplio (igual
      // criterio que test/phash.test.js), para que pase el chequeo de
      // textura del centro que exige js/marker.js
      if (cx > 0.13 && cx < 0.87 && cy > 0.13 && cy < 0.87) {
        value = (Math.abs(Math.sin(cx * 912.9898 + cy * 478.233) * 43758.5453) % 1) * 255;
      }

      const corners = [
        [CORNER_MARGIN + CORNER_SIZE / 2, CORNER_MARGIN + CORNER_SIZE / 2],
        [1 - CORNER_MARGIN - CORNER_SIZE / 2, CORNER_MARGIN + CORNER_SIZE / 2],
        [CORNER_MARGIN + CORNER_SIZE / 2, 1 - CORNER_MARGIN - CORNER_SIZE / 2],
        [1 - CORNER_MARGIN - CORNER_SIZE / 2, 1 - CORNER_MARGIN - CORNER_SIZE / 2],
      ];
      for (const [ccx, ccy] of corners) {
        if (inSquare(ccx, ccy, CORNER_SIZE, cx, cy)) value = 235;
      }

      const modules = [...bits, ...syncBits];
      for (let i = 0; i < modules.length; i++) {
        const [bcx, bcy] = bitModuleCenter(i);
        if (inSquare(bcx, bcy, MODULE_DRAW_SIZE, cx, cy)) {
          value = modules[i] ? 235 : 20;
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

test("findCornerMarkers rejects 4 unrelated bright blobs that don't form a plausible quad", () => {
  // caso real observado en hardware: 4 cosas brillantes sueltas (texto,
  // luz, fondo) en posiciones arbitrarias, no relacionadas entre si como
  // las esquinas de un mismo objeto fisico
  const width = 200;
  const height = 200;
  const gray = new Float64Array(width * height).fill(60);
  function paintBlob(cx, cy, size) {
    for (let y = Math.round(cy - size / 2); y <= cy + size / 2; y++) {
      for (let x = Math.round(cx - size / 2); x <= cx + size / 2; x++) {
        if (x >= 0 && x < width && y >= 0 && y < height) gray[y * width + x] = 230;
      }
    }
  }
  // un cuadrilatero muy deforme/no convexo, nada que ver con una foto real
  paintBlob(15, 15, 14);
  paintBlob(180, 20, 14);
  paintBlob(100, 100, 14); // "esquina" inferior izquierda metida en el medio: no convexo
  paintBlob(170, 175, 14);
  assert.equal(findCornerMarkers(gray, width, height), null);
});

test("findCornerMarkers rejects corners with wildly inconsistent sizes", () => {
  const width = 200;
  const height = 200;
  const gray = new Float64Array(width * height).fill(60);
  function paintBlob(cx, cy, size) {
    for (let y = Math.round(cy - size / 2); y <= cy + size / 2; y++) {
      for (let x = Math.round(cx - size / 2); x <= cx + size / 2; x++) {
        if (x >= 0 && x < width && y >= 0 && y < height) gray[y * width + x] = 230;
      }
    }
  }
  paintBlob(20, 20, 14);
  paintBlob(180, 20, 14);
  paintBlob(20, 180, 14);
  paintBlob(180, 180, 70); // una "esquina" mucho mas grande que las otras 3
  assert.equal(findCornerMarkers(gray, width, height), null);
});

test("readMarkerBits rejects a marker whose center has no texture (flat/background, not a real photo)", () => {
  const width = 200;
  const height = 200;
  const margin = 10;
  const realCorners = [
    [margin, margin],
    [width - margin, margin],
    [width - margin, height - margin],
    [margin, height - margin],
  ];
  // renderiza el marcador pero con el centro liso en vez de texturado
  const canonicalCorners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const h = computeHomography(canonicalCorners, realCorners);
  const hInv = invertHomography(h);
  const bits = encodeByteToBits(42);
  const gray = new Float64Array(width * height).fill(60);
  function inSquare(cx, cy, size, px, py) {
    return Math.abs(px - cx) <= size / 2 && Math.abs(py - cy) <= size / 2;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [cx, cy] = applyHomography(hInv, x, y);
      if (cx < 0 || cx > 1 || cy < 0 || cy > 1) continue;
      let value = 20; // sin textura en el centro, a diferencia de renderSyntheticMarker
      const corners = [
        [CORNER_MARGIN + CORNER_SIZE / 2, CORNER_MARGIN + CORNER_SIZE / 2],
        [1 - CORNER_MARGIN - CORNER_SIZE / 2, CORNER_MARGIN + CORNER_SIZE / 2],
        [CORNER_MARGIN + CORNER_SIZE / 2, 1 - CORNER_MARGIN - CORNER_SIZE / 2],
        [1 - CORNER_MARGIN - CORNER_SIZE / 2, 1 - CORNER_MARGIN - CORNER_SIZE / 2],
      ];
      for (const [ccx, ccy] of corners) {
        if (inSquare(ccx, ccy, CORNER_SIZE, cx, cy)) value = 235;
      }
      const modules = [...bits, ...SYNC_BITS];
      for (let i = 0; i < modules.length; i++) {
        const [bcx, bcy] = bitModuleCenter(i);
        if (inSquare(bcx, bcy, MODULE_DRAW_SIZE, cx, cy)) value = modules[i] ? 235 : 20;
      }
      gray[y * width + x] = value;
    }
  }
  const found = findCornerMarkers(gray, width, height);
  assert.ok(found, "las esquinas si deberian encontrarse (son identicas al caso valido)");
  assert.equal(readMarkerBits(gray, width, height, found), null);
});

test("readMarkerBits rejects a frame whose sync signature doesn't match, even with perfect corners/border/texture", () => {
  const width = 200;
  const height = 200;
  const margin = 10;
  const realCorners = [
    [margin, margin],
    [width - margin, margin],
    [width - margin, height - margin],
    [margin, height - margin],
  ];
  const gray = renderSyntheticMarker(99, realCorners, width, height);

  // corrompe justo el primer modulo de la firma (el resto del marcador -
  // esquinas, borde, textura del centro, bits de datos - queda intacto)
  const canonicalCorners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const h = computeHomography(canonicalCorners, realCorners);
  const [sx, sy] = applyHomography(h, ...bitModuleCenter(BIT_COUNT));
  for (let y = Math.round(sy - 6); y <= sy + 6; y++) {
    for (let x = Math.round(sx - 6); x <= sx + 6; x++) {
      gray[y * width + x] = SYNC_BITS[0] ? 20 : 235; // invierte ese modulo
    }
  }

  const found = findCornerMarkers(gray, width, height);
  assert.ok(found);
  assert.equal(readMarkerBits(gray, width, height, found), null);
});

test("readControlMarker decodes START and END from control-signature markers", () => {
  const width = 200;
  const height = 200;
  const margin = 10;
  const realCorners = [
    [margin, margin],
    [width - margin, margin],
    [width - margin, height - margin],
    [margin, height - margin],
  ];

  const startGray = renderSyntheticMarker(START_BYTE, realCorners, width, height, {
    syncBits: CONTROL_SYNC_BITS,
  });
  const startCorners = findCornerMarkers(startGray, width, height);
  assert.ok(startCorners);
  assert.equal(readControlMarker(startGray, width, height, startCorners), START);

  const endGray = renderSyntheticMarker(END_BYTE, realCorners, width, height, {
    syncBits: CONTROL_SYNC_BITS,
  });
  const endCorners = findCornerMarkers(endGray, width, height);
  assert.ok(endCorners);
  assert.equal(readControlMarker(endGray, width, height, endCorners), END);
});

test("readControlMarker returns null for a frame with the DATA signature (not control)", () => {
  const width = 200;
  const height = 200;
  const margin = 10;
  const realCorners = [
    [margin, margin],
    [width - margin, margin],
    [width - margin, height - margin],
    [margin, height - margin],
  ];
  const gray = renderSyntheticMarker(42, realCorners, width, height); // firma de datos, no de control
  const found = findCornerMarkers(gray, width, height);
  assert.ok(found);
  assert.equal(readControlMarker(gray, width, height, found), null);
});

test("readMarkerBits returns null for a frame with the CONTROL signature (not data)", () => {
  const width = 200;
  const height = 200;
  const margin = 10;
  const realCorners = [
    [margin, margin],
    [width - margin, margin],
    [width - margin, height - margin],
    [margin, height - margin],
  ];
  const gray = renderSyntheticMarker(START_BYTE, realCorners, width, height, {
    syncBits: CONTROL_SYNC_BITS,
  });
  const found = findCornerMarkers(gray, width, height);
  assert.ok(found);
  assert.equal(readMarkerBits(gray, width, height, found), null);
});
