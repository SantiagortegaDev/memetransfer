package com.memetransfer.receiver.debug

import com.memetransfer.receiver.receiver.DebugEntry
import java.util.ArrayDeque
import java.util.Locale

/**
 * Guarda las detecciones crudas de dos formas: un ring buffer chico para el
 * panel SIEMPRE visible en pantalla (no tiene sentido renderizar miles de
 * lineas en un TextView), y una lista mas grande (tope alto, no
 * "infinito", para no comerse toda la memoria en una sesion larga) para
 * poder exportar el log completo de la sesion y mandarlo a analizar.
 */
class DebugLog(private val maxDisplayLines: Int = 80, private val maxExportLines: Int = 20_000) {
    private val displayLines = ArrayDeque<String>()
    private val exportLines = ArrayDeque<String>()
    private val startTime = System.currentTimeMillis()

    fun add(entry: DebugEntry) {
        val elapsedSec = (System.currentTimeMillis() - startTime) / 1000.0
        val label = entry.label?.toString() ?: "-"
        val category = entry.category ?: "GAP"
        val line = String.format(
            Locale.US,
            "[%7.2fs] categ=%-9s label=%-4s inliers=%3d sim=%.3f pantalla=%s t=%4dms",
            elapsedSec,
            category,
            label,
            entry.inliers,
            entry.topSimilarity,
            if (entry.screenFound) "si" else "no",
            entry.elapsedMs,
        )
        displayLines.addLast(line)
        while (displayLines.size > maxDisplayLines) displayLines.removeFirst()

        exportLines.addLast(line)
        while (exportLines.size > maxExportLines) exportLines.removeFirst()
    }

    /** Marca un evento importante (byte confirmado, START/END, error) tanto en pantalla como en la exportacion. */
    fun addEvent(message: String) {
        val elapsedSec = (System.currentTimeMillis() - startTime) / 1000.0
        val line = String.format(Locale.US, "[%7.2fs] >>> %s", elapsedSec, message)
        displayLines.addLast(line)
        while (displayLines.size > maxDisplayLines) displayLines.removeFirst()
        exportLines.addLast(line)
        while (exportLines.size > maxExportLines) exportLines.removeFirst()
    }

    fun displayText(): String = displayLines.joinToString("\n")
    fun exportText(): String = exportLines.joinToString("\n")
    fun exportLineCount(): Int = exportLines.size
}
