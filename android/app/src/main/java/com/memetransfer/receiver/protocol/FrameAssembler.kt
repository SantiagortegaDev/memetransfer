package com.memetransfer.receiver.protocol

/** Puerto directo de js/frame-assembler.js. */
data class AssemblyState(val receiving: Boolean = false, val buffer: List<Int> = emptyList())

fun createAssemblyState(): AssemblyState = AssemblyState()

/**
 * Avanza el ensamblador con un simbolo confirmado (ver SymbolStream). El
 * simbolo START (re)arranca la acumulacion desde cero -incluso si ya
 * estaba recibiendo, asi una transmision repetida siempre puede "ganar"
 * sobre una anterior que quedo a mitad de camino-. Los bytes de datos se
 * ignoran si todavia no se vio el START. El simbolo END cierra la trama y
 * la decodifica.
 * @return el nuevo estado, y el resultado de decodeFrame si END cerro una trama (o null si no).
 */
fun advanceAssembly(state: AssemblyState, value: Any): Pair<AssemblyState, DecodeResult?> {
    if (value == START) {
        return AssemblyState(receiving = true, buffer = emptyList()) to null
    }

    if (!state.receiving) {
        return state to null
    }

    if (value == END) {
        val result = decodeFrame(state.buffer)
        return createAssemblyState() to result
    }

    val byte = value as Int
    return AssemblyState(receiving = true, buffer = state.buffer + byte) to null
}
