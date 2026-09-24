// Receptor (logica pura, sin DOM): junta los slots del segmentador en
// "pasadas" del loop del emisor, vota por posicion entre pasadas y
// decodifica el codeword con Reed-Solomon.
//
// Una pasada puede ser:
//   completa  START ... END            (alineada por ambos extremos)
//   cabeza    START ... (sin END)      (alineada desde el inicio)
//   cola      ... END   (sin START)    (alineada desde el final; pasa al engancharse a mitad)
//
// Decodificacion (se intenta tras cada slot):
//  1. Largos candidatos n: largos de pasadas completas + el que indica el
//     byte LEN leido en la posicion 0.
//  2. Votos por posicion: pasadas con el largo justo van directo; las que
//     tienen slots de mas o de menos se alinean contra el consenso con
//     programacion dinamica (tipo Needleman-Wunsch).
//  3. GMD: se prueba RS marcando como borrados los simbolos menos
//     confiables (0, 2, 4, ...), hasta agotar la paridad. El CRC-16 decide.
//  4. Ultimo recurso: una sola pasada con un slot de menos/de mas se prueba
//     insertando un borrado / quitando un simbolo en cada posicion.

import {
  START,
  END,
  MAX_PAYLOAD,
  codewordLength,
  payloadLengthForCodeword,
  decodeCodeword,
  decodeText,
} from "./protocol.js";

const MAX_PASSES = 12;
const MAX_PASS_LEN = 262;

function newPass(hasStart) {
  return { symbols: [], rel: [], hasStart, hasEnd: false, broken: false };
}

/**
 * Alinea una pasada contra el consenso (programacion dinamica global).
 * @returns {Map<number, number>} indice en la pasada -> posicion en el codeword
 */
export function alignToConsensus(pass, consensus) {
  const a = pass.symbols;
  const b = consensus;
  const n = a.length;
  const m = b.length;
  const GAP = -2;
  const score = (x, y) => (x === null || y === null ? 0 : x === y ? 2 : -1);
  const W = m + 1;
  const dp = new Float64Array((n + 1) * W);
  const bt = new Uint8Array((n + 1) * W); // 0 diag, 1 arriba (gap en b), 2 izquierda (gap en a)
  for (let i = 1; i <= n; i++) {
    dp[i * W] = i * GAP;
    bt[i * W] = 1;
  }
  for (let j = 1; j <= m; j++) {
    dp[j] = j * GAP;
    bt[j] = 2;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const d = dp[(i - 1) * W + j - 1] + score(a[i - 1], b[j - 1]);
      const u = dp[(i - 1) * W + j] + GAP;
      const l = dp[i * W + j - 1] + GAP;
      let best = d;
      let dir = 0;
      if (u > best) {
        best = u;
        dir = 1;
      }
      if (l > best) {
        best = l;
        dir = 2;
      }
      dp[i * W + j] = best;
      bt[i * W + j] = dir;
    }
  }
  const map = new Map();
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const dir = bt[i * W + j];
    if (i > 0 && j > 0 && dir === 0) {
      map.set(i - 1, j - 1);
      i--;
      j--;
    } else if (i > 0 && (j === 0 || dir === 1)) i--;
    else j--;
  }
  return map;
}

export class Receiver {
  constructor() {
    this.reset();
  }

  reset() {
    this.passes = [];
    this.current = null;
    this.result = null;
    this.attempts = 0;
  }

  /** Pasada en curso (para la UI). */
  get currentPass() {
    return this.current;
  }

  /** Largo de codeword mas probable, o 0 si todavia no se sabe. */
  get expectedLength() {
    return this.#candidateLengths()[0] ?? 0;
  }

  /**
   * Procesa un slot del segmentador.
   * @returns {object|null} resultado decodificado (solo la primera vez que se logra)
   */
  pushSlot(slot) {
    if (slot.break) {
      this.#finish();
      return null;
    }
    const cls = slot.cls;
    if (cls === START) {
      this.#finish();
      this.current = newPass(true);
    } else if (cls === END) {
      if (this.current) {
        this.current.hasEnd = true;
        this.#finish();
      }
      this.current = newPass(false);
    } else {
      if (!this.current) this.current = newPass(false);
      this.current.symbols.push(cls);
      this.current.rel.push(cls === null ? 0 : Math.max(0.05, slot.reliability ?? 0.5));
      if (this.current.symbols.length > MAX_PASS_LEN) this.current = newPass(false);
    }
    if (this.result) return null;
    const res = this.tryDecode();
    if (res) {
      this.result = res;
      return res;
    }
    return null;
  }

