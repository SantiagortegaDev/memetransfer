import { crc8 } from "./crc8.js";

// El framing (donde empieza y termina el mensaje) lo dan los marcadores de
// inicio/fin (ver js/classify.js), no un byte de longitud: asi un byte mal
// leido no descuadra el resto de la trama. MAX_PAYLOAD_BYTES sigue limitando
// cuanto se puede escribir, simplemente ya no viaja como byte en el aire.
export const MAX_PAYLOAD_BYTES = 255;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Arma la trama [payload...][CRC-8] a partir de un texto.
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
  const frame = new Uint8Array(payload.length + 1);
  frame.set(payload, 0);
  frame[frame.length - 1] = crc8(payload);
  return frame;
}

/**
 * Decodifica una trama completa [payload...][CRC-8] (todo lo acumulado
 * entre el marcador de inicio y el de fin).
 * @param {ArrayLike<number>} bytes
 * @returns {{ok: true, text: string} | {ok: false, error: string}}
 */
export function decodeFrame(bytes) {
  if (bytes.length < 1) {
    return { ok: false, error: "frame-too-short" };
  }
  const payloadBytes = Array.from(bytes).slice(0, bytes.length - 1);
  const expectedCrc = bytes[bytes.length - 1];
  const actualCrc = crc8(payloadBytes);
  if (actualCrc !== expectedCrc) {
    return { ok: false, error: "checksum-mismatch" };
  }
  return { ok: true, text: decoder.decode(Uint8Array.from(payloadBytes)) };
}
