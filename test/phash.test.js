import { test } from "node:test";
import assert from "node:assert/strict";

// Test de phash.js sin navegador: simulamos los pedazos del modulo que
// no dependen de canvas/DOM. Las funciones puras (dct2d, hammingDistance)
// son testeables aisladas; computePHash requiere canvas y se prueba
// manualmente en el navegador.

// Importamos solo lo que no toca el DOM. Usamos un import dinamico para
// poder capturar el modulo aunque su top-level ejecute codigo de
// inicializacion (la tabla de cosenos).
const phashModule = await import("../js/phash.js");
const { hammingDistance } = phashModule;

test("hammingDistance: distancia 0 entre hashes identicas", () => {
  const a = new Uint8Array([0xff, 0x00, 0xaa, 0x55, 0xff, 0x00, 0xaa, 0x55]);
  assert.equal(hammingDistance(a, a), 0);
});

test("hammingDistance: distancia 64 entre hashes complementarias", () => {
  const a = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const b = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  assert.equal(hammingDistance(a, b), 64);
});

test("hammingDistance: distancia correcta para un bit que cambia en cada byte", () => {
  const a = new Uint8Array([0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000]);
  const b = new Uint8Array([0b00000001, 0b00000010, 0b00000100, 0b00001000, 0b00010000, 0b00100000, 0b01000000, 0b10000000]);
  // 1 bit por byte, 8 bytes -> 8 bits de diferencia
  assert.equal(hammingDistance(a, b), 8);
});

test("hammingDistance: es simetrica", () => {
  const a = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
  const b = new Uint8Array([0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89]);
  assert.equal(hammingDistance(a, b), hammingDistance(b, a));
});
