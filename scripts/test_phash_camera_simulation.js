// Simula las condiciones reales de camara: toma un meme, lo renderiza como
// lo mostraria el emisor (cuadrado con object-fit: contain, mismo que
// js/dictionary.js), le aplica transformaciones que simulan lo que la
// camara de un telefono capturaria, y verifica que el pHash del resultado
// siga matcheando al pHash del meme original (distancia de Hamming <
// MATCH_THRESHOLD = 10). Usa multi-escala como el receptor real.

import { readFileSync } from "node:fs";
import { createCanvas, loadImage } from "canvas";
import { hashFromImageData, PHASH_INPUT_SIZE } from "../js/phash.js";

const manifest = JSON.parse(readFileSync("memes/manifest.json", "utf8"));

const SQUARE_REF_SIZE = 320;
const squareCanvas = createCanvas(SQUARE_REF_SIZE, SQUARE_REF_SIZE);
const squareCtx = squareCanvas.getContext("2d");
const hashCanvas = createCanvas(PHASH_INPUT_SIZE, PHASH_INPUT_SIZE);
const hashCtx = hashCanvas.getContext("2d");

const CAM_FRAME_SIZE = 640;
const camCanvas = createCanvas(CAM_FRAME_SIZE, CAM_FRAME_SIZE);
const camCtx = camCanvas.getContext("2d");

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

function applyTransform(image, opts) {
  const { brightness = 1, contrast = 1, scale = 1, rotation = 0, blur = 0 } = opts;
  const W = CAM_FRAME_SIZE;
  const H = CAM_FRAME_SIZE;

  camCtx.fillStyle = "#1a1a1a";
  camCtx.fillRect(0, 0, W, H);

  // Renderiza el meme al canvas cuadrado (object-fit: contain)
  squareCtx.fillStyle = "#000000";
  squareCtx.fillRect(0, 0, SQUARE_REF_SIZE, SQUARE_REF_SIZE);
  const iw = image.width;
  const ih = image.height;
  const scaleM = Math.min(SQUARE_REF_SIZE / iw, SQUARE_REF_SIZE / ih);
  const drawWm = iw * scaleM;
  const drawHm = ih * scaleM;
  const dxM = (SQUARE_REF_SIZE - drawWm) / 2;
  const dyM = (SQUARE_REF_SIZE - drawHm) / 2;
  squareCtx.drawImage(image, dxM, dyM, drawWm, drawHm);

  // Dibuja el cuadrado del emisor escalado al centro del canvas de camara
  const memeSizeInFrame = Math.min(W, H) * scale;
  const dx = (W - memeSizeInFrame) / 2;
  const dy = (H - memeSizeInFrame) / 2;

  camCtx.save();
  if (rotation !== 0) {
    camCtx.translate(W / 2, H / 2);
    camCtx.rotate((rotation * Math.PI) / 180);
    camCtx.translate(-W / 2, -H / 2);
  }
  camCtx.drawImage(squareCanvas, 0, 0, SQUARE_REF_SIZE, SQUARE_REF_SIZE, dx, dy, memeSizeInFrame, memeSizeInFrame);
  camCtx.restore();

  if (brightness !== 1 || contrast !== 1) {
    const imgData = camCtx.getImageData(0, 0, W, H);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        let v = data[i + c];
        v = (v - 128) * contrast + 128;
        v = v * brightness;
        data[i + c] = Math.max(0, Math.min(255, v));
      }
    }
    camCtx.putImageData(imgData, 0, 0);
  }

  if (blur > 0) {
    const factor = 1 + blur * 3;
    const small = createCanvas(Math.max(1, Math.round(W / factor)), Math.max(1, Math.round(H / factor)));
    const sctx = small.getContext("2d");
    sctx.drawImage(camCanvas, 0, 0, small.width, small.height);
    camCtx.fillStyle = "#000";
    camCtx.fillRect(0, 0, W, H);
    camCtx.drawImage(small, 0, 0, W, H);
  }

  // Como el receptor: multi-escala. Devuelve el MEJOR match.
  return camCanvas;
}