  #finish() {
    const p = this.current;
    this.current = null;
    if (!p || !p.symbols.length) return;
    if (!p.hasStart && !p.hasEnd) return; // sin ancla no sirve para alinear
    this.passes.push(p);
    if (this.passes.length > MAX_PASSES) this.passes.shift();
  }

  #anchoredPasses() {
    const list = [...this.passes];
    if (this.current?.hasStart && this.current.symbols.length) list.push(this.current);
    return list;
  }

  #candidateLengths() {
    const support = new Map();
    const add = (n, w) => {
      if (payloadLengthForCodeword(n) < 0) return;
      support.set(n, (support.get(n) ?? 0) + w);
    };
    for (const p of this.#anchoredPasses()) {
      if (p.hasStart && p.hasEnd) {
        const L = p.symbols.length;
        add(L, 2);
        for (const d of [-2, -1, 1, 2]) add(L + d, 0.5 / Math.abs(d));
      }
      if (p.hasStart && p.symbols.length && p.symbols[0] !== null && p.symbols[0] <= MAX_PAYLOAD) {
        add(codewordLength(p.symbols[0]), 1 + p.rel[0]);
      }
    }
    return [...support.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  }

  #votes(n) {
    const votes = Array.from({ length: n }, () => new Map());
    const cast = (pos, sym, w) => {
      if (sym === null || pos < 0 || pos >= n) return;
      votes[pos].set(sym, (votes[pos].get(sym) ?? 0) + w);
    };
    const passes = this.#anchoredPasses();
    const misaligned = [];
    for (const p of passes) {
      const L = p.symbols.length;
      if (p.hasStart && p.hasEnd) {
        if (L === n) p.symbols.forEach((s, i) => cast(i, s, p.rel[i]));
        else if (Math.abs(L - n) <= 4) misaligned.push(p);
      } else if (p.hasStart) {
        if (L <= n + 2) p.symbols.forEach((s, i) => cast(i, s, p.rel[i]));
      } else if (p.hasEnd) {
        if (L <= n + 2) p.symbols.forEach((s, i) => cast(n - L + i, s, p.rel[i]));
      }
    }
    if (misaligned.length) {
      const consensus = votes.map((v) => best(v).sym);
      if (consensus.some((s) => s !== null)) {
        for (const p of misaligned) {
          for (const [i, pos] of alignToConsensus(p, consensus)) cast(pos, p.symbols[i], 0.7 * p.rel[i]);
        }
      }
    }
    return votes;
  }

  /** Intenta decodificar con todo lo acumulado. */
  tryDecode() {
    for (const n of this.#candidateLengths().slice(0, 4)) {
      const res = this.#decodeFromVotes(n) ?? this.#decodeShifted(n);
      if (res) return res;
    }
    return null;
  }

  #decodeFromVotes(n) {
    const votes = this.#votes(n);
    const nsym = n - (payloadLengthForCodeword(n) + 3);
    const word = [];
    const scored = [];
    let empty = 0;
    votes.forEach((v, pos) => {
      const b = best(v);
      word.push(b.sym);
      if (b.sym === null) empty++;
      else scored.push({ pos, margin: b.margin });
    });
    if (empty > nsym) return null;
    scored.sort((a, b) => a.margin - b.margin);
    for (let extra = 0; empty + extra <= nsym; extra += 2) {
      const erase = scored.slice(0, extra).map((s) => s.pos);
      const res = this.#attempt(word, erase);
      if (res) return res;
      if (extra >= scored.length) break;
    }
    return null;
  }

  #decodeShifted(n) {
    for (const p of this.#anchoredPasses().reverse()) {
      if (!(p.hasStart && p.hasEnd)) continue;
      const L = p.symbols.length;
      if (L === n - 1) {
        for (let i = 0; i <= L; i++) {
          const res = this.#attempt([...p.symbols.slice(0, i), null, ...p.symbols.slice(i)], []);
          if (res) return res;
        }
      } else if (L === n + 1) {
        for (let i = 0; i < L; i++) {
          const res = this.#attempt([...p.symbols.slice(0, i), ...p.symbols.slice(i + 1)], []);
          if (res) return res;
        }
      }
    }
    return null;
  }

  #attempt(word, erase) {
    this.attempts++;
    try {
      const { payload, corrected } = decodeCodeword(word, erase);
      return {
        payload,
        text: decodeText(payload),
        corrected: corrected.length,
        passes: this.passes.length + (this.current?.hasStart ? 1 : 0),
        n: word.length,
      };
    } catch {
      return null;
    }
  }
}

function best(map) {
  let sym = null;
  let w1 = 0;
  let w2 = 0;
  for (const [s, w] of map) {
    if (w > w1) {
      w2 = w1;
      w1 = w;
      sym = s;
    } else if (w > w2) w2 = w;
  }
  return { sym, margin: w1 - w2 };
}
