import { test } from "node:test";
import assert from "node:assert/strict";
import { rsEncode, rsDecode, ReedSolomonError } from "../js/rs.js";

// PRNG determinista para que los tests sean reproducibles.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytes(rand, n) {
  return Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));
}

function pickPositions(rand, n, count) {
  const all = Array.from({ length: n }, (_, i) => i);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, count);
}

function corrupt(rand, value) {
  return (value ^ (1 + Math.floor(rand() * 255))) & 0xff;
}

test("encode is systematic and a clean codeword decodes unchanged", () => {
  const msg = Uint8Array.from([1, 2, 3, 250, 0, 77]);
  const cw = rsEncode(msg, 6);
  assert.equal(cw.length, 12);
  assert.deepEqual([...cw.slice(0, 6)], [...msg]);
  const { data, corrected } = rsDecode(cw, 6);
  assert.deepEqual([...data], [...msg]);
  assert.deepEqual(corrected, []);
});

test("known vector: 'hello world' with 10 parity symbols (matches reedsolo)", () => {
  const msg = new TextEncoder().encode("hello world");
  const cw = rsEncode(msg, 10);
  assert.deepEqual(
    [...cw.slice(11)],
    [0xed, 0x25, 0x54, 0xc4, 0xfd, 0xfd, 0x89, 0xf3, 0xa8, 0xaa]
  );
});

test("corrects errors exactly at capacity (2e = nsym)", () => {
  const rand = rng(1);
  for (let trial = 0; trial < 200; trial++) {
    const k = 1 + Math.floor(rand() * 180);
    const nsym = 4 + Math.floor(rand() * 40);
    if (k + nsym > 255) continue;
    const msg = randomBytes(rand, k);
    const cw = Array.from(rsEncode(msg, nsym));
    for (const p of pickPositions(rand, cw.length, Math.floor(nsym / 2))) cw[p] = corrupt(rand, cw[p]);
    const { data } = rsDecode(cw, nsym);
    assert.deepEqual([...data], [...msg], `trial ${trial}`);
  }
});

test("corrects erasures exactly at capacity (erasures = nsym)", () => {
  const rand = rng(2);
  for (let trial = 0; trial < 200; trial++) {
    const k = 1 + Math.floor(rand() * 180);
    const nsym = 4 + Math.floor(rand() * 40);
    if (k + nsym > 255) continue;
    const msg = randomBytes(rand, k);
    const cw = Array.from(rsEncode(msg, nsym));
    for (const p of pickPositions(rand, cw.length, nsym)) cw[p] = null;
    const { data } = rsDecode(cw, nsym);
    assert.deepEqual([...data], [...msg], `trial ${trial}`);
  }
});

test("corrects mixed errors + erasures at capacity (2e + f = nsym)", () => {
  const rand = rng(3);
  for (let trial = 0; trial < 300; trial++) {
    const k = 1 + Math.floor(rand() * 180);
    const nsym = 4 + Math.floor(rand() * 40);
    if (k + nsym > 255) continue;
    const e = Math.floor(rand() * (nsym / 2 + 1));
    const f = nsym - 2 * e;
    const msg = randomBytes(rand, k);
    const cw = Array.from(rsEncode(msg, nsym));
    const pos = pickPositions(rand, cw.length, e + f);
    pos.slice(0, e).forEach((p) => (cw[p] = corrupt(rand, cw[p])));
    const erased = pos.slice(e);
    // Mitad como null, mitad como posiciones explicitas (con basura en el valor).
    const explicit = [];
    erased.forEach((p, i) => {
      if (i % 2) cw[p] = null;
      else {
        cw[p] = Math.floor(rand() * 256);
        explicit.push(p);
      }
    });
    const { data } = rsDecode(cw, nsym, explicit);
    assert.deepEqual([...data], [...msg], `trial ${trial} e=${e} f=${f}`);
  }
});

test("maximum length codeword (255 symbols) at capacity", () => {
  const rand = rng(4);
  const msg = randomBytes(rand, 191);
  const cw = Array.from(rsEncode(msg, 64));
  for (const p of pickPositions(rand, 255, 32)) cw[p] = corrupt(rand, cw[p]);
  assert.deepEqual([...rsDecode(cw, 64).data], [...msg]);
});

test("beyond capacity it throws (or never silently returns the wrong message without detection)", () => {
  const rand = rng(5);
  let threw = 0;
  for (let trial = 0; trial < 100; trial++) {
    const msg = randomBytes(rand, 40);
    const nsym = 10;
    const cw = Array.from(rsEncode(msg, nsym));
    for (const p of pickPositions(rand, cw.length, 6)) cw[p] = corrupt(rand, cw[p]);
    try {
      const { data } = rsDecode(cw, nsym);
      // Una decodificacion "exitosa" mas alla de la capacidad es un codeword
      // distinto: por eso el protocolo agrega un CRC-16 encima.
      assert.notDeepEqual([...data], [...msg]);
    } catch (err) {
      assert.ok(err instanceof ReedSolomonError);
      threw++;
    }
  }
  assert.ok(threw > 80, `solo ${threw}/100 fallaron explicitamente`);
});

test("too many erasures throws", () => {
  const cw = Array.from(rsEncode([1, 2, 3], 4));
  assert.throws(() => rsDecode([null, null, null, null, null, ...cw.slice(5)], 4), ReedSolomonError);
});
