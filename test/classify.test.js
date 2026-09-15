import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFrame, START, END, GAP, TEXTURED } from "../js/classify.js";

function flat(value, n = 100) {
  return new Float64Array(n).fill(value);
}

function textured(n = 100) {
  const arr = new Float64Array(n);
  for (let i = 0; i < n; i++) arr[i] = (i * 53) % 256; // patron con bastante variacion
  return arr;
}

test("a solid white frame classifies as START", () => {
  assert.equal(classifyFrame(flat(255)), START);
});

test("a solid black frame classifies as END", () => {
  assert.equal(classifyFrame(flat(0)), END);
});

test("a solid mid-gray frame classifies as GAP", () => {
  assert.equal(classifyFrame(flat(128)), GAP);
});

test("a textured (high-variance) frame classifies as TEXTURED", () => {
  assert.equal(classifyFrame(textured()), TEXTURED);
});

test("mild sensor noise on white still classifies as START", () => {
  const gray = flat(250);
  for (let i = 0; i < gray.length; i += 5) gray[i] -= 8; // ruido leve
  assert.equal(classifyFrame(gray), START);
});

test("mild sensor noise on black still classifies as END", () => {
  const gray = flat(5);
  for (let i = 0; i < gray.length; i += 5) gray[i] += 8;
  assert.equal(classifyFrame(gray), END);
});

test("a frame that is bright but not uniform is not START (it's textured)", () => {
  const gray = flat(230);
  for (let i = 0; i < gray.length; i += 2) gray[i] = 30; // mitad de los pixeles muy oscuros
  assert.equal(classifyFrame(gray), TEXTURED);
});
