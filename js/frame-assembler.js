import { decodeFrame } from "./protocol.js";
import { START, END } from "./symbols.js";

/**
 * Estado inicial del ensamblador: todavia no vio el marcador de inicio.
 */
export function createAssemblyState() {
  return { receiving: false, buffer: [] };
}

/**
 * Avanza el ensamblador con un evento de simbolo confirmado (ver
 * js/matcher.js). El marcador START (re)arranca la acumulacion desde cero
 * -incluso si ya estaba recibiendo, asi una transmision repetida siempre
 * puede "ganar" sobre una anterior que quedo a mitad de camino-. Los bytes
 * de datos se ignoran si todavia no se vio el START. El marcador END cierra
 * la trama y la decodifica.
 * @param {{receiving: boolean, buffer: number[]}} state
 * @param {{value: number|string}} event
 * @returns {{state: object, done: null | {ok: true, text: string} | {ok: false, error: string}}}
 */
export function advanceAssembly(state, event) {
  const { value } = event;

  if (value === START) {
    return { state: { receiving: true, buffer: [] }, done: null };
  }

  if (!state.receiving) {
    return { state, done: null };
  }

  if (value === END) {
    const result = decodeFrame(state.buffer);
    return { state: createAssemblyState(), done: result };
  }

  return { state: { receiving: true, buffer: [...state.buffer, value] }, done: null };
}
