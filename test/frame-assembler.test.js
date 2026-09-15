import { test } from "node:test";
import assert from "node:assert/strict";
import { createAssemblyState, advanceAssembly } from "../js/frame-assembler.js";
import { encodeMessage } from "../js/protocol.js";

function eventsForFrame(frame) {
  return Array.from(frame).map((index, i) => ({ index, afterLongGap: i === 0 }));
}

test("assembles a full valid frame into the decoded text", () => {
  const frame = encodeMessage("Hi");
  let state = createAssemblyState();
  let done = null;
  for (const event of eventsForFrame(frame)) {
    ({ state, done } = advanceAssembly(state, event));
  }
  assert.deepEqual(done, { ok: true, text: "Hi" });
  assert.deepEqual(state, createAssemblyState());
});

test("ignores symbols observed before the real transmission start", () => {
  let state = createAssemblyState();
  // ruido de fondo: simbolos sin pausa larga previa, no deberian arrancar nada
  ({ state } = advanceAssembly(state, { index: 55, afterLongGap: false }));
  ({ state } = advanceAssembly(state, { index: 3, afterLongGap: false }));
  assert.deepEqual(state, createAssemblyState());
});

test("starts accumulating once the long-gap start marker arrives", () => {
  let state = createAssemblyState();
  const result = advanceAssembly(state, { index: 2, afterLongGap: true });
  assert.deepEqual(result.state, { receiving: true, buffer: [2] });
  assert.equal(result.done, null);
});

test("reports a checksum-mismatch error for a corrupted frame and resets state", () => {
  const frame = encodeMessage("Hi");
  const corrupted = Uint8Array.from(frame);
  corrupted[1] ^= 0xff; // corrompe el primer byte del payload
  let state = createAssemblyState();
  let done = null;
  for (const event of eventsForFrame(corrupted)) {
    ({ state, done } = advanceAssembly(state, event));
  }
  assert.deepEqual(done, { ok: false, error: "checksum-mismatch" });
  assert.deepEqual(state, createAssemblyState());
});

test("can assemble a second message right after the first completes", () => {
  let state = createAssemblyState();
  for (const event of eventsForFrame(encodeMessage("Hi"))) {
    ({ state } = advanceAssembly(state, event));
  }
  let done = null;
  for (const event of eventsForFrame(encodeMessage("Chau"))) {
    ({ state, done } = advanceAssembly(state, event));
  }
  assert.deepEqual(done, { ok: true, text: "Chau" });
});
