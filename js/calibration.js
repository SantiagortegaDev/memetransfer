// Calibracion: el emisor muestra las 258 clases en orden (0..255, START,
// END) en loop y el receptor mide la precision por meme. Como el orden es
// conocido, la clase esperada de cada slot sale de un "ancla": el valor
// mas votado de (clase leida - indice del slot) mod 258 en los ultimos
// slots, asi que tolera slots perdidos o de mas.
//
// Metricas (las mismas que training/eval_video.py):
//   precision entre aceptados = frames aceptados correctos / frames aceptados como meme
//   aceptacion falsa = frames aceptados con otra clase / frames totales de memes

import { NONE } from "./protocol.js";

export const CAL_CLASSES = 258;
export const CALIBRATION_SEQUENCE = Array.from({ length: CAL_CLASSES }, (_, i) => i);
const ANCHOR_WINDOW = 24;

export class Calibration {
  constructor() {
    this.reset();
  }

  reset() {
    this.slotIndex = 0;
    this.recent = [];
    this.perClass = Array.from({ length: CAL_CLASSES }, () => ({
      slots: 0,
      slotsCorrect: 0,
      frames: 0,
      accepted: 0,
      correct: 0,
      confusions: {},
    }));
    this.totals = { slots: 0, slotsCorrect: 0, frames: 0, accepted: 0, correct: 0, wrong: 0 };
  }

  get anchor() {
    const count = new Map();
    for (const d of this.recent) count.set(d, (count.get(d) ?? 0) + 1);
    let best = null;
    let n = 0;
    for (const [d, c] of count) if (c > n) [best, n] = [d, c];
    return n >= 2 ? best : null;
  }

  /**
   * @param {object} slot slot del segmentador con `obs` (frames del slot)
   * @returns {{expected: number|null, got: number|null}}
   */
  pushSlot(slot) {
    const i = this.slotIndex++;
    if (slot.cls !== null && !slot.synthetic) {
      this.recent.push((((slot.cls - i) % CAL_CLASSES) + CAL_CLASSES) % CAL_CLASSES);
      if (this.recent.length > ANCHOR_WINDOW) this.recent.shift();
    }
    const a = this.anchor;
    if (a === null || slot.synthetic || slot.break) return { expected: null, got: slot.cls };
    const expected = (a + i) % CAL_CLASSES;
    const pc = this.perClass[expected];
    pc.slots++;
    this.totals.slots++;
    if (slot.cls === expected) {
      pc.slotsCorrect++;
      this.totals.slotsCorrect++;
    }
    for (const f of slot.obs ?? []) {
      pc.frames++;
      this.totals.frames++;
      if (f.cls === null || f.cls === undefined || f.cls === NONE) continue;
      pc.accepted++;
      this.totals.accepted++;
      if (f.cls === expected) {
        pc.correct++;
        this.totals.correct++;
      } else {
        this.totals.wrong++;
        pc.confusions[f.cls] = (pc.confusions[f.cls] ?? 0) + 1;
      }
    }
    return { expected, got: slot.cls };
  }

  summary() {
    const t = this.totals;
    return {
      slots: t.slots,
      slotAccuracy: t.slots ? t.slotsCorrect / t.slots : null,
      frames: t.frames,
      precisionAccepted: t.accepted ? t.correct / t.accepted : null,
      falseAcceptRate: t.frames ? t.wrong / t.frames : null,
      acceptRate: t.frames ? t.accepted / t.frames : null,
      classesSeen: this.perClass.filter((c) => c.slots > 0).length,
    };
  }

  /** Memes problematicos: slots mal leidos o frames confundidos, peor primero. */
  problems(limit = 20) {
    return this.perClass
      .map((c, cls) => ({
        cls,
        slots: c.slots,
        slotAccuracy: c.slots ? c.slotsCorrect / c.slots : 1,
        precision: c.accepted ? c.correct / c.accepted : 1,
        acceptRate: c.frames ? c.accepted / c.frames : 0,
        confusions: Object.entries(c.confusions).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => ({ cls: Number(k), n })),
      }))
      .filter((c) => c.slots > 0 && (c.slotAccuracy < 1 || c.precision < 0.98))
      .sort((a, b) => a.slotAccuracy - b.slotAccuracy || a.precision - b.precision)
      .slice(0, limit);
  }
}
