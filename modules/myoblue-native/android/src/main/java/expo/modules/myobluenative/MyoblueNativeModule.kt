package expo.modules.myobluenative

import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** JS bridge for MyoBle (Bluetooth + recording). Packets are sent to JS base64-encoded. */
class MyoblueNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MyoblueNative")

    Events("onDevice", "onSensorState", "onPacket", "onMarker", "onRecording", "onUpdate", "onWearMessage")

    OnCreate {
      val context = appContext.reactContext ?: return@OnCreate
      MyoBle.init(context)
      MyoBle.listener = object : MyoBle.Listener {
        override fun onDevice(id: String, name: String, rssi: Int) =
          sendEvent("onDevice", mapOf("id" to id, "name" to name, "rssi" to rssi))
        override fun onSensorState(id: String, name: String, state: String) =
          sendEvent("onSensorState", mapOf("id" to id, "name" to name, "state" to state))
        override fun onPacket(id: String, data: ByteArray, t: Double) =
          sendEvent("onPacket", mapOf("id" to id, "data" to Base64.encodeToString(data, Base64.NO_WRAP), "t" to t))
        override fun onMarker(t: Double, label: String) =
          sendEvent("onMarker", mapOf("t" to t, "label" to label))
        override fun onRecording(active: Boolean) =
          sendEvent("onRecording", mapOf("active" to active))
      }
      Wear.listener = { device, data, t ->
        sendEvent("onWearMessage", mapOf("device" to device, "data" to data, "t" to t))
      }
      Updater.listener = { phase, progress, message ->
        sendEvent("onUpdate", mapOf("phase" to phase, "progress" to progress, "message" to message))
      }
    }

    OnDestroy { MyoBle.listener = null; Updater.listener = null; Wear.listener = null }

    Function("isBluetoothOn") { MyoBle.isEnabled() }
    Function("startScan") { MyoBle.startScan() }
    Function("stopScan") { MyoBle.stopScan() }
    Function("connect") { id: String, name: String -> MyoBle.connect(id, name) }
    Function("disconnect") { id: String -> MyoBle.disconnect(id) }
    Function("sensors") { MyoBle.sensors() }
    Function("now") { MyoBle.now() }
    Function("injectPacket") { id: String, name: String, data: String ->
      MyoBle.inject(id, name, Base64.decode(data, Base64.NO_WRAP))
    }

    Function("startRecording") { path: String, title: String -> MyoBle.Recorder.start(path, title) }
    Function("stopRecording") { MyoBle.Recorder.stop() }
    Function("addMarker") { label: String -> MyoBle.Recorder.marker(label) }
    Function("recordingStatus") { MyoBle.Recorder.status() }

    Function("ignoringBatteryOptimizations") {
      val context = appContext.reactContext ?: return@Function true
      MyoBle.ignoringBatteryOptimizations(context)
    }
    Function("appVersionCode") {
      val context = appContext.reactContext ?: return@Function 0.0
      Updater.versionCode(context).toDouble()
    }
    Function("canInstallUpdates") {
      val context = appContext.reactContext ?: return@Function false
      Updater.canInstall(context)
    }
    Function("openInstallPermission") {
      val context = appContext.reactContext
      if (context != null) Updater.openInstallPermission(context)
    }
    // Huawei watch (Wear Engine), experimental. All of these resolve with {ok, ...}; they never reject.
    Function("wearAvailable") {
      val context = appContext.reactContext ?: return@Function mapOf("ok" to false, "error" to "no context")
      Wear.available(context)
    }
    AsyncFunction("wearCheckPermission") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) promise.resolve(mapOf("ok" to false, "error" to "no context")) else Wear.checkPermission(context, promise)
    }
    AsyncFunction("wearRequestPermission") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) promise.resolve(mapOf("ok" to false, "error" to "no context")) else Wear.requestPermission(context, appContext.currentActivity, promise)
    }
    AsyncFunction("wearDevices") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) promise.resolve(mapOf("ok" to false, "error" to "no context")) else Wear.bondedDevices(context, promise)
    }
    AsyncFunction("wearPing") { uuid: String, pkg: String, fingerprint: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) promise.resolve(mapOf("ok" to false, "error" to "no context")) else Wear.ping(context, uuid, pkg, fingerprint, promise)
    }
    AsyncFunction("wearSend") { uuid: String, pkg: String, fingerprint: String, text: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) promise.resolve(mapOf("ok" to false, "error" to "no context")) else Wear.send(context, uuid, pkg, fingerprint, text, promise)
    }
    AsyncFunction("wearListen") { uuid: String, pkg: String, fingerprint: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) promise.resolve(mapOf("ok" to false, "error" to "no context")) else Wear.listen(context, uuid, pkg, fingerprint, promise)
    }

    Function("installUpdate") { url: String ->
      val context = appContext.reactContext ?: return@Function false
      Updater.install(context, url)
    }

    AsyncFunction("decodeFramesGray") { src: String, fps: Double, width: Int ->
      val context = appContext.reactContext ?: throw Exception("no context")
      VideoFrames.decode(context, src, fps, width)
    }

    Function("zoomRanges") {
      val context = appContext.reactContext ?: return@Function emptyMap<String, List<Double>>()
      CameraZoom.ranges(context)
    }

    AsyncFunction("saveToDownloads") { src: String, name: String ->
      val context = appContext.reactContext ?: throw Exception("no context")
      Downloads.save(context, src, name)
    }

    Function("openBatterySettings") {
      val context = appContext.reactContext
      if (context != null) MyoBle.openBatterySettings(context)
    }
  }
}
