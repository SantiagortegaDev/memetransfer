import { test } from "node:test";
import assert from "node:assert/strict";
import { SymbolStream } from "../js/matcher.js";

function feed(stream, ticks) {
  return ticks.map((t) => stream.tick(t)).filter((e) => e !== null);
}

test("emits a value after stableTicksRequired consecutive matches", () => {
  const stream = new SymbolStream({ stableTicksRequired: 3 });
  const events = feed(stream, [7, 7, 7]);
  assert.deepEqual(events, [{ value: 7 }]);
});

test("does not emit before reaching the stability threshold", () => {
  const stream = new SymbolStream({ stableTicksRequired: 3 });
  const events = feed(stream, [7, 7]);
  assert.deepEqual(events, []);
});

test("works with string sentinels like START/END, not just numbers", () => {
  const stream = new SymbolStream({ stableTicksRequired: 3 });
  const events = feed(stream, ["START", "START", "START"]);
  assert.deepEqual(events, [{ value: "START" }]);
});

test("does not re-emit the same value while it keeps being observed without a gap", () => {
  const stream = new SymbolStream({ stableTicksRequired: 3 });
  const events = feed(stream, [7, 7, 7, 7, 7, 7, 7]);
  assert.deepEqual(events, [{ value: 7 }]);
});

test("re-arms after a gap and can emit the same value again", () => {
  const stream = new SymbolStream({ stableTicksRequired: 3 });
  const events = feed(stream, [7, 7, 7, null, 7, 7, 7]);
  assert.deepEqual(events, [{ value: 7 }, { value: 7 }]);
});

test("noisy flicker between candidates does not falsely confirm either one", () => {
  const stream = new SymbolStream({ stableTicksRequired: 3 });
  const events = feed(stream, [1, 2, 1, 2, 1, 2]);
  assert.deepEqual(events, []);
});

test("recovers and confirms once the flicker settles on one candidate", () => {
  const stream = new SymbolStream({ stableTicksRequired: 3 });
  const events = feed(stream, [1, 2, 3, 3, 3]);
  assert.deepEqual(events, [{ value: 3 }]);
});

test("transitions cleanly between a START marker and a data byte", () => {
  const stream = new SymbolStream({ stableTicksRequired: 3 });
  const events = feed(stream, ["START", "START", "START", null, 42, 42, 42]);
  assert.deepEqual(events, [{ value: "START" }, { value: 42 }]);
});

test("reset clears internal state as if freshly constructed", () => {
  const stream = new SymbolStream({ stableTicksRequired: 3 });
  feed(stream, [7, 7, 7]);
  stream.reset();
  const events = feed(stream, [7, 7, 7]);
  assert.deepEqual(events, [{ value: 7 }]);
});
