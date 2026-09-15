import { test } from "node:test";
import assert from "node:assert/strict";
import { createAssemblyState, advanceAssembly } from "../js/frame-assembler.js";
import { encodeMessage } from "../js/protocol.js";
import { START, END } from "../js/classify.js";

function eventsForFrame(frame) {
  return [{ value: START }, ...Array.from(frame).map((value) => ({ value })), { value: END }];
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

test("ignores data bytes observed before the START marker", () => {
  let state = createAssemblyState();
  ({ state } = advanceAssembly(state, { value: 55 }));
  ({ state } = advanceAssembly(state, { value: 3 }));
  assert.deepEqual(state, createAssemblyState());
});

test("ignores an END marker observed before any START", () => {
  let state = createAssemblyState();
  const { state: next, done } = advanceAssembly(state, { value: END });
  assert.deepEqual(next, createAssemblyState());
  assert.equal(done, null);
});

test("START resets accumulation even mid-transmission (a resend always wins)", () => {
  let state = createAssemblyState();
  ({ state } = advanceAssembly(state, { value: START }));
  ({ state } = advanceAssembly(state, { value: 1 }));
  ({ state } = advanceAssembly(state, { value: 2 }));
  ({ state } = advanceAssembly(state, { value: START })); // arranca de nuevo
  assert.deepEqual(state, { receiving: true, buffer: [] });
});

test("reports a checksum-mismatch error for a corrupted frame and resets state", () => {
  const frame = encodeMessage("Hi");
  const corrupted = Uint8Array.from(frame);
  corrupted[0] ^= 0xff;
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
