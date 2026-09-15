import { test } from "node:test";
import assert from "node:assert/strict";
import { SymbolStream } from "../js/matcher.js";

function feed(stream, ticks) {
  return ticks.map((t) => stream.tick(t)).filter((e) => e !== null);
}

test("emits a symbol after stableTicksRequired consecutive matches", () => {
  const stream = new SymbolStream({ stableTicksRequired: 3, longGapTicksRequired: 5 });
  const events = feed(stream, [7, 7, 7]);
  assert.deepEqual(events, [{ index: 7, afterLongGap: false }]);
});

test("does not emit before reaching the stability threshold", () => {
  const stream = new SymbolStream({ stableTicksRequired: 3, longGapTicksRequired: 5 });
  const events = feed(stream, [7, 7]);
  assert.deepEqual(events, []);
});

test("flags afterLongGap when the preceding gap is long enough", () => {
  const stream = new SymbolStream({ stableTicksRequired: 3, longGapTicksRequired: 5 });
  const events = feed(stream, [null, null, null, null, null, 9, 9, 9]);
  assert.deepEqual(events, [{ index: 9, afterLongGap: true }]);
});

test("does not flag afterLongGap when the preceding gap is short", () => {
  const stream = new SymbolStream({ stableTicksRequired: 3, longGapTicksRequired: 5 });
  const events = feed(stream, [null, 42, 42, 42]);
  assert.deepEqual(events, [{ index: 42, afterLongGap: false }]);
});

test("does not re-emit the same symbol while it keeps being observed without a gap", () => {
  const stream = new SymbolStream({ stableTicksRequired: 3, longGapTicksRequired: 5 });
  const events = feed(stream, [7, 7, 7, 7, 7, 7, 7]);
  assert.deepEqual(events, [{ index: 7, afterLongGap: false }]);
});

test("re-arms after a gap and can emit the same symbol again", () => {
  const stream = new SymbolStream({ stableTicksRequired: 3, longGapTicksRequired: 5 });
  const events = feed(stream, [7, 7, 7, null, 7, 7, 7]);
  assert.deepEqual(events, [
    { index: 7, afterLongGap: false },
    { index: 7, afterLongGap: false },
  ]);
});

test("noisy flicker between candidates does not falsely confirm either one", () => {
  const stream = new SymbolStream({ stableTicksRequired: 3, longGapTicksRequired: 5 });
  const events = feed(stream, [1, 2, 1, 2, 1, 2]);
  assert.deepEqual(events, []);
});

test("recovers and confirms once the flicker settles on one candidate", () => {
  const stream = new SymbolStream({ stableTicksRequired: 3, longGapTicksRequired: 5 });
  const events = feed(stream, [1, 2, 3, 3, 3]);
  assert.deepEqual(events, [{ index: 3, afterLongGap: false }]);
});

test("reset clears internal state as if freshly constructed", () => {
  const stream = new SymbolStream({ stableTicksRequired: 3, longGapTicksRequired: 5 });
  feed(stream, [7, 7, 7]);
  stream.reset();
  const events = feed(stream, [7, 7, 7]);
  assert.deepEqual(events, [{ index: 7, afterLongGap: false }]);
});
