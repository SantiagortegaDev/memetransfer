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

function category(gray) {
  return classifyFrame(gray).category;
}

test("a solid white frame classifies as START", () => {
  assert.equal(category(flat(255)), START);
});

test("a solid black frame classifies as END", () => {
  assert.equal(category(flat(0)), END);
});

test("a solid mid-gray frame classifies as GAP", () => {
  assert.equal(category(flat(128)), GAP);
});

test("a textured (high-variance) frame classifies as TEXTURED", () => {
  assert.equal(category(textured()), TEXTURED);
});

test("mild sensor noise on white still classifies as START", () => {
  const gray = flat(250);
  for (let i = 0; i < gray.length; i += 5) gray[i] -= 8; // ruido leve
  assert.equal(category(gray), START);
});

test("mild sensor noise on black still classifies as END", () => {
  const gray = flat(5);
  for (let i = 0; i < gray.length; i += 5) gray[i] += 8;
  assert.equal(category(gray), END);
});

test("a frame that is bright but not uniform is not START (it's textured)", () => {
  const gray = flat(230);
  for (let i = 0; i < gray.length; i += 2) gray[i] = 30; // mitad de los pixeles muy oscuros
  assert.equal(category(gray), TEXTURED);
});

test("classifyFrame also reports the mean and stdev used for the decision", () => {
  const result = classifyFrame(flat(180));
  assert.equal(result.mean, 180);
  assert.equal(result.stdev, 0);
  assert.equal(result.category, START);
});
