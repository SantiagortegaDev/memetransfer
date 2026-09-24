import { test } from "node:test";
import assert from "node:assert/strict";
import { Receiver, alignToConsensus } from "../js/receiver.js";
import { Segmenter } from "../js/segmenter.js";
import { buildTransmission, encodeText, paritySymbols } from "../js/protocol.js";
import { simulateFrames, rng } from "./helpers/sim.js";

function run(text, simOpts) {
  const tx = buildTransmission(encodeText(text));
  const rx = new Receiver();
  let result = null;
  let slotsUntilResult = 0;
  const seg = new Segmenter({
    onSlot: (s) => {
      if (result) return;
      slotsUntilResult++;
      result = rx.pushSlot(s) ?? result;
    },
  });
  for (const f of simulateFrames(tx, simOpts)) seg.push(f);
  seg.flush();
  return { result, slotsUntilResult, tx, rx };
}

function feedSlots(rx, symbols) {
  let res = null;
  for (const cls of symbols) res = rx.pushSlot({ cls, reliability: cls === null ? 0 : 0.9 }) ?? res;
  return res;
}

test("clean single pass decodes, before or at END", () => {
  const { result, slotsUntilResult, tx } = run("hola mundo", { pUncertain: 0.1 });
  assert.equal(result?.text, "hola mundo");
  assert.ok(slotsUntilResult <= tx.length);
});

test("URL of 150 characters decodes in one noisy pass", () => {
  const url = "https://example.com/" + "a1b2c3d4e5".repeat(13);
  const { result } = run(url, { pUncertain: 0.25, pWrong: 0.05, pNone: 0.05, seed: 9 });
  assert.equal(result?.text, url);
});

test("errors up to capacity in a single pass are corrected", () => {
  const text = "capacidad al limite";
  const tx = buildTransmission(encodeText(text));
  const n = tx.length - 2;
  const nsym = paritySymbols(text.length + 3);
  const rx = new Receiver();
  const cw = tx.slice(1, -1);
  const rand = rng(4);
  const bad = new Set();
  while (bad.size < Math.floor(nsym / 2)) bad.add(1 + Math.floor(rand() * (n - 1)));
  const corrupted = cw.map((s, i) => (bad.has(i) ? (s + 1 + Math.floor(rand() * 254)) % 256 : s));
  const res = feedSlots(rx, [tx[0], ...corrupted, tx[tx.length - 1]]);
  assert.equal(res?.text, text);
});

test("GMD: more wrong symbols than nsym/2 decode when they are the least reliable ones", () => {
  const text = "gmd decoding test";
  const tx = buildTransmission(encodeText(text));
  const nsym = paritySymbols(text.length + 3);
  const rx = new Receiver();
  const wrong = nsym - 1; // > nsym/2 errores, pero marcados como dudosos
  let res = rx.pushSlot({ cls: tx[0], reliability: 1 });
  tx.slice(1).forEach((s, i) => {
    const isBad = i >= 2 && i < 2 + wrong;
    res = rx.pushSlot({ cls: isBad ? (s + 7) % 256 : s, reliability: isBad ? 0.1 : 0.95 }) ?? res;
  });
  assert.equal(res?.text, text);
});

test("receiver joins mid-stream and decodes using tail + later passes", () => {
  const text = "enganche a mitad";
  const tx = buildTransmission(encodeText(text));
  const { result } = run(text, { passes: 2, startOffsetMs: Math.floor(tx.length / 2) * 650, seed: 11 });
  assert.equal(result?.text, text);
});

test("too many errors in each pass, but in different places: voting across passes decodes", () => {
  const text = "votacion entre pasadas";
  const tx = buildTransmission(encodeText(text));
  const nsym = paritySymbols(text.length + 3);
  const rx = new Receiver();
  const n = tx.length - 2;
  let res = null;
  for (let p = 0; p < 3; p++) {
    const rand = rng(100 + p);
    const bad = new Set();
    while (bad.size < nsym) bad.add(Math.floor(rand() * n)); // 2x la capacidad por pasada
    const cw = tx.slice(1, -1).map((s, i) => (bad.has(i) ? (s + 1 + p) % 256 : s));
    res = feedSlots(rx, [tx[0], ...cw, tx[tx.length - 1]]) ?? res;
    if (p === 0) assert.equal(res, null, "la primera pasada sola no deberia alcanzar");
  }
  assert.equal(res?.text, text);
});

