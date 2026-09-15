// Convierte una secuencia cruda de observaciones por tick (que meme matchea
// mejor en este frame de camara, o null si no hay match confiable) en una
// secuencia de eventos de simbolo confirmados. Reglas:
//  - Un candidato debe repetirse `stableTicksRequired` ticks seguidos para
//    confirmarse (evita que ruido/blur dispare una lectura de un solo frame).
//  - Tras confirmar un simbolo, no se vuelve a emitir el mismo (ni ningun
//    otro) hasta que se observe al menos un tick de "gap" (pausa gris o sin
//    match) - evita contar dos veces un mismo meme que sigue en pantalla.
//  - Se marca `afterLongGap` cuando el gap previo duro al menos
//    `longGapTicksRequired` ticks: es la senal de "esto es el arranque de
//    una transmision nueva", ver diseno en docs/superpowers/specs.
export class SymbolStream {
  constructor({ stableTicksRequired = 3, longGapTicksRequired = 5 } = {}) {
    this.stableTicksRequired = stableTicksRequired;
    this.longGapTicksRequired = longGapTicksRequired;
    this.gapTicks = 0;
    this.candidateIndex = null;
    this.candidateTicks = 0;
    this.armed = true;
  }

  /**
   * @param {number|null} observedIndex indice del mejor match este tick, o
   *   null si no hay match confiable (pausa gris / fondo / nada reconocido).
   * @returns {{index: number, afterLongGap: boolean}|null}
   */
  tick(observedIndex) {
    if (observedIndex === null) {
      this.gapTicks++;
      this.candidateIndex = null;
      this.candidateTicks = 0;
      this.armed = true;
      return null;
    }

    if (observedIndex === this.candidateIndex) {
      this.candidateTicks++;
    } else {
      this.candidateIndex = observedIndex;
      this.candidateTicks = 1;
    }

    if (this.candidateTicks === this.stableTicksRequired && this.armed) {
      const afterLongGap = this.gapTicks >= this.longGapTicksRequired;
      this.gapTicks = 0;
      this.armed = false;
      return { index: observedIndex, afterLongGap };
    }
    return null;
  }

  reset() {
    this.gapTicks = 0;
    this.candidateIndex = null;
    this.candidateTicks = 0;
    this.armed = true;
  }
}
