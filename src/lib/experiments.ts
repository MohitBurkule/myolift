/**
 * Experiments: short recordings of EMG from all connected sensors plus (optionally) video,
 * started together on the same clock, with a preset, free notes and time-stamped marks.
 * Stored like workouts (same raw .bin format) under experiments/<id>/.
 */
import { useSyncExternalStore } from "react";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import Native from "../../modules/myoblue-native";
import { ZipWriter } from "../core/zip";
import { getSettings } from "./settings";
import { activeWorkoutId, APP_VERSION, listWorkouts } from "./workout";

export interface Preset { id: string; title: string; text: string }
export const PRESETS: Preset[] = [
  { id: "hold_lockout_relaxed", title: "Hold at lockout, relaxed", text: "Arm straight at the bottom, let the joint take the weight, as little effort as possible." },
  { id: "push_lockout", title: "Push into lockout", text: "Arm straight at the bottom, push down as hard as you can without moving." },
  { id: "hold_mid", title: "Hold at mid-range", text: "Stop halfway (elbow about 90°) and hold the weight still." },
  { id: "push_mid", title: "Push hard at mid-range", text: "Halfway, push much harder than the weight needs (pin a heavy weight or have someone hold the rope)." },
  { id: "hold_stretch", title: "Hold at the stretch", text: "Elbow fully bent at the top, triceps stretched, hold the weight still." },
  { id: "stretch_passive", title: "Stretch, no load", text: "Stretch the triceps (e.g. hand behind the head) and relax into it." },
  { id: "flex_no_load", title: "Flex without load", text: "No weight: tense the triceps as hard as you can, at different angles." },
  { id: "reps_normal", title: "Normal reps", text: "A few reps at your usual tempo, full range." },
  { id: "reps_slow_ecc", title: "Slow eccentric reps", text: "Push down normally, take 4–5 s on the way up." },
  { id: "reps_partial_top", title: "Partials: bottom half", text: "From lockout, go only halfway up and back down." },
  { id: "reps_partial_bottom", title: "Partials: top half", text: "From the stretch, go only halfway down and back up." },
  { id: "free", title: "Free", text: "Anything else. Describe it in the notes." },
];
/** The guided sequence: each step 30 s with a countdown, rests between, all in one recording with automatic marks. */
export const PROTOCOL: { preset: string; seconds: number; rest: number }[] = [
  { preset: "hold_lockout_relaxed", seconds: 20, rest: 20 },
  { preset: "push_lockout", seconds: 15, rest: 30 },
  { preset: "hold_mid", seconds: 20, rest: 30 },
  { preset: "push_mid", seconds: 15, rest: 30 },
  { preset: "hold_stretch", seconds: 20, rest: 30 },
  { preset: "stretch_passive", seconds: 20, rest: 15 },
  { preset: "flex_no_load", seconds: 15, rest: 30 },
  { preset: "reps_normal", seconds: 30, rest: 45 },
  { preset: "reps_slow_ecc", seconds: 40, rest: 45 },
  { preset: "reps_partial_top", seconds: 30, rest: 45 },
  { preset: "reps_partial_bottom", seconds: 30, rest: 0 },
];
export const PROTOCOL_PRESET: Preset = { id: "protocol", title: "Guided protocol", text: "All the tests in one recording, with countdowns and rests." };

export const FEEL = ["fresh", "warmed up", "pumped", "fatigued", "sore"] as const;

export interface Mark { t: number; label: string } // s since the experiment started
export interface ExperimentMeta {
  id: string;
  preset: string;
  title: string;
  notes: string;
  feel: string;
  marks: Mark[];
  startedAt: string; // wall clock ISO
  endedAt?: string;
  durationS?: number;
  /** native clock (ms, elapsedRealtime) at t = 0 of the EMG rows */
  originNative: number;
  /** video: native clock when recording was asked to start / when it stopped; offset = videoStart - origin */
  video?: { file: string; startNative: number; stopNative?: number; offsetS: number; facing: "front" | "back" };
  /** context: how worked the muscle already was */
  context: { minutesSinceLastWorkout: number | null; lastWorkoutName: string | null; minutesSincePrevExperiment: number | null; experimentsToday: number };
  exercise: { id: string; name: string } | null;
  weight: number | null;
  unit: string;
  placements: unknown;
  calibrations: unknown;
  app: string;
}

