package com.memetransfer.receiver.camera

import android.content.Context
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import java.util.concurrent.Executors

/**
 * Arranca CameraX (Preview + ImageAnalysis) y entrega cada frame como un
 * Mat RGBA ya rotado a la orientacion vertical correcta, listo para
 * VisionEngine.match() (via ReceiverEngine.onFrame).
 */
class CameraController(
    private val context: Context,
    private val lifecycleOwner: LifecycleOwner,
    private val previewView: PreviewView,
    private val onFrame: (Mat) -> Unit,
) {
    private var cameraProvider: ProcessCameraProvider? = null
    private val analysisExecutor = Executors.newSingleThreadExecutor()

    fun start() {
        val providerFuture = ProcessCameraProvider.getInstance(context)
        providerFuture.addListener({
            val provider = providerFuture.get()
            cameraProvider = provider

            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(previewView.surfaceProvider)
            }

            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                .build()
            analysis.setAnalyzer(analysisExecutor) { imageProxy -> processFrame(imageProxy) }

            provider.unbindAll()
            provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        }, ContextCompat.getMainExecutor(context))
    }

    fun stop() {
        cameraProvider?.unbindAll()
        cameraProvider = null
    }

    private fun processFrame(imageProxy: ImageProxy) {
        try {
            val mat = rgbaMatFrom(imageProxy)
            val rotated = rotateIfNeeded(mat, imageProxy.imageInfo.rotationDegrees)
            if (rotated !== mat) mat.release()
            onFrame(rotated)
            rotated.release()
        } finally {
            imageProxy.close()
        }
    }

    /**
     * ImageAnalysis con OUTPUT_IMAGE_FORMAT_RGBA_8888 entrega un solo plano
     * con datos RGBA_8888 (contrato documentado de CameraX desde 1.3) - se
     * copia directamente a un Mat CV_8UC4, respetando el rowStride (puede
     * tener padding al final de cada fila).
     */
    private fun rgbaMatFrom(imageProxy: ImageProxy): Mat {
        val plane = imageProxy.planes[0]
        val buffer = plane.buffer
        val rowStride = plane.rowStride
        val width = imageProxy.width
        val height = imageProxy.height
        val mat = Mat(height, width, CvType.CV_8UC4)

        if (rowStride == width * 4) {
            val bytes = ByteArray(buffer.remaining())
            buffer.get(bytes)
            mat.put(0, 0, bytes)
        } else {
            val rowBytes = ByteArray(rowStride)
            val rowOut = ByteArray(width * 4)
            for (row in 0 until height) {
                buffer.position(row * rowStride)
                buffer.get(rowBytes, 0, rowStride)
                System.arraycopy(rowBytes, 0, rowOut, 0, width * 4)
                mat.put(row, 0, rowOut)
            }
        }
        return mat
    }

    private fun rotateIfNeeded(mat: Mat, rotationDegrees: Int): Mat {
        if (rotationDegrees == 0) return mat
        val rotated = Mat()
        when (rotationDegrees) {
            90 -> Core.rotate(mat, rotated, Core.ROTATE_90_CLOCKWISE)
            180 -> Core.rotate(mat, rotated, Core.ROTATE_180)
            270 -> Core.rotate(mat, rotated, Core.ROTATE_90_COUNTERCLOCKWISE)
            else -> return mat
        }
        return rotated
    }
}
