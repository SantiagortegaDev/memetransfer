package com.memetransfer.receiver.vision

import org.opencv.calib3d.Calib3d
import org.opencv.core.Core
import org.opencv.core.DMatch
import org.opencv.core.Mat
import org.opencv.core.MatOfDMatch
import org.opencv.core.MatOfKeyPoint
import org.opencv.core.MatOfPoint2f
import org.opencv.core.Point
import org.opencv.features2d.BFMatcher

/**
 * Etapa de verificacion geometrica del pipeline "retrieve-and-rerank":
 * dado el frame capturado (ya reducido a los candidatos que
 * EmbeddingModel.topK() considero mas parecidos), confirma o rechaza cada
 * candidato con ORB + BFMatcher(Hamming) + Lowe ratio test + RANSAC
 * homography, aceptando solo si el mejor supera un piso de inliers Y le
 * saca ventaja clara al segundo candidato (evita confundir memes
 * visualmente parecidos entre si). Puerto directo del algoritmo ya
 * validado de matchFrame() en la version revertida de js/vision.js.
 */
object OrbVerifier {
    private const val LOWE_RATIO = 0.75
    private const val MIN_GOOD_MATCHES = 10
    private const val MIN_INLIERS = 10
    private const val RANSAC_REPROJ_THRESHOLD = 6.0
    private const val WINNER_MARGIN_RATIO = 1.3

    data class MatchResult(val label: Any?, val inliers: Int)

    private val matcher = BFMatcher.create(Core.NORM_HAMMING, false)

    private data class Candidate(val ref: ReferenceEntry, val goodMatches: List<DMatch>)

    fun verify(
        queryKeypoints: MatOfKeyPoint,
        queryDescriptors: Mat,
        candidates: List<ReferenceEntry>,
    ): MatchResult {
        if (queryDescriptors.rows() == 0) return MatchResult(null, 0)

        // Etapa A (barata): contar "good matches" (Lowe ratio test) contra
        // cada candidato preseleccionado por embeddings.
        val scored = ArrayList<Candidate>()
        for (ref in candidates) {
            if (ref.count == 0) continue
            val knnMatches = ArrayList<MatOfDMatch>()
            matcher.knnMatch(queryDescriptors, ref.descriptors, knnMatches, 2)
            val goodMatches = ArrayList<DMatch>()
            for (pair in knnMatches) {
                val arr = pair.toArray()
                if (arr.size < 2) continue
                if (arr[0].distance < LOWE_RATIO * arr[1].distance) goodMatches.add(arr[0])
                pair.release()
            }
            if (goodMatches.size >= MIN_GOOD_MATCHES) scored.add(Candidate(ref, goodMatches))
        }
        scored.sortByDescending { it.goodMatches.size }

        // Etapa B (cara, solo para los mejores candidatos): homografia +
        // RANSAC, contando inliers.
        val queryPoints = queryKeypoints.toArray()
        var bestLabel: Any? = null
        var bestInliers = -1
        var runnerUpInliers = 0

        for (candidate in scored) {
            val srcPoints = ArrayList<Point>(candidate.goodMatches.size)
            val dstPoints = ArrayList<Point>(candidate.goodMatches.size)
            for (m in candidate.goodMatches) {
                srcPoints.add(queryPoints[m.queryIdx].pt)
                val px = candidate.ref.points[m.trainIdx * 2].toDouble()
                val py = candidate.ref.points[m.trainIdx * 2 + 1].toDouble()
                dstPoints.add(Point(px, py))
            }
            val srcMat = MatOfPoint2f(*srcPoints.toTypedArray())
            val dstMat = MatOfPoint2f(*dstPoints.toTypedArray())
            val mask = Mat()
            val homography = Calib3d.findHomography(srcMat, dstMat, Calib3d.RANSAC, RANSAC_REPROJ_THRESHOLD, mask)
            var inliers = 0
            for (row in 0 until mask.rows()) {
                if (mask.get(row, 0)[0] != 0.0) inliers++
            }
            srcMat.release()
            dstMat.release()
            mask.release()
            homography.release()

            if (inliers > bestInliers) {
                if (bestInliers >= 0) runnerUpInliers = bestInliers
                bestInliers = inliers
                bestLabel = candidate.ref.label
            } else if (inliers > runnerUpInliers) {
                runnerUpInliers = inliers
            }
        }

        if (bestLabel == null || bestInliers < MIN_INLIERS) {
            return MatchResult(null, bestInliers.coerceAtLeast(0))
        }
        if (runnerUpInliers > 0 && bestInliers < runnerUpInliers * WINNER_MARGIN_RATIO) {
            // dos candidatos casi empatados: demasiado ambiguo, mejor no
            // arriesgar una lectura incorrecta.
            return MatchResult(null, bestInliers)
        }
        return MatchResult(bestLabel, bestInliers)
    }
}
