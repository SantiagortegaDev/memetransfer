import { test } from "node:test";
import assert from "node:assert/strict";
import { bestMatch, AMBIGUITY_MARGIN } from "../js/receiver.js";

test("picks the clear pHash winner when no other candidate is close", () => {
  const dictionary = [
    { index: 0, hash: 0b0000n, dhash: 0b1111n },
    { index: 1, hash: 0b1111n, dhash: 0b0000n },
  ];
  // candidato identico al hash de la entrada 0, muy lejos de la 1
  const { entry, distance } = bestMatch(0b0000n, 0b1111n, dictionary);
  assert.equal(entry.index, 0);
  assert.equal(distance, 0);
});

test("uses dhash to break a tie between two close pHash candidates", () => {
  const dictionary = [
    // ambos a 1 bit de distancia del candidato en pHash (ambiguo)
    { index: 0, hash: 0b0001n, dhash: 0b1111n }, // dhash lejos del candidato
    { index: 1, hash: 0b0010n, dhash: 0b0000n }, // dhash igual al candidato
  ];
  const candidateHash = 0b0000n; // a 1 bit de ambos
  const candidateDHash = 0b0000n;
  const { entry } = bestMatch(candidateHash, candidateDHash, dictionary);
  assert.equal(entry.index, 1, "deberia elegir la entrada cuyo dhash coincide, no la primera en orden de pHash");
});

test("does not tie-break when the second-best candidate is far away", () => {
  const dictionary = [
    { index: 0, hash: 0b000000000n, dhash: 0b111111111n },
    { index: 1, hash: 0b111111111n, dhash: 0b000000000n }, // mucho mas lejos en pHash
  ];
  const candidateHash = 0b000000001n; // 1 bit de la entrada 0, 8 bits de la 1 (> AMBIGUITY_MARGIN)
  const candidateDHash = 0b000000000n; // coincide exacto con la entrada 1 en dhash
  const { entry } = bestMatch(candidateHash, candidateDHash, dictionary);
  assert.equal(entry.index, 0, "no deberia desempatar si el 2do candidato ni siquiera esta cerca");
});

test("AMBIGUITY_MARGIN is a small, sane positive number", () => {
  assert.ok(AMBIGUITY_MARGIN > 0 && AMBIGUITY_MARGIN < 20);
});
