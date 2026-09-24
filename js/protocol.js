// Trama de transmision:
//
//   START · [LEN · payload · CRC16(hi,lo) · paridad RS] · END
//
// Todo lo que va entre corchetes es UN codeword Reed-Solomon (<= 255
// simbolos, 1 simbolo = 1 meme = 1 byte). La paridad es ~25% del codeword
// (minimo 4 simbolos), asi que se corrigen 2*errores + borrados <= paridad.
// El CRC-16 va dentro de los datos protegidos y sirve para confirmar que lo
// que devolvio RS es el mensaje real y no otro codeword valido (cuando hay
// mas errores que la capacidad, RS a veces "corrige" hacia otro mensaje).
//
// No hace falta entrelazado: con un solo bloque RS, los errores en rafaga
// cuestan lo mismo que los dispersos (RS corrige simbolos, no bits).

import { rsEncode, rsDecode, ReedSolomonError } from "./rs.js";

export const NUM_BYTE_CLASSES = 256;
export const START = 256;
export const END = 257;
export const NONE = 258;
export const NUM_CLASSES = 259;

export const MIN_PARITY = 4;
/** Payload maximo en bytes: LEN + payload + CRC + paridad <= 255. */
export const MAX_PAYLOAD = 188;

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF). */
export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** Simbolos de paridad para k simbolos de datos (~25% del codeword). */
export function paritySymbols(k) {
  return Math.max(MIN_PARITY, Math.ceil(k / 3));
}

/** Largo del codeword (sin START/END) para un payload de `len` bytes. */
export function codewordLength(len) {
  const k = len + 3;
  return k + paritySymbols(k);
}

const LEN_BY_CODEWORD = new Map();
for (let len = 0; len <= MAX_PAYLOAD; len++) LEN_BY_CODEWORD.set(codewordLength(len), len);

/** Inverso de codewordLength: payload para un codeword de n simbolos, o -1 si ningun payload da ese largo. */
export function payloadLengthForCodeword(n) {
  return LEN_BY_CODEWORD.get(n) ?? -1;
}

/** Largos de codeword validos (ordenados). */
export const VALID_CODEWORD_LENGTHS = [...LEN_BY_CODEWORD.keys()].sort((a, b) => a - b);

/**
 * Arma el codeword RS para un payload.
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
export function encodePayload(payload) {
  if (payload.length > MAX_PAYLOAD) {
    throw new ProtocolError(`el mensaje ocupa ${payload.length} bytes (maximo ${MAX_PAYLOAD})`);
  }
  const crc = crc16(payload);
  const data = new Uint8Array(payload.length + 3);
  data[0] = payload.length;
  data.set(payload, 1);
  data[payload.length + 1] = crc >> 8;
  data[payload.length + 2] = crc & 0xff;
  return rsEncode(data, paritySymbols(data.length));
}

/** Secuencia completa de simbolos a mostrar: START, codeword, END. */
export function buildTransmission(payload) {
  return [START, ...encodePayload(payload), END];
}

export function encodeText(text) {
  return new TextEncoder().encode(text);
}

export function decodeText(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Intenta recuperar el payload de un codeword recibido.
 * @param {(number|null)[]} symbols simbolos leidos (null = borrado)
 * @param {number[]} [extraErasures] posiciones a tratar como borradas
 * @returns {{payload: Uint8Array, corrected: number[]}}
 * @throws {ProtocolError|ReedSolomonError}
 */
export function decodeCodeword(symbols, extraErasures = []) {
  const n = symbols.length;
  const len = payloadLengthForCodeword(n);
  if (len < 0) throw new ProtocolError(`largo de codeword invalido: ${n}`);
  const k = len + 3;
  const { data, corrected } = rsDecode(symbols, n - k, extraErasures);
  if (data[0] !== len) throw new ProtocolError("LEN no coincide con el largo de la trama");
  const payload = data.slice(1, 1 + len);
  const crc = (data[1 + len] << 8) | data[2 + len];
  if (crc !== crc16(payload)) throw new ProtocolError("CRC-16 no coincide");
  return { payload, corrected };
}

export { ReedSolomonError };
