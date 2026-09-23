package expo.modules.myobluenative

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Self-update from a GitHub release APK: streams the download straight into a PackageInstaller
 * session. The first update needs the user to confirm; once the app has installed itself it is the
 * installer of record, so on Android 12+ later updates can go through without a prompt.
 */
object Updater {
  var listener: ((phase: String, progress: Double, message: String?) -> Unit)? = null
  @Volatile var busy = false

  fun emit(phase: String, progress: Double = 0.0, message: String? = null) {
    if (phase == "done" || phase == "error") busy = false
    listener?.invoke(phase, progress, message)
  }

  fun versionCode(ctx: Context): Long {
    val info = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
    return if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
  }

  fun canInstall(ctx: Context) = Build.VERSION.SDK_INT < 26 || ctx.packageManager.canRequestPackageInstalls()

  fun openInstallPermission(ctx: Context) {
    val i = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.packageName))
    ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  fun install(ctx: Context, url: String): Boolean {
    if (busy) return false
    busy = true
    val app = ctx.applicationContext
    thread(name = "myolift-update") {
      var session: PackageInstaller.Session? = null
      try {
        val installer = app.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(app.packageName)
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        val id = installer.createSession(params)
        val s = installer.openSession(id)
        session = s
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.instanceFollowRedirects = true
        conn.connectTimeout = 20000
        conn.readTimeout = 30000
        if (conn.responseCode !in 200..299) throw Exception("download failed: HTTP ${conn.responseCode}")
        val total = conn.contentLengthLong
        conn.inputStream.use { input ->
          s.openWrite("myolift.apk", 0, if (total > 0) total else -1).use { out ->
            val buf = ByteArray(64 * 1024)
            var done = 0L
            var last = 0L
            while (true) {
              val n = input.read(buf)
              if (n < 0) break
              out.write(buf, 0, n)
              done += n
              if (total > 0 && done - last > total / 50) { last = done; emit("download", done.toDouble() / total) }
            }
            s.fsync(out)
          }
        }
        emit("install", 1.0)
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= 31) flags = flags or PendingIntent.FLAG_MUTABLE
        val pi = PendingIntent.getBroadcast(app, id, Intent(app, UpdateReceiver::class.java).setPackage(app.packageName), flags)
        s.commit(pi.intentSender)
        s.close()
      } catch (e: Exception) {
        session?.abandon()
        emit("error", 0.0, e.message ?: e.toString())
      }
    }
    return true
  }
}

/** Result of the install session: ask the user to confirm, or report failure. */
class UpdateReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999)) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        val confirm: Intent? = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
          else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
        if (confirm != null) ctx.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        Updater.emit("confirm", 1.0)
      }
      PackageInstaller.STATUS_SUCCESS -> Updater.emit("done", 1.0)
      else -> Updater.emit("error", 0.0, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "install failed ($status)")
    }
  }
}