test("a pass with one lost slot decodes by trying every insertion point", () => {
  const text = "slot perdido";
  const tx = buildTransmission(encodeText(text));
  const rx = new Receiver();
  const cw = tx.slice(1, -1);
  cw.splice(7, 1);
  assert.equal(feedSlots(rx, [tx[0], ...cw, tx[tx.length - 1]])?.text, text);
});

test("a pass with one extra slot decodes by trying every deletion point", () => {
  const text = "slot de mas";
  const tx = buildTransmission(encodeText(text));
  const rx = new Receiver();
  const cw = tx.slice(1, -1);
  cw.splice(4, 0, 99);
  assert.equal(feedSlots(rx, [tx[0], ...cw, tx[tx.length - 1]])?.text, text);
});

test("misaligned passes contribute votes after DP alignment", () => {
  const text = "alineacion con programacion dinamica";
  const tx = buildTransmission(encodeText(text));
  const cw = tx.slice(1, -1);
  const nsym = paritySymbols(text.length + 3);
  const rx = new Receiver();
  // pasada 1: largo correcto pero con demasiados borrados para decodificar sola
  const p1 = cw.map((s, i) => (i % 3 === 0 ? null : s));
  assert.ok(p1.filter((s) => s === null).length > nsym);
  assert.equal(feedSlots(rx, [tx[0], ...p1, tx[tx.length - 1]]), null);
  // pasada 2: le falta un slot (desalineada) y tiene errores repartidos; sola no decodifica
  const p2 = cw.map((s, i) => (i % 3 === 1 ? (s + 3) % 256 : s));
  p2.splice(10, 1);
  const res = feedSlots(rx, [tx[0], ...p2, tx[tx.length - 1]]);
  assert.equal(res?.text, text);
});

test("alignToConsensus maps around a deletion", () => {
  const consensus = [1, 2, 3, 4, 5, 6, 7, 8];
  const map = alignToConsensus({ symbols: [1, 2, 3, 5, 6, 7, 8] }, consensus);
  assert.equal(map.get(3), 4);
  assert.equal(map.get(6), 7);
});

test("END missed: the next START closes the pass and it still decodes", () => {
  const text = "sin END";
  const tx = buildTransmission(encodeText(text));
  const rx = new Receiver();
  const body = tx.slice(0, -1);
  // leemos la primera pasada con 60% de borrados (no decodifica), sin END, y luego una limpia
  const res1 = feedSlots(rx, body.map((s, i) => (i > 0 && i % 5 < 3 ? null : s)));
  assert.equal(res1, null);
  assert.equal(feedSlots(rx, tx)?.text, text);
});

test("noisy streams: missed gaps, occlusions and misreads decode within 3 passes", () => {
  const text = "https://github.com/santiagortegadev/memetransfer";
  let ok = 0;
  const N = 40;
  for (let seed = 1; seed <= N; seed++) {
    const { result } = run(text, {
      seed,
      passes: 3,
      fps: 12,
      pUncertain: 0.3,
      pWrong: 0.06,
      pNone: 0.05,
      pMissGap: 0.08,
      pDropSymbol: 0.05,
    });
    if (result?.text === text) ok++;
    else assert.equal(result, null, `seed ${seed}: decodifico algo incorrecto`);
  }
  assert.ok(ok >= N - 1, `solo ${ok}/${N} decodificaron`);
});

test("random garbage never produces a (false) decode", () => {
  const rand = rng(77);
  const rx = new Receiver();
  for (let i = 0; i < 3000; i++) {
    const r = rand();
    const cls = r < 0.02 ? 256 : r < 0.04 ? 257 : r < 0.1 ? null : Math.floor(rand() * 256);
    assert.equal(rx.pushSlot({ cls, reliability: rand() }), null);
  }
});

test("START never recognized (read as erasure or vanished): END-to-END passes still give the length", () => {
  const text = "sin START";
  const tx = buildTransmission(encodeText(text));
  const body = tx.slice(1); // codeword + END
  for (const startAs of ["erasure", "vanished"]) {
    const rx = new Receiver();
    const pass = startAs === "erasure" ? [null, ...body] : body;
    let res = feedSlots(rx, pass); // la primera pasada: sin END previo, no sirve para el largo
    assert.equal(res, null);
    res = feedSlots(rx, pass) ?? feedSlots(rx, pass);
    assert.equal(res?.text, text, startAs);
  }
});
