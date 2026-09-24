import { test } from "node:test";
import assert from "node:assert/strict";
import { Segmenter } from "../js/segmenter.js";
import { START, END, NONE } from "../js/protocol.js";
import { simulateFrames } from "./helpers/sim.js";

function segment(frames, opts) {
  const slots = [];
  const seg = new Segmenter({ onSlot: (s) => slots.push(s), ...opts });
  frames.forEach((f) => seg.push(f));
  seg.flush();
  return slots;
}

const SEQ = [START, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, END];

test("clean stream yields exactly one slot per symbol", () => {
  const slots = segment(simulateFrames(SEQ, { pUncertain: 0, pWrong: 0, pNone: 0, fpsJitter: 0 }));
  assert.deepEqual(slots.map((s) => s.cls), SEQ);
  assert.ok(slots.every((s) => s.reliability > 0.9));
});

test("frame jitter, uncertain, NONE and wrong frames do not change the slot sequence", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const slots = segment(simulateFrames(SEQ, { seed, pUncertain: 0.2, pWrong: 0.05, pNone: 0.05, fps: 15 }));
    assert.deepEqual(slots.map((s) => s.cls), SEQ, `seed ${seed}`);
  }
});

test("a slot where every frame is uncertain becomes an erasure (null), not a lost slot", () => {
  const frames = simulateFrames(SEQ, { pUncertain: 0, pWrong: 0, pNone: 0, fpsJitter: 0 });
  // simbolo 5 (valor 50): 2750..3250 ms
  for (const f of frames) if (!f.gap && f.t >= 3250 && f.t < 3750) f.cls = null;
  const slots = segment(frames);
  assert.equal(slots.length, SEQ.length);
  assert.equal(slots[5].cls, null);
  assert.equal(slots[5].reliability, 0);
});

test("missed gap between two different memes is split by class change", () => {
  const frames = simulateFrames(SEQ, { pUncertain: 0, pWrong: 0, pNone: 0, fpsJitter: 0, pTransitionNone: 0 });
  // se borra el gap entre el simbolo 3 (30) y el 4 (40): 2450..2600 ms
  const kept = frames.filter((f) => !(f.gap && f.t >= 2450 && f.t < 2600));
  assert.deepEqual(segment(kept, { timing: false }).map((s) => s.cls), SEQ);
});

test("missed gap between two identical memes ('ll') is recovered from timing", () => {
  const seq = [START, 1, 2, 3, 4, 5, 6, 7, 108, 108, 9, 10, END];
  const frames = simulateFrames(seq, { pUncertain: 0, pWrong: 0, pNone: 0, fpsJitter: 0.2, seed: 3 });
  // gap entre los dos 108 (indices 8 y 9): 8*650+500 .. 9*650
  const kept = frames.filter((f) => !(f.gap && f.t >= 8 * 650 + 500 && f.t < 9 * 650));
  const slots = segment(kept);
  assert.deepEqual(slots.map((s) => s.cls), seq);
  assert.ok(slots[9].synthetic);
});

test("a symbol with no frames at all (occluded) becomes an erasure at the right position", () => {
  const frames = simulateFrames(SEQ, { pUncertain: 0, pWrong: 0, pNone: 0, fpsJitter: 0.2, seed: 5 });
  // simbolo 9 (90) completo + su gap se reemplazan por frames grises (la camara ve el gap pero no el meme)
  const kept = frames.map((f) => (f.t >= 9 * 650 - 150 && f.t < 10 * 650 ? { ...f, gap: true, cls: null } : f));
  const slots = segment(kept);
  assert.deepEqual(slots.map((s) => s.cls), SEQ.map((s, i) => (i === 9 ? null : s)));
});

test("a long interruption is reported as a break", () => {
  const frames = simulateFrames(SEQ, { pUncertain: 0, pWrong: 0, pNone: 0, fpsJitter: 0, passes: 2 });
  const cut = frames.filter((f) => f.t < 7 * 650 || f.t >= 7 * 650 + 8000).map((f) => f);
  const slots = segment(cut);
  assert.ok(slots.some((s) => s.break));
});

test("isolated noise frame inside a gap does not create a slot", () => {
  const frames = simulateFrames(SEQ, { pUncertain: 0, pWrong: 0, pNone: 0, fpsJitter: 0, fps: 30 });
  const g = frames.findIndex((f) => f.gap && f.t > 2000);
  frames.splice(g + 1, 0, { t: frames[g].t + 1, gap: false, cls: NONE, p: 0.9 });
  assert.equal(segment(frames).length, SEQ.length);
});

test("a spurious gap frame in the middle of a meme does not split the slot (merge-back)", () => {
  const frames = simulateFrames(SEQ, { pUncertain: 0, pWrong: 0, pNone: 0, fpsJitter: 0.2, seed: 8 });
  // un frame en mitad del simbolo 8 (80) se marca como gap
  const i = frames.findIndex((f) => !f.gap && f.t > 8 * 650 + 200);
  frames[i] = { ...frames[i], gap: true, cls: null };
  assert.deepEqual(segment(frames).map((s) => s.cls), SEQ);
});

test("slots are emitted one slot late; flush emits the pending one", () => {
  const slots = [];
  const seg = new Segmenter({ onSlot: (s) => slots.push(s) });
  const frames = simulateFrames([START, 1, 2, END], { pUncertain: 0, pWrong: 0, pNone: 0, fpsJitter: 0 });
  frames.forEach((f) => seg.push(f));
  assert.equal(slots.length, 3);
  seg.flush();
  assert.equal(slots.length, 4);
});

test("flush called re-entrantly from onSlot does not emit the pending slot twice", () => {
  const slots = [];
  const seg = new Segmenter({
    onSlot: (s) => {
      slots.push(s);
      seg.flush();
    },
  });
  simulateFrames([START, 1, 2, END], { pUncertain: 0, pWrong: 0, pNone: 0, fpsJitter: 0 }).forEach((f) => seg.push(f));
  seg.flush();
  assert.deepEqual(slots.map((s) => s.cls), [START, 1, 2, END]);
});
