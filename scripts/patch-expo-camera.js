#!/usr/bin/env node
/**
 * expo-camera (Android) clamps zoom to >= 1x, so the phone's wider lens (e.g. 0.5x ultrawide) is
 * unreachable. This patch lets zoom < 0 zoom out toward the camera's minimum zoom ratio
 * (-1 = widest), and re-applies the zoom once the camera is open (zoom state is known then).
 * Run in CI before `expo prebuild` (not as postinstall: node_modules may be shared locally).
 * Idempotent; fails loudly if expo-camera changed so the patch no longer applies.
 */
const fs = require("fs");
const path = require("path");
const f = path.join(__dirname, "..", "node_modules", "expo-camera", "android", "src", "main", "java", "expo", "modules", "camera", "ExpoCameraView.kt");
let s = fs.readFileSync(f, "utf8");
if (s.includes("MyoLift patch")) { console.log("expo-camera already patched"); process.exit(0); }
const zoomOld = `    val maxZoomRatio = camera?.cameraInfo?.zoomState?.value?.maxZoomRatio ?: 1f
    val targetZoomRatio = max(1f, min(maxZoomRatio, value.coerceIn(0f, 1f) * maxZoomRatio))`;
const zoomNew = `    val zs = camera?.cameraInfo?.zoomState?.value
    val maxZoomRatio = zs?.maxZoomRatio ?: 1f
    val minZoomRatio = zs?.minZoomRatio ?: 1f
    // MyoLift patch: value < 0 zooms out below 1x toward the widest lens (-1 = minimum ratio)
    val targetZoomRatio = if (value < 0f) max(minZoomRatio, 1f + value.coerceAtLeast(-1f) * (1f - minZoomRatio))
      else max(1f, min(maxZoomRatio, value.coerceIn(0f, 1f) * maxZoomRatio))`;
const openOld = `        CameraState.Type.OPEN -> {
          onCameraReady(Unit)`;
const openNew = `        CameraState.Type.OPEN -> {
          onCameraReady(Unit)
          setCameraZoom(zoom) // MyoLift patch: zoom state is known now`;
for (const [a, b] of [[zoomOld, zoomNew], [openOld, openNew]]) {
  if (!s.includes(a)) { console.error("patch-expo-camera: expected code not found in " + f); process.exit(1); }
  s = s.replace(a, b);
}
fs.writeFileSync(f, s);
console.log("patched " + f);
