import React, { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { CameraView, useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import Native from "../../modules/myoblue-native";
import { Button } from "./ui";
import { getSettings, updateSettings, useSettings } from "../lib/settings";

/** Zoom range per facing as the phone reports it (min < 1 = a wider lens exists). */
let ranges: { front?: [number, number]; back?: [number, number] } | null = null;
const zoomRange = (f: "front" | "back") => { try { ranges ??= Native?.zoomRanges() ?? {}; } catch { ranges = {}; } return ranges[f] ?? null; };

export interface SyncedCameraHandle {
  ready: () => boolean;
  /** Start recording now. startNative: phone clock (ms) when recording was asked to start. */
  record: () => { startNative: number; done: Promise<string | null> } | null;
  stop: () => void;
}

/**
 * Camera preview that records video (with sound when `audio`) on the same phone clock as the EMG
 * recorder, so the two line up. Used by experiments and by the workout camera.
 */
export const SyncedCamera = forwardRef<SyncedCameraHandle, {
  facing: "front" | "back"; onFacing?: (f: "front" | "back") => void; audio: boolean; height?: number; locked?: boolean; overlay?: React.ReactNode;
}>(function SyncedCamera({ facing, onFacing, audio, height = 300, locked, overlay }, ref) {
  const [perm, requestPerm] = useCameraPermissions();
  const [mic, requestMic] = useMicrophonePermissions();
  const cam = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const withSound = audio && !!mic?.granted;
  const s = useSettings();
  const range = zoomRange(facing);
  const canWide = !!range && range[0] < 0.99;
  const wide = canWide && !!s.cameraWide?.[facing];
  const setWide = (v: boolean) => updateSettings({ cameraWide: { ...(getSettings().cameraWide ?? {}), [facing]: v } });
  useImperativeHandle(ref, () => ({
    ready: () => ready && !!cam.current,
    record: () => {
      if (!cam.current || !ready) return null;
      const startNative = Native?.now() ?? Date.now();
      const done = cam.current.recordAsync().then((v) => v?.uri ?? null).catch(() => null);
      return { startNative, done };
    },
    stop: () => cam.current?.stopRecording(),
  }), [ready]);
  if (!perm?.granted) return <Button title="Allow camera" onPress={requestPerm} />;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ height, borderRadius: 12, overflow: "hidden", backgroundColor: "#000" }}>
        {/* zoom < 0 = below 1x toward the widest lens (patched expo-camera, see scripts/patch-expo-camera.js) */}
        <CameraView ref={cam} style={{ flex: 1 }} facing={facing} mode="video" mute={!withSound} videoQuality="720p" zoom={wide ? -1 : 0} onCameraReady={() => setReady(true)} />
        {overlay}
        {!locked && onFacing ? (
          <Pressable onPress={() => onFacing(facing === "back" ? "front" : "back")} accessibilityRole="button" accessibilityLabel="Switch camera"
            style={{ position: "absolute", right: 10, bottom: 10, backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 }}>
            <Text style={{ color: "#fff", fontWeight: "600" }}>Switch camera</Text>
          </Pressable>
        ) : null}
      </View>
      {!locked ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Button small title={wide ? `Wide ${range![0].toFixed(1)}× ✓` : canWide ? `Wide (${range![0].toFixed(1)}×)` : "Wide: not available"} disabled={!canWide} onPress={() => setWide(!wide)} />
          <Text style={{ color: "#888", fontSize: 12, flex: 1 }}>{range ? `${facing} camera zoom ${range[0].toFixed(2)}–${range[1].toFixed(0)}×` : ""}</Text>
        </View>
      ) : null}
      {audio && !mic?.granted && !locked ? <Button small title="Allow microphone (voice notes)" onPress={requestMic} /> : null}
    </View>
  );
});
