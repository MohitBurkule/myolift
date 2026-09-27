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
  /** a message from the Huawei watch app (Wear Engine P2P); t on the elapsedRealtime clock */
  onWearMessage: (e: { device: string; data: string; t: number }) => void;
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

export interface WearResult { ok: boolean; error?: string; code?: unknown }

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
  /** Huawei watch (Wear Engine), experimental: all resolve with {ok, ...}, never reject */
  wearAvailable(): WearResult & { health?: string | null; hmsCore?: string | null; sdk?: string };
  wearCheckPermission(): Promise<WearResult & { granted?: boolean }>;
  wearRequestPermission(): Promise<WearResult & { granted?: string[] }>;
  wearDevices(): Promise<WearResult & { devices?: Record<string, unknown>[] }>;
  wearPing(uuid: string, pkg: string, fingerprint: string): Promise<WearResult & { result?: number }>;
  wearSend(uuid: string, pkg: string, fingerprint: string, text: string): Promise<WearResult & { result?: number }>;
  wearListen(uuid: string, pkg: string, fingerprint: string): Promise<WearResult>;
  /** copy a file into Downloads/MyoLift (visible over USB); returns the path shown to the user */
  saveToDownloads(src: string, name: string): Promise<string>;
  /** decode a video into small grayscale frames (upright) in one raw temp file */
  decodeFramesGray(src: string, fps: number, width: number): Promise<{ path: string; width: number; height: number; count: number; t: number[]; rotation: number }>;
  /** zoom ratio [min, max] per facing; min < 1 means a wide-angle lens is available */
  zoomRanges(): { front?: [number, number]; back?: [number, number] };
  canInstallUpdates(): boolean;
  openInstallPermission(): void;
  /** download the APK and hand it to the system installer; false if an update is already running */
  installUpdate(url: string): boolean;
}

/** null when the native module isn't compiled in (e.g. web or Expo Go). */
export default requireOptionalNativeModule<MyoblueNativeModule>("MyoblueNative");
