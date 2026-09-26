import { NativeModule, requireOptionalNativeModule } from "expo";

export type SensorState = "connecting" | "discovering" | "live" | "reconnecting" | "disconnected" | "failed";

export type MyoblueEvents = {
  onDevice: (e: { id: string; name: string; rssi: number }) => void;
  onSensorState: (e: { id: string; name: string; state: SensorState }) => void;
  /** data: base64 of the 244-byte packet; t: ms on the elapsedRealtime clock */
  onPacket: (e: { id: string; data: string; t: number }) => void;
  onMarker: (e: { t: number; label: string }) => void;
  onRecording: (e: { active: boolean }) => void;
  /** self-update progress: download 0..1, install, confirm (system prompt shown), done, error */
  onUpdate: (e: { phase: "download" | "install" | "confirm" | "done" | "error"; progress: number; message: string | null }) => void;
};

export interface RecordingStatus {
  path: string;
  elapsedMs: number;
  startedAt: number;
  packets: number;
  sensors: number;
  markers: number;
}

declare class MyoblueNativeModule extends NativeModule<MyoblueEvents> {
  isBluetoothOn(): boolean;
  startScan(): boolean;
  stopScan(): void;
  connect(id: string, name: string): void;
  disconnect(id: string): void;
  sensors(): { id: string; name: string; state: SensorState; packets: number }[];
  now(): number;
  injectPacket(id: string, name: string, base64: string): void;
  startRecording(path: string, title: string): boolean;
  stopRecording(): { path: string; durationMs: number; packets: number } | null;
  addMarker(label: string): number;
  recordingStatus(): RecordingStatus | null;
  ignoringBatteryOptimizations(): boolean;
  openBatterySettings(): void;
  appVersionCode(): number;
  /** copy a file into Downloads/MyoLift (visible over USB); returns the path shown to the user */
  saveToDownloads(src: string, name: string): Promise<string>;
  canInstallUpdates(): boolean;
  openInstallPermission(): void;
  /** download the APK and hand it to the system installer; false if an update is already running */
  installUpdate(url: string): boolean;
}

/** null when the native module isn't compiled in (e.g. web or Expo Go). */
export default requireOptionalNativeModule<MyoblueNativeModule>("MyoblueNative");