export function experimentsDir(): Directory {
  const d = new Directory(Paths.document, "experiments");
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

const subs = new Set<() => void>();
let version = 0;
const bump = () => { version++; subs.forEach((f) => f()); };
export const useExperimentsVersion = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => version);

let active: { meta: ExperimentMeta; dir: Directory } | null = null;
export const activeExperiment = () => active;

function save(meta: ExperimentMeta, dir: Directory) {
  const f = new File(dir, "experiment.json");
  if (!f.exists) f.create();
  f.write(JSON.stringify(meta, null, 2));
}

export function listExperiments(): ExperimentMeta[] {
  const out: ExperimentMeta[] = [];
  for (const d of experimentsDir().list()) {
    if (!(d instanceof Directory)) continue;
    try { out.push(JSON.parse(new File(d, "experiment.json").textSync())); } catch {}
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function loadExperiment(id: string): ExperimentMeta | null {
  try { return JSON.parse(new File(new Directory(experimentsDir(), id), "experiment.json").textSync()); } catch { return null; }
}

export function updateExperiment(id: string, patch: Partial<ExperimentMeta>) {
  if (active?.meta.id === id) { active.meta = { ...active.meta, ...patch }; save(active.meta, active.dir); bump(); return; }
  const m = loadExperiment(id);
  if (!m) return;
  save({ ...m, ...patch }, new Directory(experimentsDir(), id));
  bump();
}

function context(now: Date): ExperimentMeta["context"] {
  const mins = (iso?: string) => (iso ? Math.round((now.getTime() - new Date(iso).getTime()) / 60000) : null);
  const w = listWorkouts().map((x) => x.meta).filter((x) => x.endedAt).sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""))[0];
  const ex = listExperiments();
  const today = now.toDateString();
  return {
    minutesSinceLastWorkout: mins(w?.endedAt), lastWorkoutName: w?.name ?? null,
    minutesSincePrevExperiment: mins(ex[0]?.endedAt ?? ex[0]?.startedAt),
    experimentsToday: ex.filter((e) => new Date(e.startedAt).toDateString() === today).length,
  };
}

/** Start EMG recording (all connected sensors). The video, if any, is started right after by the screen. */
export function startExperiment(preset: Preset, notes: string, feel: string, weight: number | null = getSettings().weight ?? null): ExperimentMeta | string {
  if (!Native) return "Recording needs the Android app.";
  if (activeWorkoutId()) return "A workout is recording. End it first (both use the same recorder).";
  if (active) return "An experiment is already recording.";
  const started = new Date();
  const id = started.toISOString().replace(/[:.]/g, "-");
  const dir = new Directory(experimentsDir(), id);
  dir.create({ intermediates: true, idempotent: true });
  const s = getSettings();
  const meta: ExperimentMeta = {
    id, preset: preset.id, title: preset.title, notes, feel, marks: [], startedAt: started.toISOString(), originNative: 0,
    context: context(started), exercise: s.exercise ?? null, weight, unit: s.unit,
    placements: s.placements, calibrations: s.refs, app: APP_VERSION,
  };
  if (!Native.startRecording(dir.uri, `Experiment: ${preset.title}`)) return "Couldn't start the recorder.";
  const st = Native.recordingStatus();
  meta.originNative = Native.now() - (st?.elapsedMs ?? 0);
  active = { meta, dir };
  save(meta, dir);
  bump();
  return meta;
}

export const nowS = () => (active && Native ? (Native.now() - active.meta.originNative) / 1000 : 0);

