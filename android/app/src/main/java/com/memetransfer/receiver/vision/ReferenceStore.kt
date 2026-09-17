package com.memetransfer.receiver.vision

import android.content.Context
import org.json.JSONObject
import org.opencv.core.CvType
import org.opencv.core.Mat
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Una imagen de referencia (uno de los 256 memes o los 2 controles de
 * inicio/fin): su embedding precalculado (MobileNetV3Small) y sus
 * keypoints+descriptores ORB precalculados, tal como los escribio
 * scripts/precompute_android_features.py.
 */
class ReferenceEntry(
    val label: Any, // Int (0-255) o "start"/"end"
    val count: Int,
    val points: FloatArray, // count*2 (x0,y0,x1,y1,...) en coords canonicas (CANONICAL_SIZE)
    val descriptors: Mat, // count x 32, CV_8UC1 - liberar con .release() al terminar
    val embedding: FloatArray, // embeddingDim, YA normalizado a norma 1
)

class ReferenceStore(
    val canonicalSize: Int,
    val orbNFeatures: Int,
    val embeddingDim: Int,
    val entries: List<ReferenceEntry>,
) {
    fun release() {
        entries.forEach { it.descriptors.release() }
    }

    companion object {
        /**
         * Carga memes/reference_meta.json + reference_embeddings.bin +
         * reference_orb.bin desde assets/. Debe llamarse despues de que
         * OpenCV este inicializado (necesita CvType/Mat).
         */
        fun load(context: Context): ReferenceStore {
            val assets = context.assets

            val metaJson = assets.open("reference_meta.json").use { it.readBytes() }
            val meta = JSONObject(String(metaJson, Charsets.UTF_8))
            val canonicalSize = meta.getInt("canonicalSize")
            val orbNFeatures = meta.getInt("orbNFeatures")
            val embeddingDim = meta.getInt("embeddingDim")
            val entriesJson = meta.getJSONArray("entries")

            val orbBlob = assets.open("reference_orb.bin").use { readAllBytes(it) }
            val orbBuffer = ByteBuffer.wrap(orbBlob).order(ByteOrder.LITTLE_ENDIAN)

            val embeddingsBlob = assets.open("reference_embeddings.bin").use { readAllBytes(it) }
            val embeddingsBuffer = ByteBuffer.wrap(embeddingsBlob).order(ByteOrder.LITTLE_ENDIAN)

            val entries = ArrayList<ReferenceEntry>(entriesJson.length())
            for (i in 0 until entriesJson.length()) {
                val e = entriesJson.getJSONObject(i)
                val label: Any = if (e.get("index") is Int) e.getInt("index") else e.getString("index")
                val count = e.getInt("count")
                val pointsOffset = e.getInt("pointsOffset")
                val descriptorsOffset = e.getInt("descriptorsOffset")
                val descriptorsLength = e.getInt("descriptorsLength")

                val points = FloatArray(count * 2)
                orbBuffer.position(pointsOffset)
                for (p in points.indices) points[p] = orbBuffer.float

                val descriptorBytes = ByteArray(descriptorsLength)
                orbBuffer.position(descriptorsOffset)
                orbBuffer.get(descriptorBytes)
                val descriptors = Mat(count, 32, CvType.CV_8UC1)
                if (count > 0) descriptors.put(0, 0, descriptorBytes)

                val embedding = FloatArray(embeddingDim)
                val embOffset = i * embeddingDim * 4
                embeddingsBuffer.position(embOffset)
                for (d in embedding.indices) embedding[d] = embeddingsBuffer.float
                normalizeInPlace(embedding)

                entries.add(ReferenceEntry(label, count, points, descriptors, embedding))
            }

            return ReferenceStore(canonicalSize, orbNFeatures, embeddingDim, entries)
        }

        private fun readAllBytes(input: java.io.InputStream): ByteArray {
            val buffer = ByteArrayOutputStream()
            val chunk = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(chunk)
                if (read < 0) break
                buffer.write(chunk, 0, read)
            }
            return buffer.toByteArray()
        }

        private fun normalizeInPlace(vector: FloatArray) {
            var sumSq = 0.0
            for (v in vector) sumSq += v.toDouble() * v.toDouble()
            val norm = kotlin.math.sqrt(sumSq).toFloat()
            if (norm > 0f) {
                for (i in vector.indices) vector[i] = vector[i] / norm
            }
        }
    }
}
