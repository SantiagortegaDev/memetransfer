import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as L from "../js/layout.js";
import { START, END, NONE, NUM_CLASSES } from "../js/protocol.js";

// El modelo se entrena con el layout/localizador de training/common.py; si
// alguien cambia una constante de un lado y no del otro, el receptor recorta
// distinto de como se entreno. Este test lo detecta.
const py = readFileSync(new URL("../training/common.py", import.meta.url), "utf8");

function pyConst(name) {
  const m = py.match(new RegExp(`^${name} = ([^#\\n]+)`, "m"));
  assert.ok(m, `falta ${name} en training/common.py`);
  return m[1].trim();
}

test("numeric constants match training/common.py", () => {
  const names = [
    "BORDER",
    "OUTER_FRACTION",
    "GAP_GRAY",
    "LOCATE_WIDTH",
    "HUE_MIN",
    "HUE_MAX",
    "SAT_MIN",
    "CHROMA_MIN",
    "MIN_AREA_FRACTION",
    "RING_FILL_MIN",
    "RING_FILL_MAX",
    "MAX_CANDIDATES",
    "CENTER_CROP_FRACTION",
    "GAP_GRID",
    "GAP_RESIDUAL_MAX",
    "GAP_RESIDUAL_NONE_MAX",
  ];
  for (const n of names) assert.equal(Number(pyConst(n)), L[n], n);
});

test("frame color and class ids match", () => {
  const rgb = pyConst("FRAME_RGB").match(/\d+/g).map(Number);
  assert.equal(L.FRAME_COLOR.toLowerCase(), "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join(""));
  assert.equal(Number(pyConst("START")), START);
  assert.equal(Number(pyConst("END")), END);
  assert.equal(Number(pyConst("NONE")), NONE);
  assert.equal(Number(pyConst("NUM_CLASSES")), NUM_CLASSES);
});

test("training accept thresholds match the browser", () => {
  const tr = readFileSync(new URL("../training/train.py", import.meta.url), "utf8");
  assert.equal(Number(tr.match(/^ACCEPT_P = ([\d.]+)/m)[1]), L.ACCEPT_P);
  assert.equal(Number(tr.match(/^ACCEPT_MARGIN = ([\d.]+)/m)[1]), L.ACCEPT_MARGIN);
});
