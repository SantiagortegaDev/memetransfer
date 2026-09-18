package com.memetransfer.receiver

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
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

    /** Si la sesion anterior se cerro de un crash, lo muestra arriba de todo apenas se abre la app de nuevo - asi no hace falta adb para ver que paso. */
    private fun showPreviousCrashIfAny() {
        val file = crashLogFile()
        if (!file.exists()) return
        val trace = file.readText()
        file.delete()
        binding.statusText.text = "La app se cerró de un error la última vez. Detalle abajo ⬇️"
        binding.debugLogText.text = "===== CRASH ANTERIOR =====\n$trace"
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
                onProgress = { bufferSize ->
                    runOnUiThread { binding.statusText.text = getString(R.string.status_receiving, bufferSize) }
                },
                onSuccess = { text ->
                    runOnUiThread {
                        binding.statusText.text = getString(R.string.status_done)
                        binding.resultCard.visibility = android.view.View.VISIBLE
                        binding.resultText.text = text
                    }
                },
                onError = { error ->
                    runOnUiThread {
                        binding.statusText.text = "Error: $error"
                        // se reinicia solo para poder recibir otro intento sin reactivar la camara a mano
                        receiverEngine?.start()
                    }
                },
                onDebug = { entry: DebugEntry ->
                    debugLog.add(entry)
                    runOnUiThread {
                        binding.debugLogText.text = debugLog.text()
                        binding.debugScroll.post { binding.debugScroll.fullScroll(android.view.View.FOCUS_DOWN) }
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
