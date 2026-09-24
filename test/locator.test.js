import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { locateFrame, cropInterior, centerCrop, gapResidual, convexHull, magentaMask } from "../js/locator.js";
import { BORDER, GAP_GRAY } from "../js/layout.js";

function rgbToRgba(buf, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < w * h * 3; i += 3, j += 4) {
    out[j] = buf[i];
    out[j + 1] = buf[i + 1];
    out[j + 2] = buf[i + 2];
    out[j + 3] = 255;
  }
  return { data: out, width: w, height: h };
}

/** Dibuja el emisor (marco magenta + interior) rotado y en perspectiva leve. */
function drawScene({ w = 320, h = 240, cx = 160, cy = 120, side = 150, angle = 0.3, interior = "texture" }) {
  const img = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // coordenadas en el marco del cuadrado (0..1)
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const u = (c * dx + s * dy) / side + 0.5;
      const v = (-s * dx + c * dy) / side + 0.5;
      const i = (y * w + x) * 4;
      let rgb = [30 + ((x * 7) % 40), 60, 50 + ((y * 3) % 30)]; // fondo
      if (u >= 0 && u < 1 && v >= 0 && v < 1) {
        const inner = u >= BORDER && u < 1 - BORDER && v >= BORDER && v < 1 - BORDER;
        if (!inner) rgb = [255, 0, 170];
        else if (interior === "gray") rgb = [GAP_GRAY, GAP_GRAY, GAP_GRAY];
        else rgb = [((u * 8) | 0) % 2 ? 230 : 20, ((v * 5) | 0) % 2 ? 200 : 40, 90];
      }
      img.data.set([...rgb, 255], i);
    }
  }
  return img;
}

test("finds a rotated frame and orders corners clockwise from top-left", () => {
  const { quad, status } = locateFrame(drawScene({ angle: 0.3 }));
  assert.equal(status, "ok");
  // esquinas reales
  const c = Math.cos(0.3);
  const s = Math.sin(0.3);
  const real = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ].map(([u, v]) => [160 + 150 * (c * u - s * v), 120 + 150 * (s * u + c * v)]);
  // con rotacion +0.3 rad la esquina de menor x+y es la real [0]
  for (let k = 0; k < 4; k++) {
    assert.ok(Math.hypot(quad[k][0] - real[k][0], quad[k][1] - real[k][1]) < 2.5, `corner ${k}: ${quad[k]} vs ${real[k]}`);
  }
});

test("frame touching the image border is reported as cut", () => {
  const { quad, status } = locateFrame(drawScene({ cx: 60, side: 180, angle: 0 }));
  assert.equal(quad, null);
  assert.equal(status, "cut");
});

test("no magenta -> none", () => {
  const img = drawScene({ side: 0.001 });
  assert.deepEqual(locateFrame(img), { quad: null, status: "none" });
});

test("a filled magenta blob is not accepted as a frame", () => {
  const blob = drawScene({ side: 0.001 });
  for (let y = 60; y < 180; y++) for (let x = 100; x < 220; x++) blob.data.set([255, 0, 170, 255], (y * 320 + x) * 4);
  assert.equal(locateFrame(blob).quad, null);
});

test("crop of the gray gap has ~0 residual; crop of textured interior is high", () => {
  const gap = drawScene({ interior: "gray" });
  const tex = drawScene({ interior: "texture" });
  const qg = locateFrame(gap).quad;
  const qt = locateFrame(tex).quad;
  assert.ok(gapResidual(cropInterior(gap, qg, 64)) < 1.5);
  assert.ok(gapResidual(cropInterior(tex, qt, 64)) > 20);
});

test("convexHull of a square with interior points", () => {
  const h = convexHull([
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
    [1, 1],
    [1, 0],
  ]);
  assert.equal(h.length, 4);
});

test("magentaMask accepts camera-shifted magentas and rejects red/purple/pink-gray", () => {
  const cols = [
    [255, 0, 170, 1],
    [240, 60, 200, 1],
    [200, 30, 120, 1],
    [255, 40, 40, 0], // rojo
    [120, 60, 255, 0], // violeta-azul
    [200, 170, 190, 0], // rosa grisaceo (poca saturacion)
  ];
  const img = { data: new Uint8ClampedArray(cols.flatMap(([r, g, b]) => [r, g, b, 255])), width: cols.length, height: 1 };
  assert.deepEqual([...magentaMask(img)], cols.map((c) => c[3]));
});

test("parity with the Python locator on synthetic camera images", () => {
  const cases = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/locator.json.gz", import.meta.url))).toString());
  assert.ok(cases.length >= 5);
  for (const [i, c] of cases.entries()) {
    const img = rgbToRgba(Buffer.from(c.rgb, "base64"), c.width, c.height);
    const { quad, status } = locateFrame(img);
    assert.equal(status, c.status, `caso ${i}`);
    if (c.quad) {
      for (let k = 0; k < 4; k++) {
        const d = Math.hypot(quad[k][0] - c.quad[k][0], quad[k][1] - c.quad[k][1]);
        assert.ok(d < 0.75, `caso ${i} esquina ${k}: js ${quad[k]} py ${c.quad[k]}`);
      }
      const crop = cropInterior(img, quad, 64);
      const ref = Buffer.from(c.crop64_rgb, "base64");
      let diff = 0;
      for (let p = 0; p < 64 * 64; p++) for (let ch = 0; ch < 3; ch++) diff += Math.abs(crop.data[p * 4 + ch] - ref[p * 3 + ch]);
      assert.ok(diff / (64 * 64 * 3) < 6, `caso ${i}: diferencia media del recorte ${diff / (64 * 64 * 3)}`);
      assert.ok(Math.abs(gapResidual(crop) - c.residual) < 1.0 + 0.1 * c.residual, `caso ${i}: residuo js ${gapResidual(crop)} py ${c.residual}`);
    } else {
      const crop = centerCrop(img, 64);
      const ref = Buffer.from(c.center64_rgb, "base64");
      let diff = 0;
      for (let p = 0; p < 64 * 64; p++) for (let ch = 0; ch < 3; ch++) diff += Math.abs(crop.data[p * 4 + ch] - ref[p * 3 + ch]);
      assert.ok(diff / (64 * 64 * 3) < 6, `caso ${i}: recorte central difiere ${diff / (64 * 64 * 3)}`);
    }
  }
});