function multiScaleBestDistance(camCanvas, originalHash) {
  const W = camCanvas.width;
  const H = camCanvas.height;
  const minDim = Math.min(W, H);
  // Match exactamente la logica del receptor:
  // 5 rotaciones x 6 escalas x 3x3 offsets = 270 crops por frame
  const rotations = [-5, -2.5, 0, 2.5, 5];
  const scales = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5];
  const offsets = [-0.08, 0, 0.08];
  let bestDist = 256;

  const rotCanvas = createCanvas(W, H);
  const rotCtx = rotCanvas.getContext("2d");

  for (const rotDeg of rotations) {
    rotCtx.save();
    rotCtx.fillStyle = "#000000";
    rotCtx.fillRect(0, 0, W, H);
    rotCtx.translate(W / 2, H / 2);
    if (rotDeg !== 0) {
      rotCtx.rotate((rotDeg * Math.PI) / 180);
    }
    rotCtx.drawImage(camCanvas, -W / 2, -H / 2);
    rotCtx.restore();

    for (const scale of scales) {
      const side = Math.round(minDim * scale);
      if (side < 32) continue;
      const baseX = (W - side) / 2;
      const baseY = (H - side) / 2;
      for (const offsetX of offsets) {
        for (const offsetY of offsets) {
          const sx = baseX + side * offsetX;
          const sy = baseY + side * offsetY;
          hashCtx.drawImage(rotCanvas, sx, sy, side, side, 0, 0, PHASH_INPUT_SIZE, PHASH_INPUT_SIZE);
          const { data } = hashCtx.getImageData(0, 0, PHASH_INPUT_SIZE, PHASH_INPUT_SIZE);
          const hash = hashFromImageData(data);
          const dist = hammingDistance(hash, originalHash);
          if (dist < bestDist) bestDist = dist;
        }
      }
    }
  }
  return bestDist;
}

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

async function main() {
  const testIndices = [0, 30, 56, 50, 100, 148, 150, 200, 240, 255];
  const transforms = [
    { name: "identico (meme llena el frame)", opts: {} },
    { name: "meme al 90% del frame", opts: { scale: 0.9 } },
    { name: "meme al 80% del frame", opts: { scale: 0.8 } },
    { name: "meme al 70% del frame", opts: { scale: 0.7 } },
    { name: "+30% brightness (auto-exposure subexpone)", opts: { brightness: 1.3 } },
    { name: "-30% brightness (auto-exposure sobreexpone)", opts: { brightness: 0.7 } },
    { name: "+25% contrast", opts: { contrast: 1.25 } },
    { name: "-25% contrast", opts: { contrast: 0.75 } },
    { name: "rotation 3 grados", opts: { rotation: 3 } },
    { name: "rotation 5 grados", opts: { rotation: 5 } },
    { name: "rotation 8 grados (extremo)", opts: { rotation: 8 } },
    { name: "blur 1 (leve motion blur)", opts: { blur: 1 } },
    { name: "blur 2 (mas blur)", opts: { blur: 2 } },
    { name: "combinado: -20% bright + 80% size + rot 3deg + blur 1", opts: { brightness: 0.8, scale: 0.8, rotation: 3, blur: 1 } },
    { name: "combinado extremo: +30% bright + 70% size + rot 5deg + blur 2", opts: { brightness: 1.3, scale: 0.7, rotation: 5, blur: 2 } },
    { name: "combinado brutal: -40% bright + 60% size + rot 8deg + blur 2", opts: { brightness: 0.6, scale: 0.6, rotation: 8, blur: 2 } },
  ];

  console.log("Simulando transformaciones de camara (multi-escala + multi-offset + multi-rotacion)...\n");
  console.log("Threshold actual: 55 bits (de 256 bits)");
  console.log("Formato: [meme idx] [transform] -> mejor distancia Hamming (correcto < 55)\n");

  let totalTests = 0;
  let passedTests = 0;
  const failures = [];

  for (const idx of testIndices) {
    const img = await loadImage(`memes/${manifest[idx]}`);
    const originalHash = hashImageAsDisplayed(img);
    for (const t of transforms) {
      const camCanvas = applyTransform(img, t.opts);
      const bestDist = multiScaleBestDistance(camCanvas, originalHash);
      const pass = bestDist < 55;
      totalTests++;
      if (pass) passedTests++;
      else failures.push({ idx, transform: t.name, dist: bestDist });
      const symbol = pass ? "✓" : "✗";
      console.log(`${symbol} meme ${String(idx).padStart(3, " ")} ${t.name}: ${bestDist} bits`);
    }
  }

  console.log(`\n=== RESULTADO ===`);
  console.log(`Pasaron ${passedTests}/${totalTests} (${Math.round(passedTests / totalTests * 100)}%)`);
  if (failures.length > 0) {
    console.log(`\nFallas (distancia >= 55 bits):`);
    for (const f of failures) {
      console.log(`  meme ${f.idx} ${f.transform}: ${f.dist} bits`);
    }
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
