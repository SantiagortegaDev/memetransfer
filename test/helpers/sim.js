// Simulador de lo que "ve" el receptor: dada la secuencia de simbolos que
// muestra el emisor (en loop), genera observaciones por frame con jitter de
// tiempos, frames inciertos, errores de clasificacion y gaps no detectados.

import { NONE } from "../../js/protocol.js";

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {number[]} symbols secuencia de una pasada (START, ..., END)
 * @param {object} o
 * @returns {{t:number,gap:boolean,cls:number|null,p:number}[]}
 */
export function simulateFrames(symbols, o = {}) {
  const {
    seed = 1,
    passes = 1,
    symbolMs = 500,
    gapMs = 150,
    fps = 20,
    fpsJitter = 0.3,
    startOffsetMs = 0, // el receptor se engancha tarde
    pUncertain = 0.1, // frame con probabilidad baja -> null
    pWrong = 0.02, // frame aceptado con clase equivocada
    pNone = 0.03, // frame NONE (mano, desenfoque)
    pMissGap = 0, // probabilidad de no ver ningun frame gris en un gap
    pDropSymbol = 0, // probabilidad de no ver ningun frame de un simbolo (ej. mano delante)
    wrongSlots = [], // [{pass, index, cls}] fuerza que todo un slot se lea mal
    pTransitionNone = 0.5, // primer/ultimo frame de un simbolo como NONE (mezcla)
  } = o;
  const rand = rng(seed);
  const period = symbolMs + gapMs;
  const schedule = [];
  for (let p = 0; p < passes; p++) {
    symbols.forEach((s, i) => {
      schedule.push({ s, pass: p, index: i, drop: rand() < pDropSymbol, missGap: rand() < pMissGap });
    });
  }
  const forced = new Map(wrongSlots.map((w) => [`${w.pass}:${w.index}`, w.cls]));
  const total = schedule.length * period;
  const frames = [];
  let t = startOffsetMs;
  while (t < total) {
    const k = Math.floor(t / period);
    const inSym = t - k * period;
    const entry = schedule[k];
    const isGap = inSym >= symbolMs;
    if (isGap) {
      if (!entry.missGap) frames.push({ t, gap: true, cls: null, p: 0 });
      else frames.push({ t, gap: false, cls: rand() < 0.5 ? NONE : null, p: 0.7 });
    } else if (entry.drop) {
      frames.push({ t, gap: false, cls: rand() < 0.5 ? NONE : null, p: 0.5 });
    } else {
      const edge = inSym < 1000 / fps || symbolMs - inSym < 1000 / fps;
      const f = forced.get(`${entry.pass}:${entry.index}`);
      let cls = f ?? entry.s;
      let p = 0.7 + 0.3 * rand();
      const r = rand();
      if (edge && rand() < pTransitionNone) cls = NONE;
      else if (r < pUncertain) cls = null;
      else if (r < pUncertain + pWrong) cls = Math.floor(rand() * 256);
      else if (r < pUncertain + pWrong + pNone) cls = NONE;
      frames.push({ t, gap: false, cls, p });
    }
    t += (1000 / fps) * (1 + fpsJitter * (rand() - 0.5) * 2);
  }
  return frames;
}
