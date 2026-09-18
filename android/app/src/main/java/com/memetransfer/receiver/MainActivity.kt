package com.memetransfer.receiver

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.lifecycleScope
import com.memetransfer.receiver.camera.CameraController
import com.memetransfer.receiver.databinding.ActivityMainBinding
import com.memetransfer.receiver.debug.DebugLog
import com.memetransfer.receiver.receiver.DebugEntry
import com.memetransfer.receiver.receiver.ReceiverEngine
import com.memetransfer.receiver.update.ApkInstaller
import com.memetransfer.receiver.update.UpdateChecker
import com.memetransfer.receiver.vision.VisionEngine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.opencv.android.OpenCVLoader
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private val debugLog = DebugLog()
    private val apkInstaller by lazy { ApkInstaller(this) }

    private var visionEngine: VisionEngine? = null
    private var receiverEngine: ReceiverEngine? = null
    private var cameraController: CameraController? = null

    private val requestCameraPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startReceiving() else showToast(getString(R.string.permission_camera_denied))
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Red de seguridad de ultimo recurso: si algo revienta en CUALQUIER
        // hilo (OpenCV nativo, TFLite, CameraX) y la app se va a cerrar
        // igual, al menos guarda el stack trace completo en un archivo
        // legible - sin esto, un crash en este beta no deja ningun rastro
        // que se pueda compartir para diagnosticar a distancia.
        Thread.setDefaultUncaughtExceptionHandler { _, throwable ->
            runCatching { writeCrashLog(throwable) }
            android.os.Process.killProcess(android.os.Process.myPid())
        }

        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnCopy.setOnClickListener { copyResultToClipboard() }
        binding.btnCheckUpdate.setOnClickListener { checkForUpdate(showUpToDateMessage = true) }
        binding.btnExportLog.setOnClickListener { exportLog() }

        binding.bytesText.text = getString(R.string.bytes_received_empty)
        updateLogCount()

        showPreviousCrashIfAny()
        ensureCameraPermissionAndStart()
        checkForUpdate(showUpToDateMessage = false)
    }

    private fun crashLogFile(): File = File(filesDir, "last_crash.txt")

    private fun writeCrashLog(throwable: Throwable) {
        val sw = StringWriter()
        throwable.printStackTrace(PrintWriter(sw))
        crashLogFile().writeText(sw.toString())
    }

    /**
     * Si la sesion anterior se cerro de un crash, lo muestra apenas se abre
     * la app de nuevo - asi no hace falta adb para ver que paso. Se manda a
     * traves de debugLog (no se pisa directo el TextView) para que no lo
     * borre el primer tick de deteccion que llegue despues.
     */
    private fun showPreviousCrashIfAny() {
        val file = crashLogFile()
        if (!file.exists()) return
        val trace = file.readText()
        file.delete()
        binding.statusText.text = "La app se cerró de un error la última vez. Detalle abajo ⬇️"
        debugLog.addEvent("CRASH ANTERIOR:\n$trace")
        refreshDebugText()
        updateLogCount()
    }

    override fun onDestroy() {
        super.onDestroy()
        cameraController?.stop()
        receiverEngine?.stop()
        visionEngine?.close()
    }

    private fun ensureCameraPermissionAndStart() {
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) startReceiving() else requestCameraPermission.launch(Manifest.permission.CAMERA)
    }

    private fun startReceiving() {
        binding.statusText.text = getString(R.string.status_waiting)
        binding.statusText.setTextColor(ContextCompat.getColor(this, R.color.md_theme_onBackground))

        // El artefacto de OpenCV en Maven Central NO carga su libreria
        // nativa sola - hay que inicializarla explicitamente antes de tocar
        // cualquier clase de org.opencv.*, o la primera llamada (un simple
        // `Mat()`) revienta con UnsatisfiedLinkError. initLocal() es
        // sincronico porque el .so ya viene empaquetado en el APK (no hace
        // falta la app externa "OpenCV Manager" del flujo viejo initAsync).
        if (!OpenCVLoader.initLocal()) {
            showInitError("OpenCV (initLocal)", IllegalStateException("OpenCVLoader.initLocal() devolvió false"))
            return
        }

        lifecycleScope.launch {
            val engine = try {
                withContext(Dispatchers.Default) { VisionEngine(this@MainActivity) }
            } catch (t: Throwable) {
                showInitError("VisionEngine (OpenCV/TFLite/referencias)", t)
                return@launch
            }
            visionEngine = engine

            val receiver = ReceiverEngine(
                visionEngine = engine,
                onProgress = { buffer ->
                    runOnUiThread {
                        // por si una corrida anterior dejo el texto teñido de rojo/verde
                        binding.statusText.setTextColor(ContextCompat.getColor(this@MainActivity, R.color.md_theme_onBackground))
                        binding.statusText.text = getString(R.string.status_receiving, buffer.size)
                        binding.bytesText.text = getString(R.string.bytes_received_format, buffer.size, buffer.toString())
                        // buffer vacio = esto es la confirmacion del START en si (todavia no
                        // hay ningun byte de datos) - no tiene sentido loguear "byte: null"
                        if (buffer.isNotEmpty()) {
                            debugLog.addEvent("byte confirmado: ${buffer.last()} (van ${buffer.size})")
                        } else {
                            debugLog.addEvent("inicio de transmisión confirmado")
                        }
                        refreshDebugText()
                    }
                },
                onSuccess = { text ->
                    runOnUiThread {
                        binding.statusText.text = getString(R.string.status_done)
                        binding.statusText.setTextColor(ContextCompat.getColor(this@MainActivity, R.color.md_theme_success))
                        binding.resultCard.visibility = android.view.View.VISIBLE
                        binding.resultCard.strokeColor = ContextCompat.getColor(this@MainActivity, R.color.md_theme_success)
                        binding.resultText.text = text
                        debugLog.addEvent("mensaje completo: \"$text\"")
                        refreshDebugText()
                    }
                },
                onError = { error ->
                    runOnUiThread {
                        binding.statusText.text = "Error: $error"
                        binding.statusText.setTextColor(ContextCompat.getColor(this@MainActivity, R.color.md_theme_error))
                        debugLog.addEvent("error: $error (reiniciando escucha)")
                        refreshDebugText()
                        binding.bytesText.text = getString(R.string.bytes_received_empty)
                        // se reinicia solo para poder recibir otro intento sin reactivar la camara a mano
                        receiverEngine?.start()
                        // sin este reset el mensaje de error queda pegado en pantalla aunque el
                        // receptor ya haya vuelto a escuchar en segundo plano - el color tambien
                        // hay que resetearlo, si no queda rojo para siempre despues del primer error
                        binding.statusText.postDelayed(
                            {
                                binding.statusText.text = getString(R.string.status_waiting)
                                binding.statusText.setTextColor(ContextCompat.getColor(this@MainActivity, R.color.md_theme_onBackground))
                            },
                            2500,
                        )
                    }
                },
                onDebug = { entry: DebugEntry ->
                    debugLog.add(entry)
                    runOnUiThread {
                        refreshDebugText()
                        updateLogCount()
                    }
                },
            )
            receiver.start()
            receiverEngine = receiver

            try {
                cameraController = CameraController(
                    context = this@MainActivity,
                    lifecycleOwner = this@MainActivity,
                    previewView = binding.cameraPreview,
                    onFrame = { frame -> receiver.onFrame(frame) },
                ).also { it.start() }
            } catch (t: Throwable) {
                showInitError("CameraController (CameraX)", t)
            }
        }
    }

    /** Muestra el error completo en pantalla (en vez de crashear) para poder diagnosticar sin adb. */
    private fun showInitError(where: String, t: Throwable) {
        val sw = StringWriter()
        t.printStackTrace(PrintWriter(sw))
        binding.statusText.text = "Error inicializando $where"
        binding.debugLogText.text = "===== ERROR EN $where =====\n${sw}"
    }

    /**
     * Actualiza el texto del log y hace auto-scroll SOLO si el usuario ya
     * estaba mirando el final - si scrolleo para arriba a leer algo
     * anterior, actualizar el texto no lo debe arrastrar de vuelta abajo
     * (eso era lo que hacia que el scroll pareciera "loco").
     */
    private fun refreshDebugText() {
        val wasAtBottom = isScrolledToBottom()
        binding.debugLogText.text = debugLog.displayText()
        if (wasAtBottom) {
            binding.debugScroll.post { binding.debugScroll.fullScroll(android.view.View.FOCUS_DOWN) }
        }
    }

    private fun isScrolledToBottom(): Boolean {
        val scroll = binding.debugScroll
        if (scroll.childCount == 0) return true
        val child = scroll.getChildAt(0)
        val threshold = 24 // px de tolerancia
        val bottomOfContent = child.bottom
        val visibleBottom = scroll.scrollY + scroll.height
        return bottomOfContent - visibleBottom <= threshold
    }

    private fun updateLogCount() {
        binding.logCountText.text = "${debugLog.exportLineCount()} líneas en el log"
    }

    /** Escribe el log completo de la sesion a un archivo y abre el selector de "compartir" de Android. */
    private fun exportLog() {
        val logsDir = File(cacheDir, "logs").also { it.mkdirs() }
        val timestamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        val file = File(logsDir, "memetransfer-log-$timestamp.txt")
        file.writeText(debugLog.exportText())

        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(intent, "Compartir log"))
    }

    private fun copyResultToClipboard() {
        val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("meme transfer", binding.resultText.text))
        showToast(getString(R.string.btn_copy))
    }

    private fun checkForUpdate(showUpToDateMessage: Boolean) {
        lifecycleScope.launch {
            val update = UpdateChecker.checkForUpdate(BuildConfig.VERSION_NAME)
            if (update == null) {
                if (showUpToDateMessage) showToast("Ya tenés la última versión")
                return@launch
            }
            AlertDialog.Builder(this@MainActivity)
                .setTitle(R.string.update_available_title)
                .setMessage(getString(R.string.update_available_message, update.tagName, BuildConfig.VERSION_NAME))
                .setPositiveButton(R.string.update_download) { _, _ -> startUpdateDownload(update.downloadUrl, update.tagName) }
                .setNegativeButton(R.string.update_cancel, null)
                .show()
        }
    }

    private fun startUpdateDownload(downloadUrl: String, tagName: String) {
        if (!apkInstaller.canInstallPackages()) {
            showToast("Habilitá \"instalar apps desconocidas\" para esta app")
            apkInstaller.requestInstallPermission()
            return
        }
        apkInstaller.downloadAndInstall(downloadUrl, "memetransfer-receiver-$tagName.apk") {
            showToast("Descargando actualización…")
        }
    }

    private fun showToast(message: String) {
        android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_SHORT).show()
    }
}
