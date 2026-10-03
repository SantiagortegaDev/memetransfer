import { test } from "node:test";
import assert from "node:assert/strict";
import { History, MAX_ITEMS, shareText, whatsappUrl } from "../js/history.js";

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test("add keeps newest first and persists", () => {
  const s = memoryStorage();
  const h = new History(s);
  h.add("uno", 1);
  h.add("dos", 2);
  assert.deepEqual(new History(s).list().map((i) => i.text), ["dos", "uno"]);
});

test("receiving the same text again (sender in loop) does not duplicate it", () => {
  const h = new History(memoryStorage());
  h.add("hola", 1);
  h.add("hola", 5);
  const items = h.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].at, 5);
});

test("keeps at most MAX_ITEMS", () => {
  const h = new History(memoryStorage());
  for (let i = 0; i < MAX_ITEMS + 10; i++) h.add(`m${i}`, i);
  const items = h.list();
  assert.equal(items.length, MAX_ITEMS);
  assert.equal(items[0].text, `m${MAX_ITEMS + 9}`);
});

test("remove and clear", () => {
  const h = new History(memoryStorage());
  const a = h.add("a", 1);
  h.add("b", 2);
  h.remove(a.id);
  assert.deepEqual(h.list().map((i) => i.text), ["b"]);
  h.clear();
  assert.deepEqual(h.list(), []);
});

test("works (empty) without storage or with broken data", () => {
  assert.deepEqual(new History(null).list(), []);
  const s = memoryStorage();
  s.setItem("memetransfer.history.v1", "{no es json");
  assert.deepEqual(new History(s).list(), []);
  const throwing = { getItem: () => { throw new Error("bloqueado"); }, setItem: () => { throw new Error("lleno"); }, removeItem() {} };
  const h = new History(throwing);
  assert.doesNotThrow(() => h.add("x"));
  assert.deepEqual(h.list(), []);
});

test("whatsappUrl encodes the text", () => {
  assert.equal(whatsappUrl("hola mundo & ñ"), "https://wa.me/?text=hola%20mundo%20%26%20%C3%B1");
});

test("shareText uses the native share sheet when available", async () => {
  let shared = null;
  const opened = [];
  const r = await shareText("hola", { share: async (d) => (shared = d) }, (u) => opened.push(u));
  assert.equal(r, "shared");
  assert.deepEqual(shared, { text: "hola" });
  assert.equal(opened.length, 0);
});

test("shareText: user cancelling is not an error and does not open WhatsApp", async () => {
  const opened = [];
  const abort = Object.assign(new Error("cancel"), { name: "AbortError" });
  const r = await shareText("hola", { share: async () => { throw abort; } }, (u) => opened.push(u));
  assert.equal(r, "cancelled");
  assert.equal(opened.length, 0);
});

test("shareText falls back to WhatsApp without Web Share", async () => {
  const opened = [];
  assert.equal(await shareText("hola", {}, (u) => opened.push(u)), "whatsapp");
  assert.deepEqual(opened, ["https://wa.me/?text=hola"]);
});
