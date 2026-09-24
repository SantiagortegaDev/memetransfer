// Segmentador: convierte el flujo de observaciones por frame en "slots"
// (un slot = un meme mostrado entre dos gaps grises).
//
// Cada frame llega como {t, gap, cls, p}:
//   t    tiempo en ms (del video o de performance.now())
//   gap  true si el recorte es una pantalla gris uniforme (sin llamar al modelo)
//   cls  clase aceptada por el clasificador (0-255, START, END, NONE) o null si incierta
//   p    probabilidad de esa clase
//
// Un slot recibe la clase ganadora por votacion ponderada por probabilidad.
// Si ningun frame del slot fue confiable, el slot sale como borrado (cls=null):
// se sabe que ahi hubo un simbolo aunque no cual.
//
// Tres defensas contra slots perdidos/fusionados, que desalinearian la trama:
//  1. Si sin gap de por medio aparece una racha confiable de otra clase, se
//     parte el slot (gap no detectado entre dos memes distintos).
//  2. Con el periodo mediano (inicio a inicio) ya estimado, si un slot
//     arranca ~2 periodos despues del anterior falta un slot: si el anterior
//     duro el doble fue un gap perdido entre dos memes iguales ("ll") y se
//     duplica; si no, se inserta un borrado.
//  3. Un hueco de mas de BREAK_PERIODS periodos se reporta como corte
//     (slot con break=true) para que el receptor no alinee a ciegas.

import { NONE } from "./protocol.js";

const SPLIT_RUN = 3;
const MIN_FRAMES_ERASURE = 2;
const STATS_WINDOW = 21;
const MIN_STATS = 5;
const BREAK_PERIODS = 6;

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function summarize(frames) {
  const votes = new Map();
  let accepted = 0;
  for (const f of frames) {
    if (f.cls === null || f.cls === undefined || f.cls === NONE) continue;
    accepted++;
    votes.set(f.cls, (votes.get(f.cls) ?? 0) + f.p);
  }
  let cls = null;
  let best = 0;
  let total = 0;
  for (const [c, w] of votes) {
    total += w;
    if (w > best) {
      best = w;
      cls = c;
    }
  }
  const share = total > 0 ? best / total : 0;
  const winnerFrames = frames.filter((f) => f.cls === cls).length;
  const reliability = cls === null ? 0 : share * (1 - 0.5 ** winnerFrames);
  return { cls, share, reliability, accepted, votes: Object.fromEntries(votes) };
}

export class Segmenter {
  /**
   * @param {{onSlot: (slot: object) => void, timing?: boolean}} options
   *   timing=false desactiva las correcciones por tiempos (defensas 2 y 3).
   */
  constructor({ onSlot, timing = true } = {}) {
    this.onSlot = onSlot;
    this.timing = timing;
    this.reset();
  }

  reset() {
    this.frames = [];
    this.lastFrameT = null;
    this.frameDts = [];
    this.periods = [];
    this.durations = [];
    this.lastSlot = null;
    this.emitted = 0;
  }

  get frameDt() {
    return median(this.frameDts) || 33;
  }

  get period() {
    return this.periods.length >= MIN_STATS ? median(this.periods) : 0;
  }

  get duration() {
    return this.durations.length >= MIN_STATS ? median(this.durations) : 0;
  }

  push(frame) {
    if (this.lastFrameT !== null) {
      const dt = frame.t - this.lastFrameT;
      if (dt > 0 && dt < 500) {
        this.frameDts.push(dt);
        if (this.frameDts.length > 31) this.frameDts.shift();
      }
    }
    this.lastFrameT = frame.t;

    if (frame.gap) {
      if (this.frames.length) this.#close(this.frames);
      this.frames = [];
      return;
    }
    this.frames.push(frame);
    this.#maybeSplit();
  }

  /** Cierra el slot en curso (fin del video, se detuvo la camara...). */
  flush() {
    if (this.frames.length) this.#close(this.frames);
    this.frames = [];
  }

  #maybeSplit() {
    // Busca una racha final de SPLIT_RUN frames aceptados de la misma clase,
    // distinta de la ganadora de lo anterior (que tambien necesita su racha).
    const fr = this.frames;
    const acc = [];
    for (let i = fr.length - 1; i >= 0 && acc.length < SPLIT_RUN; i--) {
      if (fr[i].cls !== null && fr[i].cls !== undefined && fr[i].cls !== NONE) acc.push(i);
    }
    if (acc.length < SPLIT_RUN) return;
    const c = fr[acc[0]].cls;
    if (!acc.every((i) => fr[i].cls === c)) return;
    const cut = acc[acc.length - 1];
    const before = fr.slice(0, cut);
    const s = summarize(before);
    if (s.cls === null || s.cls === c) return;
    const winnerFrames = before.filter((f) => f.cls === s.cls).length;
    if (winnerFrames < SPLIT_RUN) return;
    this.#close(before);
    this.frames = fr.slice(cut);
  }

  #close(frames) {
    const s = summarize(frames);
    if (s.cls === null && frames.length < MIN_FRAMES_ERASURE) return; // ruido suelto dentro de un gap
    const dt = this.frameDt;
    const slot = {
      ...s,
      frames: frames.length,
      tStart: frames[0].t,
      tEnd: frames[frames.length - 1].t + dt,
      synthetic: false,
      break: false,
    };

    if (this.timing && this.lastSlot) {
      const P = this.period;
      const delta = slot.tStart - this.lastSlot.tStart;
      if (P > 0 && delta > BREAK_PERIODS * P) {
        this.#emit({ cls: null, share: 0, reliability: 0, accepted: 0, votes: {}, frames: 0, tStart: this.lastSlot.tEnd, tEnd: slot.tStart, synthetic: true, break: true });
      } else if (P > 0) {
        const missing = Math.round(delta / P) - 1;
        if (missing >= 1) {
          const D = this.duration;
          const prevDur = this.lastSlot.tEnd - this.lastSlot.tStart;
          const merged = D > 0 ? Math.max(0, Math.round((prevDur - D) / P)) : 0;
          for (let i = 0; i < missing; i++) {
            const dup = i < merged && this.lastSlot.cls !== null;
            this.#emit({
              cls: dup ? this.lastSlot.cls : null,
              share: dup ? this.lastSlot.share : 0,
              reliability: dup ? this.lastSlot.reliability * 0.6 : 0,
              accepted: 0,
              votes: {},
              frames: 0,
              tStart: this.lastSlot.tStart + (i + 1) * P,
              tEnd: this.lastSlot.tStart + (i + 1) * P,
              synthetic: true,
              break: false,
            });
          }
        }
      }
      if (delta > 0 && (this.periods.length < MIN_STATS || delta < 1.5 * this.period)) {
        this.periods.push(delta);
        if (this.periods.length > STATS_WINDOW) this.periods.shift();
      }
    }
    if (slot.cls !== null && slot.accepted >= 2) {
      const dur = slot.tEnd - slot.tStart;
      if (this.durations.length < MIN_STATS || dur < 1.5 * this.duration) {
        this.durations.push(dur);
        if (this.durations.length > STATS_WINDOW) this.durations.shift();
      }
    }
    this.lastSlot = slot;
    this.#emit(slot);
  }

  #emit(slot) {
    slot.index = this.emitted++;
    this.onSlot?.(slot);
  }
}
