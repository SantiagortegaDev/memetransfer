package com.memetransfer.receiver.vision

import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfPoint
import org.opencv.core.MatOfPoint2f
import org.opencv.core.Point
import org.opencv.core.Rect
import org.opencv.core.Scalar
import org.opencv.core.Size
import org.opencv.imgproc.Imgproc

/**
 * Aisla la pantalla del emisor dentro de un frame de camara completo (quita
 * bisel/fondo/mano): Canny -> findContours -> approxPolyDP -> el
 * cuadrilatero convexo mas grande y plausible -> getPerspectiveTransform +
 * warpPerspective a un cuadrado canonico. Si no se encuentra un
 * cuadrilatero confiable, cae a un letterbox centrado (fitContainSquare) en
 * vez de descartar el frame - mejor un intento con mas ruido que ninguno.
 *
 * Opera sobre el frame EN COLOR (no grayscale): la deteccion de bordes se
 * hace sobre una conversion a gris interna, pero el warp/letterbox final se
 * aplica al frame de color, para que tanto ORB (que solo necesita gris,
 * derivado despues) como el embedding (que si usa color) trabajen sobre
 * exactamente el mismo recorte/perspectiva.
 *
 * Puerto directo del algoritmo ya validado (aunque nunca corrido en
 * hardware real) de la version revertida de js/vision.js, extendido para
 * preservar color.
 */
object ScreenIsolator {
    /** @return el frame de color (CANONICAL_SIZE x CANONICAL_SIZE, mismo tipo/canales que `colorFrame`) enderezado, y si se encontro un cuadrilatero real. */
    fun isolate(colorFrame: Mat, canonicalSize: Int): Pair<Mat, Boolean> {
        val gray = when (colorFrame.channels()) {
            4 -> Mat().also { Imgproc.cvtColor(colorFrame, it, Imgproc.COLOR_RGBA2GRAY) }
            3 -> Mat().also { Imgproc.cvtColor(colorFrame, it, Imgproc.COLOR_RGB2GRAY) }
            else -> colorFrame.clone() // ya es gris (no deberia pasar en la practica - CameraController siempre entrega RGBA)
        }
        val warped = findAndWarpScreen(colorFrame, gray, canonicalSize)
        gray.release()
        return if (warped != null) {
            warped to true
        } else {
            fitContainSquare(colorFrame, canonicalSize) to false
        }
    }

    private fun findAndWarpScreen(colorFrame: Mat, gray: Mat, canonicalSize: Int): Mat? {
        val blurred = Mat()
        Imgproc.GaussianBlur(gray, blurred, Size(5.0, 5.0), 0.0)
        val edges = Mat()
        Imgproc.Canny(blurred, edges, 75.0, 200.0)
        blurred.release()

        val contours = ArrayList<MatOfPoint>()
        val hierarchy = Mat()
        Imgproc.findContours(edges, contours, hierarchy, Imgproc.RETR_LIST, Imgproc.CHAIN_APPROX_SIMPLE)
        edges.release()
        hierarchy.release()

        val frameArea = (gray.rows() * gray.cols()).toDouble()
        var bestQuad: Array<Point>? = null
        var bestArea = 0.0

        for (contour in contours) {
            val area = Imgproc.contourArea(contour)
            // El piso subio de 8% a 45%: datos reales (android-v7) mostraron
            // que sobre memes fotograficos (con mucho detalle interno) casi
            // cualquier quad chico detectado termina siendo un borde DENTRO
            // de la foto, no la pantalla real - da inliers=0/similaridad
            // baja siempre que eso pasa. Los aciertos reales (START/END,
            // con fondo simple) siempre correspondian a un cuadrilatero que
            // ocupa la mayor parte del frame, como se espera si el usuario
            // encuadro bien la pantalla completa.
            if (area < frameArea * 0.45 || area > frameArea * 0.95) continue

            val contour2f = MatOfPoint2f(*contour.toArray())
            val approx2f = MatOfPoint2f()
            val peri = Imgproc.arcLength(contour2f, true)
            Imgproc.approxPolyDP(contour2f, approx2f, 0.02 * peri, true)
            contour2f.release()

            val points = approx2f.toArray()
            if (points.size == 4 && area > bestArea) {
                val asMatOfPoint = MatOfPoint(*points)
                if (Imgproc.isContourConvex(asMatOfPoint)) {
                    bestQuad = points
                    bestArea = area
                }
                asMatOfPoint.release()
            }
            approx2f.release()
        }

        if (bestQuad == null) return null
        val ordered = orderQuadCorners(bestQuad)

        val srcMat = MatOfPoint2f(*ordered)
        val dstMat = MatOfPoint2f(
            Point(0.0, 0.0),
            Point(canonicalSize.toDouble(), 0.0),
            Point(canonicalSize.toDouble(), canonicalSize.toDouble()),
            Point(0.0, canonicalSize.toDouble()),
        )
        val homography = Imgproc.getPerspectiveTransform(srcMat, dstMat)
        srcMat.release()
        dstMat.release()

        val warped = Mat()
        Imgproc.warpPerspective(colorFrame, warped, homography, Size(canonicalSize.toDouble(), canonicalSize.toDouble()))
        homography.release()

        return warped
    }

    /** Ordena 4 puntos como [arriba-izq, arriba-der, abajo-der, abajo-izq] por suma/resta de coordenadas. */
    private fun orderQuadCorners(pts: Array<Point>): Array<Point> {
        val bySum = pts.sortedBy { it.x + it.y }
        val topLeft = bySum.first()
        val bottomRight = bySum.last()
        val byDiff = pts.sortedBy { it.y - it.x }
        val topRight = byDiff.first()
        val bottomLeft = byDiff.last()
        return arrayOf(topLeft, topRight, bottomRight, bottomLeft)
    }

    /** Fallback: letterbox centrado sobre fondo gris, sin recortar ni distorsionar el aspecto (como CSS object-fit: contain). */
    private fun fitContainSquare(colorFrame: Mat, size: Int): Mat {
        val scale = minOf(size.toDouble() / colorFrame.cols(), size.toDouble() / colorFrame.rows())
        val newW = Math.round(colorFrame.cols() * scale).toInt()
        val newH = Math.round(colorFrame.rows() * scale).toInt()
        val resized = Mat()
        Imgproc.resize(colorFrame, resized, Size(newW.toDouble(), newH.toDouble()), 0.0, 0.0, Imgproc.INTER_AREA)

        val canvas = Mat(size, size, colorFrame.type(), Scalar(128.0, 128.0, 128.0, 255.0))
        val x0 = (size - newW) / 2
        val y0 = (size - newH) / 2
        val roi = Mat(canvas, Rect(x0, y0, newW, newH))
        resized.copyTo(roi)
        resized.release()

        return canvas
    }
}
