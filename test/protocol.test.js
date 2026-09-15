import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeMessage, decodeFrame, totalFrameLength, MAX_PAYLOAD_BYTES } from "../js/protocol.js";

test("encodeMessage produces LEN + payload + CRC for a known message", () => {
  const frame = encodeMessage("Hola mundo");
  assert.deepEqual(Array.from(frame), [10, 72, 111, 108, 97, 32, 109, 117, 110, 100, 111, 0x77]);
});

test("encodeMessage throws RangeError when the payload exceeds MAX_PAYLOAD_BYTES", () => {
  const tooLong = "a".repeat(MAX_PAYLOAD_BYTES + 1);
  assert.throws(() => encodeMessage(tooLong), RangeError);
});

test("decodeFrame round-trips a message encoded by encodeMessage", () => {
  const frame = encodeMessage("https://x.com");
  const result = decodeFrame(frame);
  assert.deepEqual(result, { ok: true, text: "https://x.com" });
});

test("decodeFrame round-trips text with accented/multibyte UTF-8 characters", () => {
  const frame = encodeMessage("¡Hola, ñoño! 🎉");
  const result = decodeFrame(frame);
  assert.deepEqual(result, { ok: true, text: "¡Hola, ñoño! 🎉" });
});

test("decodeFrame rejects a frame whose length does not match LEN", () => {
  const frame = encodeMessage("Hola mundo");
  const truncated = frame.slice(0, frame.length - 2); // falta el ultimo byte de payload y el CRC
  assert.deepEqual(decodeFrame(truncated), { ok: false, error: "length-mismatch" });
});

test("decodeFrame rejects a frame with a corrupted payload byte", () => {
  const frame = encodeMessage("Hola mundo");
  const corrupted = Uint8Array.from(frame);
  corrupted[3] ^= 0x01; // corrompe un byte del payload, CRC queda desactualizado
  assert.deepEqual(decodeFrame(corrupted), { ok: false, error: "checksum-mismatch" });
});

test("decodeFrame rejects input shorter than the minimum frame size", () => {
  assert.deepEqual(decodeFrame([5]), { ok: false, error: "frame-too-short" });
});

test("totalFrameLength accounts for LEN and CRC bytes", () => {
  assert.equal(totalFrameLength(0), 2);
  assert.equal(totalFrameLength(10), 12);
  assert.equal(totalFrameLength(255), 257);
});
