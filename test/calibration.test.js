import { test } from "node:test";
import assert from "node:assert/strict";
import { Calibration, CALIBRATION_SEQUENCE } from "../js/calibration.js";
import { Segmenter } from "../js/segmenter.js";
import { simulateFrames } from "./helpers/sim.js";

function runCalibration(frames) {
  const cal = new Calibration();
  const seg = new Segmenter({ keepFrames: true, onSlot: (s) => cal.pushSlot(s) });
  frames.forEach((f) => seg.push(f));
  seg.flush();
  return cal;
}

test("clean calibration run: every class seen, perfect accuracy", () => {
  const frames = simulateFrames(CALIBRATION_SEQUENCE, { pUncertain: 0, pWrong: 0, pNone: 0, fpsJitter: 0.1, fps: 15, startOffsetMs: 40 * 650 + 100, passes: 2 });
  const cal = runCalibration(frames);
  const s = cal.summary();
  assert.equal(s.classesSeen, 258);
  assert.equal(s.slotAccuracy, 1);
  assert.equal(s.precisionAccepted, 1);
  assert.equal(s.falseAcceptRate, 0);
  assert.deepEqual(cal.problems(), []);
});

test("a consistently confused meme shows up as a problem", () => {
  const frames = simulateFrames(CALIBRATION_SEQUENCE, { pUncertain: 0.1, pWrong: 0, pNone: 0, fps: 15, seed: 2 });
  // la clase 100 siempre se lee como 7
  const period = 650;
  for (const f of frames) if (!f.gap && f.cls !== null && Math.floor(f.t / period) === 100 && f.cls === 100) f.cls = 7;
  const cal = runCalibration(frames);
  const p = cal.problems();
  assert.equal(p[0].cls, 100);
  assert.equal(p[0].slotAccuracy, 0);
  assert.equal(p[0].confusions[0].cls, 7);
  assert.ok(cal.summary().falseAcceptRate > 0);
});

test("alignment survives a lost slot (anchor re-votes)", () => {
  const frames = simulateFrames(CALIBRATION_SEQUENCE, { pUncertain: 0, pWrong: 0, pNone: 0, fps: 15, seed: 3 });
  // la camara no ve nada entre los simbolos 50 y 51 inclusive (tampoco el gap): se pierde un slot sin marca de tiempo
  const kept = frames.filter((f) => !(f.t >= 50 * 650 && f.t < 51 * 650));
  const cal = runCalibration(kept);
  assert.ok(cal.summary().slotAccuracy > 0.97, JSON.stringify(cal.summary()));
});
