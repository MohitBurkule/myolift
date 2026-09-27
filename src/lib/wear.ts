/**
 * Huawei watch bridge (experimental, Wear Engine): diagnostics for the setup steps, and watch data
 * recorded into the current experiment/workout as watch.jsonl. Nothing here touches recordings
 * except appending to watch.jsonl.
 */
import { useSyncExternalStore } from "react";
import { Directory, File, Paths } from "expo-file-system";
import Native from "../../modules/myoblue-native";
import { activeExperiment } from "./experiments";
import { activeWorkoutId, workoutsDir } from "./workout";

export interface WearConfig { watchPkg: string; watchFingerprint: string; deviceUuid: string }
export interface WearStep { at: string; step: string; result: unknown }
interface State { config: WearConfig; log: WearStep[]; received: number; lastMessage: string | null; listening: boolean }

const DEFAULT: WearConfig = { watchPkg: "com.mohitburkule.myoliftwatch", watchFingerprint: "", deviceUuid: "" };
const cfgFile = () => new File(Paths.document, "wear.json");
export const diagnosticsFile = () => new File(Paths.document, "wear-diagnostics.json");

function load(): WearConfig {
  try { return { ...DEFAULT, ...JSON.parse(cfgFile().textSync()) }; } catch { return DEFAULT; }
}
let state: State = { config: load(), log: [], received: 0, lastMessage: null, listening: false };
try { state.log = JSON.parse(diagnosticsFile().textSync()).log ?? []; } catch {}
const subs = new Set<() => void>();
const set = (p: Partial<State>) => { state = { ...state, ...p }; subs.forEach((f) => f()); };
export const useWear = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => state);

export function setWearConfig(p: Partial<WearConfig>) {
  const config = { ...state.config, ...p };
  try { const f = cfgFile(); if (!f.exists) f.create(); f.write(JSON.stringify(config, null, 2)); } catch {}
  set({ config });
}

function record(step: string, result: unknown) {
  const log = [...state.log, { at: new Date().toISOString(), step, result }].slice(-200);
  try { const f = diagnosticsFile(); if (!f.exists) f.create(); f.write(JSON.stringify({ config: state.config, log }, null, 2)); } catch {}
  set({ log });
  return result;
}

const call = async <T,>(step: string, fn: () => Promise<T> | T): Promise<T | { ok: false; error: string }> => {
  if (!Native) return record(step, { ok: false, error: "needs the Android app" }) as any;
  try { return record(step, await fn()) as T; } catch (e: any) { return record(step, { ok: false, error: String(e?.message ?? e) }) as any; }
};

export const wearAvailable = () => call("available", () => Native!.wearAvailable());
export const wearCheck = () => call("check permission", () => Native!.wearCheckPermission());
export const wearRequest = () => call("request permission", () => Native!.wearRequestPermission());
export const wearDevices = () => call("find devices", () => Native!.wearDevices());
export const wearPing = () => call("ping watch app", () => Native!.wearPing(state.config.deviceUuid, state.config.watchPkg, state.config.watchFingerprint));
export const wearSendTest = () => call("send test message", () => Native!.wearSend(state.config.deviceUuid, state.config.watchPkg, state.config.watchFingerprint, JSON.stringify({ type: "hello", t: Date.now() })));
/** Tell the watch app to start or stop streaming (it also has its own Start button). */
export const wearCommand = (type: "start" | "stop") =>
  call(`watch ${type}`, () => Native!.wearSend(state.config.deviceUuid, state.config.watchPkg, state.config.watchFingerprint, JSON.stringify({ type, t: Date.now() })));

export async function wearListen() {
  const r: any = await call("listen for watch data", () => Native!.wearListen(state.config.deviceUuid, state.config.watchPkg, state.config.watchFingerprint));
  if (r?.ok) set({ listening: true });
  return r;
}

export function diagnosticsText(): string {
  return JSON.stringify({ app: "MyoLift", config: state.config, received: state.received, log: state.log }, null, 2);
}

/** Folder of whatever is recording now (experiment first, then workout), or null. */
function recordingDir(): Directory | null {
  const e = activeExperiment();
  if (e) return e.dir;
  const w = activeWorkoutId();
  return w ? new Directory(workoutsDir(), w) : null;
}

/** Append one watch message to watch.jsonl: t_native (ms, phone clock), t_rec (s since the EMG recording's t = 0). */
export function onWatchMessage(e: { device: string; data: string; t: number }) {
  set({ received: state.received + 1, lastMessage: e.data.slice(0, 200) });
  const dir = recordingDir();
  if (!dir || !Native) return;
  const st = Native.recordingStatus();
  const origin = st ? Native.now() - st.elapsedMs : null;
  let data: unknown = e.data;
  try { data = JSON.parse(e.data); } catch {}
  const line = JSON.stringify({ t_native: e.t, t_rec: origin !== null ? Math.round(e.t - origin) / 1000 : null, wall: new Date().toISOString(), device: e.device, data }) + "\n";
  try { const f = new File(dir, "watch.jsonl"); if (!f.exists) f.create(); f.write(line, { append: true }); } catch {}
}

export function initWear() {
  Native?.addListener("onWearMessage", onWatchMessage);
}
