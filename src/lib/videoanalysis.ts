/**
 * Video rep counting on the phone: decode the recorded video into small grayscale frames
 * (native, into a temporary cache file), run the motion analysis (src/core/videomotion.ts),
 * save the result next to the recording. The video file itself is only read.
 */
import { useSyncExternalStore } from "react";
import { Directory, File } from "expo-file-system";
import Native from "../../modules/myoblue-native";
import { envelopeBins, fitClock } from "../core/offline";
import { activeFromEnvelope, analyseMotion, motionModeFor, type MotionMode, type VideoMotionResult } from "../core/videomotion";
import { experimentsDir, loadExperiment, updateExperiment, type ExperimentMeta } from "./experiments";
import { workoutsDir } from "./workout";

export const VM_FPS = 10;
export const VM_WIDTH = 160;

/* progress for the UI: one analysis at a time */
let busy: { key: string; progress: number; stage: string } | null = null;
const subs = new Set<() => void>();
const setBusy = (b: typeof busy) => { busy = b; subs.forEach((f) => f()); };
export const useVideoAnalysis = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => busy);

const readJson = <T,>(f: File, fallback: T): T => { try { return f.exists ? JSON.parse(f.textSync()) : fallback; } catch { return fallback; } };
const writeJson = (f: File, v: unknown) => { if (!f.exists) f.create(); f.write(JSON.stringify(v)); };

/** Decode + analyse one video. `active` (optional) maps frame times (s since video start) to muscle-active flags. */
export async function runVideoMotion(key: string, videoUri: string, mode: MotionMode, active?: (t: number[]) => boolean[]): Promise<VideoMotionResult> {
  if (!Native) throw new Error("Video analysis needs the Android app");
  if (busy) throw new Error("Another video is being analysed");
  setBusy({ key, progress: 0, stage: "Reading the video…" });
  let tmp: File | null = null;
  try {
    const d = await Native.decodeFramesGray(videoUri, VM_FPS, VM_WIDTH);
    tmp = new File("file://" + d.path.replace(/^file:\/\//, ""));
    if (!d.count) throw new Error("No frames could be read from the video");
    const data = await tmp.bytes();
    setBusy({ key, progress: 0, stage: "Analysing video…" });
    return await analyseMotion({ width: d.width, height: d.height, data, t: d.t }, mode, active, (p) => setBusy({ key, progress: p, stage: "Analysing video…" }));
  } finally {
    // the temporary frames file is ours (cache), never the recording
    try { if (tmp?.exists) tmp.delete(); } catch {}
    setBusy(null);
  }
}

/** Default mode for an experiment: pull-up / dip machines ride the phone on the pad. */
export function experimentMode(m: ExperimentMeta): MotionMode {
  const words = `${m.title} ${m.notes}`;
  return motionModeFor(null, words) ?? motionModeFor(m.exercise?.id, m.exercise?.name) ?? "rope";
}

/** Sum of the EMG envelopes (50 Hz bins from t = 0) of every sensor file in a folder. */
async function emgSum(dir: Directory): Promise<Float32Array | null> {
  const sensors: { file: string }[] = readJson(new File(dir, "sensors.json"), []);
  let sum: Float32Array | null = null;
  for (const s of sensors) {
    const f = new File(dir, s.file);
    if (!f.exists) continue;
    const bytes = await f.bytes();
    const fit = fitClock(bytes);
    if (fit.n < 10) continue;
    const e = envelopeBins(bytes, fit, { band: "emg", notch: 50 });
    if (!sum) sum = e.slice();
    else for (let i = 0; i < Math.min(sum.length, e.length); i++) sum[i] += e[i];
  }
  return sum;
}

export interface SavedVideoMotion extends VideoMotionResult { file: string; startS: number; analysedAt: string }

export function loadExperimentMotion(id: string): SavedVideoMotion | null {
  return readJson<SavedVideoMotion | null>(new File(new Directory(experimentsDir(), id), "videomotion.json"), null);
}

export async function analyseExperimentVideo(id: string, mode?: MotionMode): Promise<SavedVideoMotion | null> {
  const m = loadExperiment(id);
  if (!m?.video) return null;
  const dir = new Directory(experimentsDir(), id);
  const vid = new File(dir, m.video.file || "video.mp4");
  if (!vid.exists) return null;
  const md = mode ?? loadExperimentMotion(id)?.mode ?? experimentMode(m);
  const sum = await emgSum(dir);
  const off = m.video.offsetS ?? 0;
  const r = await runVideoMotion(`exp:${id}`, vid.uri, md, sum ? (t) => activeFromEnvelope(sum, 50, t, off) : undefined);
  const saved: SavedVideoMotion = { ...r, file: vid.name, startS: off, analysedAt: new Date().toISOString() };
  writeJson(new File(dir, "videomotion.json"), saved);
  updateExperiment(id, { videoMotion: { mode: r.mode, reps: r.reps.length, full: r.full, partial: r.partial } });
  return saved;
}

/* ---------------- workout videos ---------------- */

const workoutMotionFile = (workoutId: string, file: string) => new File(new Directory(workoutsDir(), workoutId), `videomotion_${file.replace(/\.mp4$/, "")}.json`);

export function loadWorkoutMotions(workoutId: string): SavedVideoMotion[] {
  const dir = new Directory(workoutsDir(), workoutId);
  if (!dir.exists) return [];
  const out: SavedVideoMotion[] = [];
  for (const f of dir.list()) if (f instanceof File && /^videomotion_.*\.json$/.test(f.name)) { const v = readJson<SavedVideoMotion | null>(f, null); if (v) out.push(v); }
  return out.sort((a, b) => a.startS - b.startS);
}

/** Analyse a workout video. startS = when the video started, in s since the workout started. */
export async function analyseWorkoutVideo(workoutId: string, file: string, startS: number, mode: MotionMode): Promise<SavedVideoMotion | null> {
  const dir = new Directory(workoutsDir(), workoutId);
  const vid = new File(dir, file);
  if (!vid.exists) return null;
  const r = await runVideoMotion(`wk:${workoutId}:${file}`, vid.uri, mode);
  const saved: SavedVideoMotion = { ...r, file, startS, analysedAt: new Date().toISOString() };
  writeJson(workoutMotionFile(workoutId, file), saved);
  return saved;
}

/** Video reps inside a set (workout seconds), counted by where the rep's far end falls. */
export function videoRepsInSet(motions: SavedVideoMotion[], startS: number, endS: number) {
  const reps = motions.flatMap((m) => m.reps.map((r) => ({ ...r, at: m.startS + r.t, mode: m.mode })));
  const inSet = reps.filter((r) => r.at >= startS - 1 && r.at <= endS + 1);
  const m = motions.find((x) => x.startS <= endS && x.startS + (x.trace.t[x.trace.t.length - 1] ?? 0) >= startS);
  return { reps: inSet, full: inSet.filter((r) => r.range === "full").length, partial: inSet.filter((r) => r.range === "partial").length, motion: m ?? null };
}
