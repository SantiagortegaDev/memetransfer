// Reed-Solomon sobre GF(256) (polinomio primitivo 0x11d, generador alfa=2,
// primera raiz consecutiva fcr=0). Codigo sistematico: el codeword es
// [mensaje..., paridad...] y corrige cualquier combinacion que cumpla
// 2*errores + borrados <= nsym.
//
// Convencion de posiciones: codeword[0] es el coeficiente de mayor grado,
// y las posiciones de borrado son indices dentro del array del codeword.
// Implementacion basada en "Reed-Solomon codes for coders" (Wikiversity):
// sindromes -> sindromes de Forney (quitan los borrados conocidos) ->
// Berlekamp-Massey -> busqueda de Chien -> algoritmo de Forney.

const PRIM = 0x11d;
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIM;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

export class ReedSolomonError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReedSolomonError";
  }
}

function gfMul(x, y) {
  if (x === 0 || y === 0) return 0;
  return EXP[LOG[x] + LOG[y]];
}

function gfDiv(x, y) {
  if (y === 0) throw new ReedSolomonError("division por cero en GF(256)");
  if (x === 0) return 0;
  return EXP[(LOG[x] + 255 - LOG[y]) % 255];
}

function gfPow(x, power) {
  return EXP[(((LOG[x] * power) % 255) + 255) % 255];
}

function gfInverse(x) {
  return EXP[255 - LOG[x]];
}

function polyScale(p, x) {
  return p.map((c) => gfMul(c, x));
}

function polyAdd(p, q) {
  const r = new Array(Math.max(p.length, q.length)).fill(0);
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
  return r;
}

function polyMul(p, q) {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) {
    for (let i = 0; i < p.length; i++) r[i + j] ^= gfMul(p[i], q[j]);
  }
  return r;
}

function polyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = gfMul(y, x) ^ p[i];
  return y;
}

const generatorCache = new Map();
function generatorPoly(nsym) {
  let g = generatorCache.get(nsym);
  if (!g) {
    g = [1];
    for (let i = 0; i < nsym; i++) g = polyMul(g, [1, gfPow(2, i)]);
    generatorCache.set(nsym, g);
  }
  return g;
}

/**
 * Codifica un mensaje agregando nsym simbolos de paridad al final.
 * @param {ArrayLike<number>} msg bytes de datos
 * @param {number} nsym cantidad de simbolos de paridad
 * @returns {Uint8Array} codeword de largo msg.length + nsym (<= 255)
 */
export function rsEncode(msg, nsym) {
  if (msg.length + nsym > 255) throw new RangeError("codeword RS de mas de 255 simbolos");
  const gen = generatorPoly(nsym);
  const out = new Uint8Array(msg.length + nsym);
  out.set(msg);
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i];
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) out[i + j] ^= gfMul(gen[j], coef);
    }
  }
  out.set(msg);
  return out;
}

function calcSyndromes(msg, nsym) {
  // Se antepone un 0 para que los indices coincidan con la matematica.
  const synd = new Array(nsym + 1).fill(0);
  for (let i = 0; i < nsym; i++) synd[i + 1] = polyEval(msg, gfPow(2, i));
  return synd;
}

function errataLocator(coefPos) {
  let loc = [1];
  for (const p of coefPos) loc = polyMul(loc, polyAdd([1], [gfPow(2, p), 0]));
  return loc;
}

function errorEvaluator(synd, errLoc, nsym) {
  // Omega(x) = S(x) * Lambda(x) mod x^(nsym+1)
  const prod = polyMul(synd, errLoc);
  return prod.slice(prod.length - (nsym + 1));
}

