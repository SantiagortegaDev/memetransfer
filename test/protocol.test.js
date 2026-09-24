import { test } from "node:test";
import assert from "node:assert/strict";
import {
  START,
  END,
  MAX_PAYLOAD,
  crc16,
  paritySymbols,
  codewordLength,
  payloadLengthForCodeword,
  encodePayload,
  buildTransmission,
  decodeCodeword,
  encodeText,
  decodeText,
  ProtocolError,
} from "../js/protocol.js";
import { ReedSolomonError } from "../js/rs.js";

test("crc16 CCITT-FALSE check value", () => {
  assert.equal(crc16(encodeText("123456789")), 0x29b1);
});

test("parity is ~25% of the codeword with a minimum of 4", () => {
  assert.equal(paritySymbols(1), 4);
  assert.equal(paritySymbols(12), 4);
  assert.equal(paritySymbols(30), 10);
  for (let len = 0; len <= MAX_PAYLOAD; len++) {
    const n = codewordLength(len);
    const nsym = n - (len + 3);
    assert.ok(nsym >= 4);
    if (n > 40) assert.ok(nsym / n >= 0.24 && nsym / n <= 0.27, `len ${len}: ${nsym}/${n}`);
  }
  assert.equal(codewordLength(MAX_PAYLOAD), 255);
});

test("codeword length <-> payload length is a bijection", () => {
  for (let len = 0; len <= MAX_PAYLOAD; len++) assert.equal(payloadLengthForCodeword(codewordLength(len)), len);
  assert.equal(payloadLengthForCodeword(3), -1);
});

test("round trip of text including accents and emoji", () => {
  for (const text of ["hola", "https://example.com/a?b=c", "¿Qué tal? ñandú 🐸", "x".repeat(MAX_PAYLOAD)]) {
    const tx = buildTransmission(encodeText(text));
    assert.equal(tx[0], START);
    assert.equal(tx[tx.length - 1], END);
    const cw = tx.slice(1, -1);
    assert.equal(decodeText(decodeCodeword(cw).payload), text);
  }
});

test("rejects payloads that are too long", () => {
  assert.throws(() => encodePayload(new Uint8Array(MAX_PAYLOAD + 1)), ProtocolError);
});

test("corrects errors and erasures within parity", () => {
  const cw = [...encodePayload(encodeText("mensaje de prueba con errores"))];
  const nsym = cw.length - (29 + 3);
  // nsym/2 - 1 errores + 2 borrados
  const e = Math.floor(nsym / 2) - 1;
  for (let i = 0; i < e; i++) cw[i * 3] ^= 0x55;
  cw[1] = null;
  cw[cw.length - 1] = null;
  assert.equal(decodeText(decodeCodeword(cw).payload), "mensaje de prueba con errores");
});

test("wrong codeword length is rejected", () => {
  const cw = [...encodePayload(encodeText("abcdefghi"))];
  // 17 simbolos: ningun payload produce ese largo (ver payloadLengthForCodeword)
  assert.equal(payloadLengthForCodeword(cw.length + 1), -1);
  assert.throws(() => decodeCodeword([...cw, 0]), ProtocolError);
});

test("too many errors fails loudly instead of returning garbage", () => {
  const cw = [...encodePayload(encodeText("hola mundo"))];
  for (let i = 0; i < cw.length; i += 2) cw[i] ^= 0xa5;
  assert.throws(() => decodeCodeword(cw), (err) => err instanceof ProtocolError || err instanceof ReedSolomonError);
});
