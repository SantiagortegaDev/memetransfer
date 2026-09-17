package com.memetransfer.receiver.protocol

/**
 * Puerto directo de js/matcher.js's SymbolStream. Convierte una secuencia
 * cruda de observaciones por tick en una secuencia de eventos confirmados.
 * Una observacion es cualquier valor identificable por igualdad: un indice
 * de byte (Int, 0-255), o los sentinelas START/END, o null (nada
 * confiable). Reglas:
 *  - Un candidato debe repetirse `stableTicksRequired` ticks seguidos para
 *    confirmarse (evita que ruido/blur de un solo frame dispare una lectura).
 *  - Tras confirmar un valor, no se vuelve a emitir ninguno hasta que se
 *    observe al menos un tick de "gap" (null) - evita contar dos veces el
 *    mismo meme que sigue en pantalla.
 */
class SymbolStream(private val stableTicksRequired: Int = 3) {
    private var candidateValue: Any? = null
    private var candidateTicks: Int = 0
    private var armed: Boolean = true

    /** @return el valor confirmado este tick, o null si no hay nada nuevo que emitir. */
    fun tick(observedValue: Any?): Any? {
        if (observedValue == null) {
            candidateValue = null
            candidateTicks = 0
            armed = true
            return null
        }

        if (observedValue == candidateValue) {
            candidateTicks++
        } else {
            candidateValue = observedValue
            candidateTicks = 1
        }

        if (candidateTicks == stableTicksRequired && armed) {
            armed = false
            return observedValue
        }
        return null
    }

    fun reset() {
        candidateValue = null
        candidateTicks = 0
        armed = true
    }
}
