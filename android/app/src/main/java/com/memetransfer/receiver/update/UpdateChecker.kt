package com.memetransfer.receiver.update

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.net.HttpURLConnection
import java.net.URL

data class UpdateInfo(val tagName: String, val downloadUrl: String)

/**
 * Busca actualizaciones en GitHub Releases, incluyendo prereleases (no usa
 * /releases/latest porque ese endpoint las excluye, y esta app es siempre
 * un beta/prerelease). El tag de cada release tiene forma "android-vN" (N
 * entero), generado por .github/workflows/android-release.yml a partir del
 * tag que dispara el build - se compara N contra BuildConfig.VERSION_NAME
 * (tambien un entero simple, no semver, para evitar parsear de mas en un
 * beta).
 */
object UpdateChecker {
    private const val REPO = "SantiagortegaDev/memetransfer"
    private const val TAG_PREFIX = "android-v"

    suspend fun checkForUpdate(currentVersionName: String): UpdateInfo? = withContext(Dispatchers.IO) {
        try {
            val url = URL("https://api.github.com/repos/$REPO/releases")
            val connection = url.openConnection() as HttpURLConnection
            connection.setRequestProperty("Accept", "application/vnd.github+json")
            connection.connectTimeout = 10_000
            connection.readTimeout = 10_000

            val body = connection.inputStream.bufferedReader().use { it.readText() }
            connection.disconnect()

            val releases = JSONArray(body)
            if (releases.length() == 0) return@withContext null

            val latest = releases.getJSONObject(0) // la lista ya viene ordenada del mas nuevo al mas viejo
            val tagName = latest.getString("tag_name")
            if (!tagName.startsWith(TAG_PREFIX)) return@withContext null

            val latestVersion = tagName.removePrefix(TAG_PREFIX).toIntOrNull() ?: return@withContext null
            val currentVersion = currentVersionName.toIntOrNull() ?: 0
            if (latestVersion <= currentVersion) return@withContext null

            val assets = latest.getJSONArray("assets")
            var apkUrl: String? = null
            for (i in 0 until assets.length()) {
                val asset = assets.getJSONObject(i)
                if (asset.getString("name").endsWith(".apk")) {
                    apkUrl = asset.getString("browser_download_url")
                    break
                }
            }
            apkUrl?.let { UpdateInfo(tagName, it) }
        } catch (e: Exception) {
            null // sin conexion, rate-limit de la API, etc. - no bloquea el uso normal de la app
        }
    }
}
