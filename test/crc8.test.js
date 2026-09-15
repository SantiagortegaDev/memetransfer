import { test } from "node:test";
import assert from "node:assert/strict";
import { crc8 } from "../js/crc8.js";

test("crc8 of empty input is 0", () => {
  assert.equal(crc8([]), 0x00);
});

test("crc8 matches the standard CRC-8 check value for '123456789'", () => {
  const bytes = new TextEncoder().encode("123456789");
  assert.equal(crc8(bytes), 0xf4);
});

test("crc8 of the UTF-8 bytes for 'Hello'", () => {
  const bytes = [72, 101, 108, 108, 111];
  assert.equal(crc8(bytes), 0xf6);
});

test("crc8 of the UTF-8 bytes for 'Hola mundo'", () => {
  const bytes = [72, 111, 108, 97, 32, 109, 117, 110, 100, 111];
  assert.equal(crc8(bytes), 0xb1);
});

test("crc8 changes when any byte flips", () => {
  const original = [72, 111, 108, 97, 32, 109, 117, 110, 100, 111];
  const corrupted = [...original];
  corrupted[3] ^= 0x01;
  assert.notEqual(crc8(corrupted), crc8(original));
});
