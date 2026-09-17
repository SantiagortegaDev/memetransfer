package com.memetransfer.receiver.debug

import com.memetransfer.receiver.receiver.DebugEntry
import java.util.ArrayDeque
import java.util.Locale

/**
 * Ring buffer de las ultimas detecciones crudas, para el panel de debug
 * SIEMPRE visible (no es un modo opt-in): muestra que esta detectando la
 * camara aunque no haya arrancado o ya haya terminado una transmision -
 * mirror del debug-log de la web (js/main.js).
 */
class DebugLog(private val maxLines: Int = 50) {
    private val lines = ArrayDeque<String>()
    private val startTime = System.currentTimeMillis()

    fun add(entry: DebugEntry) {
        val elapsedSec = (System.currentTimeMillis() - startTime) / 1000.0
        val label = entry.label?.toString() ?: "-"
        val category = entry.category ?: "GAP"
        val line = String.format(
            Locale.US,
            "[%6.2fs] categ=%-9s label=%-4s inliers=%3d sim=%.3f pantalla=%s t=%4dms",
            elapsedSec,
            category,
            label,
            entry.inliers,
            entry.topSimilarity,
            if (entry.screenFound) "si" else "no",
            entry.elapsedMs,
        )
        lines.addLast(line)
        while (lines.size > maxLines) lines.removeFirst()
    }

    fun text(): String = lines.joinToString("\n")
}