export function markExperiment(label: string): Mark | null {
  if (!active || !Native) return null;
  const m = { t: Math.round(nowS() * 1000) / 1000, label };
  Native.addMarker(label);
  active.meta.marks = [...active.meta.marks, m];
  save(active.meta, active.dir);
  bump();
  return m;
}

export function videoFile(id: string, name = "video.mp4") { return new File(new Directory(experimentsDir(), id), name); }

export function videoStarted(facing: "front" | "back") {
  if (!active || !Native) return;
  const t = Native.now();
  active.meta.video = { file: "video.mp4", startNative: t, offsetS: (t - active.meta.originNative) / 1000, facing };
  save(active.meta, active.dir);
}

/** Move the camera's temporary file into the experiment folder. */
export function videoSaved(id: string, tmpUri: string, stopNative: number) {
  const m = active?.meta.id === id ? active.meta : loadExperiment(id);
  if (!m?.video) return;
  try { new File(tmpUri).move(videoFile(id)); } catch { try { new File(tmpUri).copy(videoFile(id)); } catch {} }
  updateExperiment(id, { video: { ...m.video, stopNative } });
}

export function stopExperiment(): ExperimentMeta | null {
  if (!active || !Native) return null;
  Native.stopRecording();
  const m = { ...active.meta, endedAt: new Date().toISOString(), durationS: nowS() };
  save(m, active.dir);
  active = null;
  bump();
  return m;
}

// stopped from the notification: close the experiment too
Native?.addListener("onRecording", (e) => { if (!e.active && active) stopExperiment(); });

export function deleteExperiment(id: string) {
  const d = new Directory(experimentsDir(), id);
  if (d.exists) d.delete();
  bump();
}

const README = `MyoLift experiments export

experiments/<id>/
  experiment.json  preset, notes, feel, marks [{t: s since start, label}], wall-clock start/end,
                   originNative (ms, phone elapsedRealtime at EMG t = 0),
                   video.startNative / stopNative / offsetS (video t = 0 is ~offsetS after EMG t = 0;
                   refine with the sync flex at the start), context (minutes since last workout etc.)
  <sensor>.bin     raw EMG, same 252-byte rows as workouts (float64 ms since start + 244-byte packet)
  sensors.json     sensor id -> name -> file
  markers.jsonl    the marks as written by the recorder (same clock as the .bin rows)
  video.mp4        the camera recording (no audio)
settings.json      calibrations and placements at export time
`;

export async function exportExperiments(ids: string[], progress?: (m: string) => void, mode: "share" | "save" = "share"): Promise<string> {
  const out = new File(Paths.cache, `myolift_experiments_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.zip`);
  if (out.exists) out.delete();
  out.create();
  const z = new ZipWriter((c) => out.write(c, { append: true }));
  z.add("README.txt", new TextEncoder().encode(README));
  z.add("settings.json", new TextEncoder().encode(JSON.stringify({ ...getSettings(), placementPhotos: undefined, app: APP_VERSION }, null, 2)));
  z.add("measurements.json", require("./measurements").measurementsJson());
  let i = 0;
  for (const id of ids) {
    progress?.(`Packing ${++i}/${ids.length}…`);
    const dir = new Directory(experimentsDir(), id);
    if (!dir.exists) continue;
    for (const item of dir.list()) {
      if (!(item instanceof File)) continue;
      if (item.name.endsWith(".mp4")) {
        const h = item.open(FileMode.ReadOnly);
        z.addChunked(`experiments/${id}/${item.name}`, () => { const c = h.readBytes(1 << 20); return c.length ? c : null; });
        h.close();
      } else z.add(`experiments/${id}/${item.name}`, await item.bytes());
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  z.finish();
  if (mode === "save") return await Native!.saveToDownloads(out.uri, out.name);
  if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing isn't available on this device");
  await Sharing.shareAsync(out.uri, { mimeType: "application/zip", dialogTitle: out.name });
  return "shared";
}
