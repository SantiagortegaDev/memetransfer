// Convierte una secuencia cruda de observaciones por tick en una secuencia
// de eventos confirmados. Una observacion es cualquier valor identificable
// por igualdad: un indice de byte (0-255), o los sentinelas START/END de
// js/symbols.js. Reglas:
//  - Un candidato debe repetirse `stableTicksRequired` ticks seguidos para
//    confirmarse (evita que ruido/blur de un solo frame dispare una lectura).
//  - Tras confirmar un valor, no se vuelve a emitir ninguno hasta que se
//    observe al menos un tick de "gap" (null: pausa gris o frame ambiguo) -
//    evita contar dos veces el mismo meme/marcador que sigue en pantalla.
export class SymbolStream {
  constructor({ stableTicksRequired = 3 } = {}) {
    this.stableTicksRequired = stableTicksRequired;
    this.candidateValue = null;
    this.candidateTicks = 0;
    this.armed = true;
  }

  /**
   * @param {number|string|null} observedValue valor identificado este tick
   *   (indice de byte, START, END), o null si no hay nada confiable.
   * @returns {{value: number|string}|null}
   */
  tick(observedValue) {
    if (observedValue === null) {
      this.candidateValue = null;
      this.candidateTicks = 0;
      this.armed = true;
      return null;
    }

    if (observedValue === this.candidateValue) {
      this.candidateTicks++;
    } else {
      this.candidateValue = observedValue;
      this.candidateTicks = 1;
    }

    if (this.candidateTicks === this.stableTicksRequired && this.armed) {
      this.armed = false;
      return { value: observedValue };
    }
    return null;
  }

  reset() {
    this.candidateValue = null;
    this.candidateTicks = 0;
    this.armed = true;
  }
}
