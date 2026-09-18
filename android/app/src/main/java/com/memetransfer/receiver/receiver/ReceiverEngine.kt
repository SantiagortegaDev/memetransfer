package com.memetransfer.receiver.receiver

import com.memetransfer.receiver.protocol.AssemblyState
import com.memetransfer.receiver.protocol.DecodeResult
import com.memetransfer.receiver.protocol.END
import com.memetransfer.receiver.protocol.START
import com.memetransfer.receiver.protocol.SymbolStream
import com.memetransfer.receiver.protocol.advanceAssembly
import com.memetransfer.receiver.protocol.createAssemblyState
import com.memetransfer.receiver.vision.VisionEngine
import org.opencv.core.Mat

// Cada tick corre deteccion de pantalla + embedding + ORB - mucho mas caro
// que comparar contra un marcador propio, asi que el intervalo es mas
// largo que un tick de camara tipico (~33ms a 30fps).
//
// OJO con la relacion entre TICK_MS/STABLE_TICKS_REQUIRED y cuanto tiempo
// el emisor deja cada meme en pantalla (FRAME_MS=700ms + GAP_MS=150ms en
// js/sender.js, ~850ms totales por byte): con STABLE_TICKS_REQUIRED
// lecturas seguidas hacen falta TICK_MS*STABLE_TICKS_REQUIRED ms de
// deteccion estable para confirmar un byte. Con los valores viejos
// (280*3=840ms) eso quedaba practicamente pegado al borde de la ventana
// de 850ms - si el primer tick tras cambiar de meme no detecta a tiempo
// (autoenfoque, blur), nunca da tiempo a juntar 3 lecturas seguidas antes
// de que el emisor pase al siguiente byte, y el mensaje nunca termina de
// armarse (eventualmente dispara el timeout de PER_SYMBOL_TIMEOUT_MS aunque
// la deteccion en si funcione bien para memes individuales).
const val TICK_MS = 150L
const val STABLE_TICKS_REQUIRED = 2
const val PER_SYMBOL_TIMEOUT_MS = 5000L

data class DebugEntry(
    val category: String?, // "START" | "END" | "MATCH" | "UNMATCHED" | null (GAP)
    val label: Any?, // Int (0-255), "start", "end", o null
    val inliers: Int,
    val topSimilarity: Float,
    val screenFound: Boolean,
    val elapsedMs: Long,
)

/**
 * Orquesta la recepcion: para cada frame de camara (llamado desde
 * CameraController, throttleado a TICK_MS), corre VisionEngine.match(),
 * mapea el resultado a un valor observado (byte, START/END, o null), y lo
 * alimenta a SymbolStream -> FrameAssembler, igual que js/receiver.js.
 */
class ReceiverEngine(
    private val visionEngine: VisionEngine,
    private val onProgress: (buffer: List<Int>) -> Unit,
    private val onSuccess: (text: String) -> Unit,
    private val onError: (error: String) -> Unit,
    private val onDebug: (DebugEntry) -> Unit,
) {
    private val symbolStream = SymbolStream(STABLE_TICKS_REQUIRED)
    private var assemblyState: AssemblyState = createAssemblyState()
    private var lastTickAt = 0L
    private var lastSymbolAt = 0L // 0 = todavia no arranco a recibir, no hay timeout corriendo
    @Volatile private var stopped = false

    fun start() {
        symbolStream.reset()
        assemblyState = createAssemblyState()
        lastTickAt = 0L
        lastSymbolAt = 0L
        stopped = false
    }

    fun stop() {
        stopped = true
    }

    /** Se llama desde el analyzer de CameraX en cada frame disponible; se throttlea internamente a TICK_MS. */
    fun onFrame(rgbaFrame: Mat) {
        if (stopped) return
        val now = System.currentTimeMillis()
        if (now - lastTickAt < TICK_MS) return
        lastTickAt = now

        if (lastSymbolAt > 0 && now - lastSymbolAt > PER_SYMBOL_TIMEOUT_MS) {
            stopped = true
            symbolStream.reset()
            assemblyState = createAssemblyState()
            onError("timeout")
            return
        }

        val t0 = System.nanoTime()
        val result = visionEngine.match(rgbaFrame)
        val elapsedMs = (System.nanoTime() - t0) / 1_000_000

        var observedValue: Any? = null
        var category: String? = null
        when (result.label) {
            "start" -> {
                observedValue = START
                category = START
            }
            "end" -> {
                observedValue = END
                category = END
            }
            null -> category = if (result.screenFound) "UNMATCHED" else null
            else -> {
                observedValue = result.label
                category = "MATCH"
            }
        }

        onDebug(DebugEntry(category, result.label, result.inliers, result.topSimilarity, result.screenFound, elapsedMs))

        val event = symbolStream.tick(observedValue) ?: return
        val (nextState, done) = advanceAssembly(assemblyState, event)
        assemblyState = nextState

        if (assemblyState.receiving) {
            lastSymbolAt = now
            onProgress(assemblyState.buffer)
        }

        if (done != null) {
            stopped = true
            when (done) {
                is DecodeResult.Ok -> onSuccess(done.text)
                is DecodeResult.Error -> onError(done.error)
            }
        }
    }
}
