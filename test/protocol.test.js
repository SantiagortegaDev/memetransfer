import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeMessage, decodeFrame, MAX_PAYLOAD_BYTES } from "../js/protocol.js";

test("encodeMessage produces payload + CRC for a known message", () => {
  const frame = encodeMessage("Hola mundo");
  assert.deepEqual(Array.from(frame), [72, 111, 108, 97, 32, 109, 117, 110, 100, 111, 0xb1]);
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

test("decodeFrame round-trips a single-byte message", () => {
  const frame = encodeMessage("a");
  assert.deepEqual(decodeFrame(frame), { ok: true, text: "a" });
});

test("decodeFrame rejects a frame with a corrupted payload byte", () => {
  const frame = encodeMessage("Hola mundo");
  const corrupted = Uint8Array.from(frame);
  corrupted[3] ^= 0x01; // corrompe un byte del payload, CRC queda desactualizado
  assert.deepEqual(decodeFrame(corrupted), { ok: false, error: "checksum-mismatch" });
});

test("decodeFrame rejects an empty frame", () => {
  assert.deepEqual(decodeFrame([]), { ok: false, error: "frame-too-short" });
});
