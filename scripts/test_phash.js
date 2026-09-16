// Script de prueba rapida: carga cada meme original (memes/*.jpg segun
// manifest) y las dos imagenes de control, calcula su pHash USANDO EL
// MISMO RENDERIZADO QUE EL DICCIONARIO (cuadrado con object-fit: contain,
// como lo muestra el emisor), y reporta:
//   1. Que tan distintos son los hashes entre todos los memes (deberian
//      ser todos distintos -si no, el pHash no es discriminatorio).
//   2. Que el pHash de start.jpg y end.jpg sea estable y diferente de
//      todos los memes.
//   3. Que la distancia minima entre cualquier par de memes sea >= 4 (un
//      umbral razonable para distinguir dos memes distintos).

import { readFileSync } from "node:fs";
import { createCanvas, loadImage } from "canvas";
import { hashFromImageData, PHASH_INPUT_SIZE } from "../js/phash.js";

const manifest = JSON.parse(readFileSync("memes/manifest.json", "utf8"));
console.log(`Manifest tiene ${manifest.length} memes`);

// Replica exacta de la logica de js/dictionary.js para que los hashes
// coincidan con los que usa el receptor en el navegador.
const SQUARE_REF_SIZE = 320;
const squareCanvas = createCanvas(SQUARE_REF_SIZE, SQUARE_REF_SIZE);
const squareCtx = squareCanvas.getContext("2d");
const hashCanvas = createCanvas(PHASH_INPUT_SIZE, PHASH_INPUT_SIZE);
const hashCtx = hashCanvas.getContext("2d");

function hashImageAsDisplayed(image) {
  squareCtx.fillStyle = "#000000";
  squareCtx.fillRect(0, 0, SQUARE_REF_SIZE, SQUARE_REF_SIZE);
  const w = image.width;
  const h = image.height;
  if (w > 0 && h > 0) {
    const scale = Math.min(SQUARE_REF_SIZE / w, SQUARE_REF_SIZE / h);
    const drawW = w * scale;
    const drawH = h * scale;
    const dx = (SQUARE_REF_SIZE - drawW) / 2;
    const dy = (SQUARE_REF_SIZE - drawH) / 2;
    squareCtx.drawImage(image, dx, dy, drawW, drawH);
  }
  hashCtx.drawImage(squareCanvas, 0, 0, SQUARE_REF_SIZE, SQUARE_REF_SIZE, 0, 0, PHASH_INPUT_SIZE, PHASH_INPUT_SIZE);
  const { data } = hashCtx.getImageData(0, 0, PHASH_INPUT_SIZE, PHASH_INPUT_SIZE);
  return hashFromImageData(data);
}

async function hashImageFile(path) {
  const img = await loadImage(path);
  return hashImageAsDisplayed(img);
}

console.log("Calculando pHash de los 256 memes + 2 imagenes de control...");
const memeHashes = [];
for (let i = 0; i < manifest.length; i++) {
  const hash = await hashImageFile(`memes/${manifest[i]}`);
  memeHashes.push(hash);
}
const startHash = await hashImageFile("memes/start.jpg");
const endHash = await hashImageFile("memes/end.jpg");

function hammingDistance(a, b) {
  let count = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    let x = a[i] ^ b[i];
    while (x) {
      count += x & 1;
      x >>>= 1;
    }
  }
  return count;
}

// 1. Todos los memes deben tener hashes distintos
let duplicates = 0;
for (let i = 0; i < memeHashes.length; i++) {
  for (let j = i + 1; j < memeHashes.length; j++) {
    if (hammingDistance(memeHashes[i], memeHashes[j]) === 0) {
      duplicates++;
      console.log(`  DUPLICADO: meme ${i} y meme ${j} tienen el mismo hash`);
    }
  }
}
console.log(`1. Duplicados encontrados: ${duplicates} (esperado: 0)`);

// 2. Distancia minima entre cualquier par de memes (deberia ser > 0)
let minDist = 256;
let minPair = [null, null];
for (let i = 0; i < memeHashes.length; i++) {
  for (let j = i + 1; j < memeHashes.length; j++) {
    const d = hammingDistance(memeHashes[i], memeHashes[j]);
    if (d < minDist) {
      minDist = d;
      minPair = [i, j];
    }
  }
}
console.log(`2. Distancia minima entre memes: ${minDist} bits (par: ${minPair[0]}, ${minPair[1]})`);
console.log(`   -> si esto es muy bajo (<4), pHash no distingue bien esos memes`);

// 3. Distancia de start.jpg y end.jpg a todos los memes
let minStartDist = 256;
let minStartIdx = -1;
for (let i = 0; i < memeHashes.length; i++) {
  const d = hammingDistance(startHash, memeHashes[i]);
  if (d < minStartDist) {
    minStartDist = d;
    minStartIdx = i;
  }
}
console.log(`3a. start.jpg: distancia minima a un meme = ${minStartDist} bits (meme ${minStartIdx})`);

let minEndDist = 256;
let minEndIdx = -1;
for (let i = 0; i < memeHashes.length; i++) {
  const d = hammingDistance(endHash, memeHashes[i]);
  if (d < minEndDist) {
    minEndDist = d;
    minEndIdx = i;
  }
}
console.log(`3b. end.jpg:   distancia minima a un meme = ${minEndDist} bits (meme ${minEndIdx})`);

console.log(`4. Distancia start <-> end: ${hammingDistance(startHash, endHash)} bits (deberia ser grande)`);

// 5. Histograma de distancias minimas por meme (para detectar outliers)
const distances = [];
for (let i = 0; i < memeHashes.length; i++) {
  let minD = 64;
  for (let j = 0; j < memeHashes.length; j++) {
    if (i === j) continue;
    const d = hammingDistance(memeHashes[i], memeHashes[j]);
    if (d < minD) minD = d;
  }
  distances.push(minD);
}
const hist = new Map();
for (const d of distances) {
  hist.set(d, (hist.get(d) || 0) + 1);
}
const sortedKeys = Array.from(hist.keys()).sort((a, b) => a - b);
console.log("5. Histograma de distancia-minima-al-meme-mas-cercano:");
for (const k of sortedKeys) {
  console.log(`   ${k} bits: ${hist.get(k)} memes`);
}
const lowDistanceMemes = distances.filter((d) => d < 8).length;
console.log(`   Memes con vecino a <8 bits: ${lowDistanceMemes} (preocupante si es alto)`);
