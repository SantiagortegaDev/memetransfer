import { decodeFrame, totalFrameLength } from "./protocol.js";

/**
 * Estado inicial del ensamblador: todavia no vio el arranque de una
 * transmision (el primer simbolo que sigue a una pausa gris larga).
 */
export function createAssemblyState() {
  return { receiving: false, buffer: [] };
}

/**
 * Avanza el ensamblador con un evento de simbolo confirmado (ver
 * js/matcher.js). Ignora eventos que llegan antes del arranque real de una
 * transmision (ruido de fondo sin la pausa larga previa). Cuando el buffer
 * alcanza el largo esperado segun el primer byte (LEN), decodifica y
 * devuelve el resultado, reseteando el estado para la proxima transmision.
 * @param {{receiving: boolean, buffer: number[]}} state
 * @param {{index: number, afterLongGap: boolean}} event
 * @returns {{state: object, done: null | {ok: true, text: string} | {ok: false, error: string}}}
 */
export function advanceAssembly(state, event) {
  if (!state.receiving) {
    if (!event.afterLongGap) {
      return { state, done: null };
    }
    return { state: { receiving: true, buffer: [event.index] }, done: null };
  }

  const buffer = [...state.buffer, event.index];
  const expectedTotal = totalFrameLength(buffer[0]);

  if (buffer.length < expectedTotal) {
    return { state: { receiving: true, buffer }, done: null };
  }

  const result = decodeFrame(buffer);
  return { state: createAssemblyState(), done: result };
}
