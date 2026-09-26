package expo.modules.myobluenative

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Build

/** Zoom ratio range of the first front and back camera (Android 11+); min < 1 = wide angle available. */
object CameraZoom {
  fun ranges(ctx: Context): Map<String, List<Double>> {
    val out = HashMap<String, List<Double>>()
    val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as? CameraManager ?: return out
    for (id in cm.cameraIdList) {
      val ch = cm.getCameraCharacteristics(id)
      val facing = when (ch.get(CameraCharacteristics.LENS_FACING)) {
        CameraCharacteristics.LENS_FACING_FRONT -> "front"
        CameraCharacteristics.LENS_FACING_BACK -> "back"
        else -> continue
      }
      if (out.containsKey(facing)) continue
      val r = if (Build.VERSION.SDK_INT >= 30) ch.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE) else null
      out[facing] = if (r != null) listOf(r.lower.toDouble(), r.upper.toDouble()) else listOf(1.0, (ch.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM) ?: 1f).toDouble())
    }
    return out
  }
}