function correctErrata(msg, synd, errPos) {
  const coefPos = errPos.map((p) => msg.length - 1 - p);
  const errLoc = errataLocator(coefPos);
  const errEval = errorEvaluator([...synd].reverse(), errLoc, errLoc.length - 1).reverse();

  const X = coefPos.map((cp) => gfPow(2, -(255 - cp)));
  const E = new Array(msg.length).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xiInv = gfInverse(X[i]);
    let errLocPrime = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) errLocPrime = gfMul(errLocPrime, 1 ^ gfMul(xiInv, X[j]));
    }
    if (errLocPrime === 0) throw new ReedSolomonError("no se pudo calcular la magnitud del error");
    const y = gfMul(X[i], polyEval([...errEval].reverse(), xiInv));
    E[errPos[i]] = gfDiv(y, errLocPrime);
  }
  return polyAdd(msg, E);
}

function findErrorLocator(synd, nsym, eraseCount) {
  let errLoc = [1];
  let oldLoc = [1];
  const shift = synd.length - nsym;
  for (let i = 0; i < nsym - eraseCount; i++) {
    const K = i + shift;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) delta ^= gfMul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    oldLoc = [...oldLoc, 0];
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, gfInverse(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  while (errLoc.length && errLoc[0] === 0) errLoc.shift();
  const errs = errLoc.length - 1;
  if ((errs - eraseCount) * 2 + eraseCount > nsym) throw new ReedSolomonError("demasiados errores");
  return errLoc;
}

function findErrors(errLocReversed, nmess) {
  const errs = errLocReversed.length - 1;
  const pos = [];
  for (let i = 0; i < nmess; i++) {
    if (polyEval(errLocReversed, gfPow(2, i)) === 0) pos.push(nmess - 1 - i);
  }
  if (pos.length !== errs) throw new ReedSolomonError("no se pudieron ubicar los errores");
  return pos;
}

function forneySyndromes(synd, erasePos, nmess) {
  const fsynd = synd.slice(1);
  for (const p of erasePos) {
    const x = gfPow(2, nmess - 1 - p);
    for (let j = 0; j < fsynd.length - 1; j++) fsynd[j] = gfMul(fsynd[j], x) ^ fsynd[j + 1];
  }
  return fsynd;
}

/**
 * Decodifica un codeword corrigiendo errores y borrados.
 * @param {ArrayLike<number|null>} codeword simbolos recibidos; null = borrado
 * @param {number} nsym cantidad de simbolos de paridad
 * @param {number[]} [erasePos] posiciones borradas adicionales (se suman a los null)
 * @returns {{data: Uint8Array, codeword: Uint8Array, corrected: number[]}}
 * @throws {ReedSolomonError} si hay mas errores que los corregibles
 */
export function rsDecode(codeword, nsym, erasePos = []) {
  const n = codeword.length;
  if (n > 255) throw new RangeError("codeword RS de mas de 255 simbolos");
  if (n <= nsym) throw new RangeError("codeword mas corto que la paridad");
  const erasures = new Set(erasePos);
  const msg = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = codeword[i];
    if (v === null || v === undefined) erasures.add(i);
    msg[i] = v ?? 0;
  }
  const erase = [...erasures].sort((a, b) => a - b);
  for (const p of erase) msg[p] = 0;
  if (erase.length > nsym) throw new ReedSolomonError("demasiados borrados");

  let synd = calcSyndromes(msg, nsym);
  if (synd.every((s) => s === 0)) {
    const out = Uint8Array.from(msg);
    return { data: out.slice(0, n - nsym), codeword: out, corrected: erase };
  }
  const fsynd = forneySyndromes(synd, erase, n);
  const errLoc = findErrorLocator(fsynd, nsym, erase.length);
  const errPos = findErrors([...errLoc].reverse(), n);
  const allPos = [...erase, ...errPos.filter((p) => !erasures.has(p))];
  const fixed = correctErrata(msg, synd, allPos);
  synd = calcSyndromes(fixed, nsym);
  if (synd.some((s) => s !== 0)) throw new ReedSolomonError("no se pudo corregir el mensaje");
  const out = Uint8Array.from(fixed);
  return { data: out.slice(0, n - nsym), codeword: out, corrected: allPos.sort((a, b) => a - b) };
}
