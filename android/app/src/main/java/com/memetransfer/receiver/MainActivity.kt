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
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnCopy.setOnClickListener { copyResultToClipboard() }
        binding.btnCheckUpdate.setOnClickListener { checkForUpdate(showUpToDateMessage = true) }

        ensureCameraPermissionAndStart()
        checkForUpdate(showUpToDateMessage = false)
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
        lifecycleScope.launch {
            val engine = withContext(Dispatchers.Default) { VisionEngine(this@MainActivity) }
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

            cameraController = CameraController(
                context = this@MainActivity,
                lifecycleOwner = this@MainActivity,
                previewView = binding.cameraPreview,
                onFrame = { frame -> receiver.onFrame(frame) },
            ).also { it.start() }
        }
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
