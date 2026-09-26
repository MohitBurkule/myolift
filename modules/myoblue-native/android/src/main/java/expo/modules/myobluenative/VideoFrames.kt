package expo.modules.myobluenative

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer

/**
 * Decodes a video into small grayscale frames for motion analysis: every frame at about `fps`,
 * scaled to `width` px wide (upright, rotation applied), written back to back into one raw file
 * in the cache folder. Only reads the video; the result is a separate temporary file.
 */
object VideoFrames {
  fun decode(ctx: Context, src: String, fps: Double, width: Int): Map<String, Any> {
    val path = src.removePrefix("file://")
    val ex = MediaExtractor()
    ex.setDataSource(path)
    var track = -1
    var format: MediaFormat? = null
    for (i in 0 until ex.trackCount) {
      val f = ex.getTrackFormat(i)
      if ((f.getString(MediaFormat.KEY_MIME) ?: "").startsWith("video/")) { track = i; format = f; break }
    }
    if (track < 0 || format == null) { ex.release(); throw Exception("no video track") }
    ex.selectTrack(track)
    var rotation = if (format.containsKey("rotation-degrees")) format.getInteger("rotation-degrees") else -1
    if (rotation < 0) {
      val r = MediaMetadataRetriever()
      rotation = try { r.setDataSource(path); r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0 } catch (_: Exception) { 0 } finally { r.release() }
    }
    rotation = ((rotation % 360) + 360) % 360

    val codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
    codec.configure(format, null, null, 0)
    codec.start()
    val out = File(ctx.cacheDir, "vm_${System.currentTimeMillis()}.gray")
    val os = BufferedOutputStream(FileOutputStream(out), 1 shl 16)
    val times = ArrayList<Double>()
    val info = MediaCodec.BufferInfo()
    var inputDone = false
    var t0 = -1L
    var next = 0.0
    val step = 1.0 / fps
    var outW = 0
    var outH = 0
    var frame: ByteArray? = null
    try {
      while (true) {
        if (!inputDone) {
          val ib = codec.dequeueInputBuffer(10000)
          if (ib >= 0) {
            val buf = codec.getInputBuffer(ib)!!
            val n = ex.readSampleData(buf, 0)
            if (n < 0) { codec.queueInputBuffer(ib, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputDone = true }
            else { codec.queueInputBuffer(ib, 0, n, ex.sampleTime, 0); ex.advance() }
          }
        }
        val ob = codec.dequeueOutputBuffer(info, 10000)
        if (ob >= 0) {
          val eos = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
          if (info.size > 0 || !eos) {
            if (t0 < 0) t0 = info.presentationTimeUs
            val t = (info.presentationTimeUs - t0) / 1e6
            if (t + 1e-6 >= next) {
              next = t + step
              val img = codec.getOutputImage(ob)
              val y: Plane? = if (img != null) {
                val p = img.planes[0]
                Plane(p.buffer, p.rowStride, p.pixelStride, img.cropRect.left, img.cropRect.top, img.cropRect.width(), img.cropRect.height())
              } else {
                val of = codec.outputFormat
                val w = of.getInteger(MediaFormat.KEY_WIDTH)
                val h = of.getInteger(MediaFormat.KEY_HEIGHT)
                val stride = if (of.containsKey("stride")) of.getInteger("stride") else w
                val cl = if (of.containsKey("crop-left")) of.getInteger("crop-left") else 0
                val ct = if (of.containsKey("crop-top")) of.getInteger("crop-top") else 0
                val cw = if (of.containsKey("crop-right")) of.getInteger("crop-right") - cl + 1 else w
                val ch = if (of.containsKey("crop-bottom")) of.getInteger("crop-bottom") - ct + 1 else h
                codec.getOutputBuffer(ob)?.let { Plane(it, stride, 1, cl, ct, cw, ch) }
              }
              if (y != null) {
                val rw = if (rotation == 90 || rotation == 270) y.h else y.w
                val rh = if (rotation == 90 || rotation == 270) y.w else y.h
                if (outW == 0) { outW = width; outH = (Math.round(width.toDouble() * rh / rw / 2) * 2).toInt(); frame = ByteArray(outW * outH) }
                scale(y, rotation, rw, rh, outW, outH, frame!!)
                os.write(frame)
                times.add(t)
              }
              img?.close()
            }
          }
          codec.releaseOutputBuffer(ob, false)
          if (eos) break
        }
      }
    } finally {
      try { os.close() } catch (_: Exception) {}
      try { codec.stop() } catch (_: Exception) {}
      codec.release()
      ex.release()
    }
    return mapOf("path" to out.absolutePath, "width" to outW, "height" to outH, "count" to times.size, "t" to times, "rotation" to rotation)
  }

  private class Plane(val buf: ByteBuffer, val rowStride: Int, val pixelStride: Int, val x0: Int, val y0: Int, val w: Int, val h: Int) {
    fun at(x: Int, y: Int): Int = buf.get((y0 + y) * rowStride + (x0 + x) * pixelStride).toInt() and 0xff
  }

  /** Box-ish downscale (3x3 samples per output pixel) of the upright (rotated) Y plane. */
  private fun scale(p: Plane, rot: Int, rw: Int, rh: Int, ow: Int, oh: Int, dst: ByteArray) {
    val fx = rw.toDouble() / ow
    val fy = rh.toDouble() / oh
    for (oy in 0 until oh) for (ox in 0 until ow) {
      var s = 0
      for (j in 0..2) for (i in 0..2) {
        val rx = minOf(rw - 1, ((ox + (i + 0.5) / 3) * fx).toInt())
        val ry = minOf(rh - 1, ((oy + (j + 0.5) / 3) * fy).toInt())
        // upright (rx, ry) -> source pixel
        val v = when (rot) {
          90 -> p.at(ry, p.h - 1 - rx)
          180 -> p.at(p.w - 1 - rx, p.h - 1 - ry)
          270 -> p.at(p.w - 1 - ry, rx)
          else -> p.at(rx, ry)
        }
        s += v
      }
      dst[oy * ow + ox] = (s / 9).toByte()
    }
  }
}
