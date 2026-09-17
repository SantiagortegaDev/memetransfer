package com.memetransfer.receiver.vision

import android.content.Context
import org.opencv.core.Mat
import org.opencv.core.Size
import org.opencv.imgproc.Imgproc
import org.tensorflow.lite.Interpreter
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.MappedByteBuffer
import java.nio.channels.FileChannel

/**
 * Envoltorio de TensorFlow Lite para MobileNetV3Small (assets/model_embedder.tflite,
 * generado por scripts/precompute_android_features.py). El grafo exportado
 * ya incluye la capa de rescaling interna de MobileNetV3, asi que la
 * entrada son pixeles RGB crudos en 0..255 (float32) - NO hay que
 * normalizar a [-1,1] ni a [0,1] de este lado, igual que hace
 * tf.keras.applications.mobilenet_v3.preprocess_input en el script de
 * precomputo (que para MobileNetV3 es un no-op).
 */
class EmbeddingModel(context: Context) {
    private val interpreter: Interpreter = Interpreter(loadModelFile(context))
    val embeddingDim: Int = interpreter.getOutputTensor(0).shape().last()
    private val inputSize: Int = interpreter.getInputTensor(0).shape()[1] // [1, H, W, 3]

    /** @param rgbMat Mat CV_8UC3 en orden RGB, cualquier tamano (se redimensiona internamente). */
    fun embed(rgbMat: Mat): FloatArray {
        val resized = Mat()
        Imgproc.resize(rgbMat, resized, Size(inputSize.toDouble(), inputSize.toDouble()), 0.0, 0.0, Imgproc.INTER_AREA)

        val pixelCount = inputSize * inputSize * 3
        val pixelBytes = ByteArray(pixelCount)
        resized.get(0, 0, pixelBytes)
        resized.release()

        val inputBuffer = ByteBuffer.allocateDirect(4 * pixelCount).order(ByteOrder.nativeOrder())
        for (b in pixelBytes) inputBuffer.putFloat((b.toInt() and 0xFF).toFloat())
        inputBuffer.rewind()

        val output = Array(1) { FloatArray(embeddingDim) }
        interpreter.run(inputBuffer, output)
        val embedding = output[0]
        normalizeInPlace(embedding)
        return embedding
    }

    /** Similitud coseno contra las referencias top-K, asumiendo que AMBOS vectores ya estan normalizados a norma 1. */
    fun topK(query: FloatArray, references: List<ReferenceEntry>, k: Int): List<Pair<ReferenceEntry, Float>> {
        return references
            .map { ref -> ref to cosineSimNormalized(query, ref.embedding) }
            .sortedByDescending { it.second }
            .take(k)
    }

    fun close() = interpreter.close()

    private fun cosineSimNormalized(a: FloatArray, b: FloatArray): Float {
        var dot = 0f
        for (i in a.indices) dot += a[i] * b[i]
        return dot
    }

    private fun normalizeInPlace(vector: FloatArray) {
        var sumSq = 0.0
        for (v in vector) sumSq += v.toDouble() * v.toDouble()
        val norm = kotlin.math.sqrt(sumSq).toFloat()
        if (norm > 0f) for (i in vector.indices) vector[i] = vector[i] / norm
    }

    companion object {
        private fun loadModelFile(context: Context): MappedByteBuffer {
            val afd = context.assets.openFd("model_embedder.tflite")
            FileInputStream(afd.fileDescriptor).use { input ->
                val channel = input.channel
                return channel.map(FileChannel.MapMode.READ_ONLY, afd.startOffset, afd.declaredLength)
            }
        }
    }
}
