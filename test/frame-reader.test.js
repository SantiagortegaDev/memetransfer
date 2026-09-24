import { test } from "node:test";
import assert from "node:assert/strict";
import { halve, WORK_WIDTH } from "../js/frame-reader.js";
import { LOCATE_WIDTH } from "../js/layout.js";

test("work frame is exactly twice the locator width (2x2 average == cv2.INTER_AREA)", () => {
  assert.equal(WORK_WIDTH, 2 * LOCATE_WIDTH);
});

test("halve averages 2x2 blocks with rounding", () => {
  // canal R de una imagen 4x2, por columna: px[x] = [y0, y1]
  const px = [
    [10, 20],
    [0, 0],
    [30, 41],
    [0, 0],
  ];
  const w = 4;
  const h = 2;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) data[(y * w + x) * 4] = px[x][y];
  }
  const out = halve({ data, width: w, height: h });
  assert.equal(out.width, 2);
  assert.equal(out.height, 1);
  assert.equal(out.data[0], Math.round((10 + 20 + 0 + 0) / 4)); // 7.5 -> 8
  assert.equal(out.data[4], Math.round((30 + 41 + 0 + 0) / 4)); // 17.75 -> 18
  assert.equal(out.data[3], 255);
});
