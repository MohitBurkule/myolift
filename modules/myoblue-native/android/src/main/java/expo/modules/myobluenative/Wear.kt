package expo.modules.myobluenative

import android.app.Activity
import android.content.Context
import com.huawei.wearengine.HiWear
import com.huawei.wearengine.auth.AuthCallback
import com.huawei.wearengine.auth.Permission
import com.huawei.wearengine.device.Device
import com.huawei.wearengine.p2p.Message
import com.huawei.wearengine.p2p.P2pClient
import com.huawei.wearengine.p2p.PingCallback
import com.huawei.wearengine.p2p.Receiver
import com.huawei.wearengine.p2p.SendCallback
import expo.modules.kotlin.Promise

/**
 * Huawei Wear Engine bridge (experimental). Every call resolves with {ok, ...} or {ok:false, error},
 * never rejects: the exact error text/code is the useful diagnostic (e.g. missing Huawei Health,
 * unauthorised scope, unregistered app id).
 */
object Wear {
  var listener: ((device: String, data: String, t: Double) -> Unit)? = null
  private val devices = HashMap<String, Device>()
  private val receivers = HashMap<String, Receiver>()

  private fun err(e: Throwable?): Map<String, Any?> =
    mapOf("ok" to false, "error" to (e?.javaClass?.name + ": " + (e?.message ?: "")), "code" to codeOf(e))

  private fun codeOf(e: Throwable?): Any? = try {
    e?.javaClass?.methods?.firstOrNull { it.name == "getErrorCode" && it.parameterTypes.isEmpty() }?.invoke(e)
  } catch (_: Exception) { null }

  private fun installed(ctx: Context, pkg: String): String? = try {
    val info = ctx.packageManager.getPackageInfo(pkg, 0)
    info.versionName ?: "installed"
  } catch (_: Exception) { null }

  fun available(ctx: Context): Map<String, Any?> = mapOf(
    "ok" to true,
    "health" to installed(ctx, "com.huawei.health"),
    "hmsCore" to installed(ctx, "com.huawei.hwid"),
    "sdk" to "com.huawei.hms:wearengine:5.0.3.300",
  )

  fun checkPermission(ctx: Context, promise: Promise) {
    try {
      HiWear.getAuthClient(ctx).checkPermission(Permission.DEVICE_MANAGER)
        .addOnSuccessListener { granted -> promise.resolve(mapOf("ok" to true, "granted" to granted)) }
        .addOnFailureListener { e -> promise.resolve(err(e)) }
    } catch (e: Throwable) { promise.resolve(err(e)) }
  }

  fun requestPermission(ctx: Context, activity: Activity?, promise: Promise) {
    try {
      var done = false
      val cb = object : AuthCallback {
        override fun onOk(permissions: Array<out Permission>?) {
          if (done) return; done = true
          promise.resolve(mapOf("ok" to true, "granted" to (permissions?.map { it.name } ?: emptyList<String>())))
        }
        override fun onCancel() {
          if (done) return; done = true
          promise.resolve(mapOf("ok" to false, "error" to "cancelled by user (or the Huawei Health authorisation page did not open)"))
        }
      }
      HiWear.getAuthClient(activity ?: ctx).requestPermission(cb, Permission.DEVICE_MANAGER)
        .addOnFailureListener { e -> if (!done) { done = true; promise.resolve(err(e)) } }
    } catch (e: Throwable) { promise.resolve(err(e)) }
  }

  /** All no-arg getters of the SDK's Device, so the report shows whatever the SDK knows (model, product type…). */
  private fun describe(d: Device): Map<String, Any?> {
    val out = LinkedHashMap<String, Any?>()
    for (m in d.javaClass.methods) {
      if (m.parameterTypes.isNotEmpty() || m.declaringClass == Any::class.java) continue
      val n = m.name
      if (!(n.startsWith("get") || n.startsWith("is")) || n == "getClass") continue
      try {
        val v = m.invoke(d)
        out[n] = when (v) { null, is String, is Number, is Boolean -> v; else -> v.toString() }
      } catch (_: Exception) {}
    }
    return out
  }

  fun bondedDevices(ctx: Context, promise: Promise) {
    try {
      HiWear.getDeviceClient(ctx).bondedDevices
        .addOnSuccessListener { list ->
          val arr = (list ?: emptyList()).map { d -> devices[d.uuid] = d; describe(d) }
          promise.resolve(mapOf("ok" to true, "devices" to arr))
        }
        .addOnFailureListener { e -> promise.resolve(err(e)) }
    } catch (e: Throwable) { promise.resolve(err(e)) }
  }

  private fun p2p(ctx: Context, pkg: String, fingerprint: String): P2pClient {
    val c = HiWear.getP2pClient(ctx)
    c.setPeerPkgName(pkg)
    if (fingerprint.isNotBlank()) c.setPeerFingerPrint(fingerprint)
    return c
  }

  fun ping(ctx: Context, uuid: String, pkg: String, fingerprint: String, promise: Promise) {
    val d = devices[uuid] ?: return promise.resolve(mapOf("ok" to false, "error" to "device not listed; tap Find devices first"))
    try {
      var done = false
      p2p(ctx, pkg, fingerprint).ping(d, object : PingCallback {
        override fun onPingResult(result: Int) {
          if (done) return; done = true
          promise.resolve(mapOf("ok" to true, "result" to result))
        }
      }).addOnFailureListener { e -> if (!done) { done = true; promise.resolve(err(e)) } }
    } catch (e: Throwable) { promise.resolve(err(e)) }
  }

  fun send(ctx: Context, uuid: String, pkg: String, fingerprint: String, text: String, promise: Promise) {
    val d = devices[uuid] ?: return promise.resolve(mapOf("ok" to false, "error" to "device not listed; tap Find devices first"))
    try {
      val msg = Message.Builder().setPayload(text.toByteArray(Charsets.UTF_8)).build()
      var done = false
      p2p(ctx, pkg, fingerprint).send(d, msg, object : SendCallback {
        override fun onSendResult(resultCode: Int) {
          if (done) return; done = true
          promise.resolve(mapOf("ok" to true, "result" to resultCode))
        }
        override fun onSendProgress(progress: Long) {}
      }).addOnFailureListener { e -> if (!done) { done = true; promise.resolve(err(e)) } }
    } catch (e: Throwable) { promise.resolve(err(e)) }
  }

  /** Listen for messages from the watch app; each arrives as onWearMessage with the phone's native clock. */
  fun listen(ctx: Context, uuid: String, pkg: String, fingerprint: String, promise: Promise) {
    val d = devices[uuid] ?: return promise.resolve(mapOf("ok" to false, "error" to "device not listed; tap Find devices first"))
    try {
      val r = receivers[uuid] ?: object : Receiver {
        override fun onReceiveMessage(message: Message?) {
          val data = message?.data?.let { String(it, Charsets.UTF_8) } ?: return
          listener?.invoke(uuid, data, MyoBle.now())
        }
      }.also { receivers[uuid] = it }
      p2p(ctx, pkg, fingerprint).registerReceiver(d, r)
        .addOnSuccessListener { promise.resolve(mapOf("ok" to true)) }
        .addOnFailureListener { e -> promise.resolve(err(e)) }
    } catch (e: Throwable) { promise.resolve(err(e)) }
  }
}
