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

// Hash actual: 32 bytes (256 bits). Tests con arrays de 32 bytes.

test("hammingDistance: distancia 0 entre hashes identicas", () => {
  const a = new Uint8Array(32);
  for (let i = 0; i < 32; i++) a[i] = (i * 13) & 0xff; // contenido variado
  assert.equal(hammingDistance(a, a), 0);
});

test("hammingDistance: distancia 256 entre hashes complementarias (todo 0 vs todo 1)", () => {
  const a = new Uint8Array(32); // todos 0
  const b = new Uint8Array(32); // todos 0xff
  b.fill(0xff);
  assert.equal(hammingDistance(a, b), 256);
});

test("hammingDistance: distancia correcta para un bit que cambia en cada byte", () => {
  const a = new Uint8Array(32); // todos 0
  const b = new Uint8Array(32); // bit i activado en byte i (8 bits en total)
  for (let i = 0; i < 8; i++) {
    b[i] = 1 << (7 - i);
  }
  // Solo los primeros 8 bytes tienen un bit activado -> 8 bits de diferencia
  assert.equal(hammingDistance(a, b), 8);
});

test("hammingDistance: es simetrica", () => {
  const a = new Uint8Array(32);
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    a[i] = (i * 17 + 31) & 0xff;
    b[i] = (i * 23 + 7) & 0xff;
  }
  assert.equal(hammingDistance(a, b), hammingDistance(b, a));
});

test("hammingDistance: distancia de 32 bits con patron diagonal en 4 bytes", () => {
  const a = new Uint8Array(32); // todos 0
  const b = new Uint8Array(32);
  // Llena los primeros 4 bytes con 0xff = 32 bits activados
  b[0] = 0xff;
  b[1] = 0xff;
  b[2] = 0xff;
  b[3] = 0xff;
  assert.equal(hammingDistance(a, b), 32);
});
