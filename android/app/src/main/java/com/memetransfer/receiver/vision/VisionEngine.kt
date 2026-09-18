package com.memetransfer.receiver.vision

import android.content.Context
import org.opencv.core.Mat
import org.opencv.core.MatOfKeyPoint
import org.opencv.features2d.ORB
import org.opencv.imgproc.Imgproc

// Debe coincidir EXACTO con scripts/precompute_android_features.py.
const val CANONICAL_SIZE = 480
const val ORB_NFEATURES = 500
private const val EMBEDDING_TOP_K = 16 // cuantos candidatos pasan de la etapa de embeddings a la de ORB - ampliado para dar mas margen a memes dificiles

/**
 * Pipeline completo de reconocimiento, un frame de camara a la vez:
 * 1. ScreenIsolator aisla la pantalla del emisor (contornos+homografia).
 * 2. EmbeddingModel.topK() preselecciona candidatos por similitud coseno.
 * 3. OrbVerifier confirma/rechaza esos candidatos con ORB+RANSAC.
 */
class VisionEngine(context: Context) {
    private val referenceStore = ReferenceStore.load(context)
    private val embeddingModel = EmbeddingModel(context)
    private val orb = ORB.create(
        ORB_NFEATURES, // nfeatures
        1.2f, // scaleFactor
        8, // nlevels
        31, // edgeThreshold
        0, // firstLevel
        2, // WTA_K
        ORB.HARRIS_SCORE,
        31, // patchSize
        20, // fastThreshold
    )

    data class Result(
        val label: Any?, // Int (byte 0-255), "start", "end", o null si no hay match confiable
        val inliers: Int,
        val topSimilarity: Float,
        val screenFound: Boolean,
    )

    /** @param cameraFrame Mat en color (CV_8UC4 RGBA o CV_8UC3 RGB), directo de la camara. */
    fun match(cameraFrame: Mat): Result {
        val (canonicalColor, screenFound) = ScreenIsolator.isolate(cameraFrame, CANONICAL_SIZE)

        // El frame de camara siempre llega como RGBA (ver CameraController,
        // que pide OUTPUT_IMAGE_FORMAT_RGBA_8888) - nunca BGR, asi que un
        // Mat de 3 canales ya esta en orden RGB y no necesita conversion.
        val canonicalRgb: Mat
        val canonicalGray = Mat()
        if (canonicalColor.channels() == 4) {
            canonicalRgb = Mat()
            Imgproc.cvtColor(canonicalColor, canonicalRgb, Imgproc.COLOR_RGBA2RGB)
            Imgproc.cvtColor(canonicalColor, canonicalGray, Imgproc.COLOR_RGBA2GRAY)
            canonicalColor.release()
        } else {
            canonicalRgb = canonicalColor
            Imgproc.cvtColor(canonicalColor, canonicalGray, Imgproc.COLOR_RGB2GRAY)
        }

        val queryEmbedding = embeddingModel.embed(canonicalRgb)
        canonicalRgb.release()
        val topCandidates = embeddingModel.topK(queryEmbedding, referenceStore.entries, EMBEDDING_TOP_K)
        val topSimilarity = topCandidates.firstOrNull()?.second ?: 0f

        val keypoints = MatOfKeyPoint()
        val descriptors = Mat()
        orb.detect(canonicalGray, keypoints)
        orb.compute(canonicalGray, keypoints, descriptors)
        canonicalGray.release()

        val verdict = OrbVerifier.verify(keypoints, descriptors, topCandidates.map { it.first })
        keypoints.release()
        descriptors.release()

        return Result(verdict.label, verdict.inliers, topSimilarity, screenFound)
    }

    fun close() {
        embeddingModel.close()
        referenceStore.release()
    }
}
