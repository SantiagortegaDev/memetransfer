import { crc8 } from "./crc8.js";

// LEN es 1 byte -> el payload no puede superar 255 bytes UTF-8.
export const MAX_PAYLOAD_BYTES = 255;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Arma la trama [LEN][payload...][CRC-8] a partir de un texto.
 * Lanza RangeError si el texto codificado en UTF-8 supera MAX_PAYLOAD_BYTES.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function encodeMessage(text) {
  const payload = encoder.encode(text);
  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw new RangeError(
      `Mensaje demasiado largo: ${payload.length} bytes (maximo ${MAX_PAYLOAD_BYTES})`
    );
  }
  const frame = new Uint8Array(1 + payload.length + 1);
  frame[0] = payload.length;
  frame.set(payload, 1);
  frame[frame.length - 1] = crc8(frame.subarray(0, frame.length - 1));
  return frame;
}

/**
 * Dado el primer byte recibido (LEN), devuelve cuantos bytes totales
 * tiene la trama completa (LEN + payload + CRC).
 * @param {number} lenByte
 */
export function totalFrameLength(lenByte) {
  return lenByte + 2;
}

/**
 * Decodifica una trama completa [LEN][payload...][CRC-8].
 * @param {ArrayLike<number>} bytes
 * @returns {{ok: true, text: string} | {ok: false, error: string}}
 */
export function decodeFrame(bytes) {
  if (bytes.length < 2) {
    return { ok: false, error: "frame-too-short" };
  }
  const len = bytes[0];
  if (bytes.length !== totalFrameLength(len)) {
    return { ok: false, error: "length-mismatch" };
  }
  const withoutCrc = Array.from(bytes).slice(0, bytes.length - 1);
  const expectedCrc = bytes[bytes.length - 1];
  const actualCrc = crc8(withoutCrc);
  if (actualCrc !== expectedCrc) {
    return { ok: false, error: "checksum-mismatch" };
  }
  const payloadBytes = Uint8Array.from(withoutCrc.slice(1));
  return { ok: true, text: decoder.decode(payloadBytes) };
}
