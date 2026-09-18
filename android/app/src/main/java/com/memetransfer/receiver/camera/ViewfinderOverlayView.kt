package com.memetransfer.receiver.camera

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import androidx.core.content.ContextCompat
import com.memetransfer.receiver.R

/**
 * Guia visual dibujada sobre el PreviewView: un recuadro redondeado que
 * representa ~50% del area del cuadro de camara (por encima del piso real
 * de deteccion, 45%, fijado en ScreenIsolator), con scrim oscuro afuera y
 * esquinas tipo "scanner" para reforzar donde encuadrar la pantalla del
 * emisor. Puramente decorativa: no es clickable ni focusable, y no
 * intercepta el touch del PreviewView debajo.
 *
 * Nota de fidelidad: las "L" de las esquinas se dibujan desde el vertice
 * recto del rectangulo (ignorando el corner radius del propio recuadro) -
 * a proposito, para mantener el codigo simple; el pequeno solape visual
 * con la curva no afecta la legibilidad de la guia.
 */
class ViewfinderOverlayView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    companion object {
        // 0.78 * 0.64 ~= 0.50 del area total: encima del piso de deteccion
        // (45%) con margen para que un encuadre imperfecto igual detecte.
        private const val BOX_WIDTH_FRACTION = 0.78f
        private const val BOX_HEIGHT_FRACTION = 0.64f
        private const val CORNER_RADIUS_DP = 16f
        private const val BRACKET_LENGTH_DP = 28f
        private const val STROKE_WIDTH_DP = 3f
        private const val SCRIM_ALPHA = 0x99 // ~60% opacidad
    }

    private val density = resources.displayMetrics.density

    private val scrimPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = android.graphics.Color.BLACK
        alpha = SCRIM_ALPHA
        style = Paint.Style.FILL
    }

    private val clearPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
        style = Paint.Style.FILL
    }

    private val bracketPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = ContextCompat.getColor(context, R.color.md_theme_primary)
        style = Paint.Style.STROKE
        strokeWidth = STROKE_WIDTH_DP * density
        strokeCap = Paint.Cap.ROUND
    }

    init {
        isClickable = false
        isFocusable = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val boxW = width * BOX_WIDTH_FRACTION
        val boxH = height * BOX_HEIGHT_FRACTION
        val left = (width - boxW) / 2f
        val top = (height - boxH) / 2f
        val boxRect = RectF(left, top, left + boxW, top + boxH)
        val cornerRadius = CORNER_RADIUS_DP * density

        // 1) Scrim oscuro en toda la vista, con un agujero transparente
        //    redondeado del tamano del recuadro guia.
        val layerId = canvas.saveLayer(0f, 0f, width.toFloat(), height.toFloat(), null)
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), scrimPaint)
        canvas.drawRoundRect(boxRect, cornerRadius, cornerRadius, clearPaint)
        canvas.restoreToCount(layerId)

        // 2) Esquinas tipo "scanner" sobre el borde del recuadro.
        val bracket = BRACKET_LENGTH_DP * density
        drawCorner(canvas, boxRect.left, boxRect.top, bracket, bracket)
        drawCorner(canvas, boxRect.right, boxRect.top, -bracket, bracket)
        drawCorner(canvas, boxRect.left, boxRect.bottom, bracket, -bracket)
        drawCorner(canvas, boxRect.right, boxRect.bottom, -bracket, -bracket)
    }

    /** Dibuja una "L" desde (x,y) extendiendose dx horizontal y dy vertical. */
    private fun drawCorner(canvas: Canvas, x: Float, y: Float, dx: Float, dy: Float) {
        canvas.drawLine(x, y, x + dx, y, bracketPaint)
        canvas.drawLine(x, y, x, y + dy, bracketPaint)
    }
}
