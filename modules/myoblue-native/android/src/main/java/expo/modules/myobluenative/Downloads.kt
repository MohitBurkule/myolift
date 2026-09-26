package expo.modules.myobluenative

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File

/**
 * Copies a finished export into Downloads/MyoLift, so it shows up over USB. Reads the source and
 * writes a copy only; the app's own data is never touched. The copy is checked byte-count equal.
 */
object Downloads {
  fun save(ctx: Context, src: String, name: String): String {
    val f = File(src.removePrefix("file://"))
    if (!f.exists()) throw Exception("export file missing")
    if (Build.VERSION.SDK_INT < 29) {
      val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "MyoLift")
      dir.mkdirs()
      val out = File(dir, name)
      f.copyTo(out, overwrite = false)
      if (out.length() != f.length()) throw Exception("copy is incomplete")
      return out.absolutePath
    }
    val values = ContentValues().apply {
      put(MediaStore.Downloads.DISPLAY_NAME, name)
      put(MediaStore.Downloads.MIME_TYPE, "application/zip")
      put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/MyoLift")
      put(MediaStore.Downloads.IS_PENDING, 1)
    }
    val resolver = ctx.contentResolver
    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw Exception("can't create the file in Downloads")
    var written = 0L
    try {
      resolver.openOutputStream(uri)!!.use { out ->
        f.inputStream().use { inp ->
          val buf = ByteArray(1 shl 20)
          while (true) { val n = inp.read(buf); if (n < 0) break; out.write(buf, 0, n); written += n }
        }
      }
      if (written != f.length()) throw Exception("copy is incomplete ($written of ${f.length()} bytes)")
      values.clear(); values.put(MediaStore.Downloads.IS_PENDING, 0)
      resolver.update(uri, values, null, null)
    } catch (e: Exception) {
      resolver.delete(uri, null, null) // only the partial copy in Downloads
      throw e
    }
    return "Download/MyoLift/$name"
  }
}
