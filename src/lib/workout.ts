/**
 * The workout: one continuous native recording for the whole gym session, the user's quick
 * inputs as timestamped events, live set/rep detection, and full re-analysis at the end.
 *
 * Files in workouts/<id>/:
 *   workout.json   id, name, startedAt, endedAt, unit
 *   events.jsonl   WorkoutEvent per line (times: ms since workout start)
 *   <sensor>.bin   raw packets (written natively by the foreground service)
 *   sensors.json   written natively
 *   analysis.json  sets detected from the raw data when the workout ended (re-computable)
 */
import { useSyncExternalStore } from "react";
import { Directory, File, Paths } from "expo-file-system";
import Native from "../../modules/myoblue-native";
import { buildLog, buildLogFull, stateAt, type Ignored, type LoggedSet, type Placement, type Side, type Unit, type WorkoutEvent } from "../core/log";
import { shortName } from "./exercises";
import { registerLiveChannels, registerWorkoutsDir, resolverFor } from "./reps";
import { envelopeBins, filteredWindow, fitClock } from "../core/offline";
import { ACT_DT, DEFAULT_DETECT, detectSets, formFlags, medianFrequency, movingAverage, type Activation, type Channel, type DetectedSet, type Reference } from "../core/workout";
import { BIN_ORIGIN, getSensor } from "./sensors";
import { getSettings, updateSettings } from "./settings";

export const APP_VERSION = "0.1.0";
const FILTERS = { band: "emg" as const, notch: 50 as const };

export interface WorkoutMeta {
  id: string;
  name: string;
  startedAt: string;
  endedAt?: string;
  unit: Unit;
  app: string;
}

interface Active {
  meta: WorkoutMeta;
  dir: Directory;
  /** native clock (ms) at workout start */
  origin: number;
  events: WorkoutEvent[];
  frozen: DetectedSet[];
  current: DetectedSet[];
  frozenUntil: number;
}

export interface WorkoutState {
  active: Active | null;
  /** set being performed right now (live), or null while resting */
  live: DetectedSet | null;
  /** ms since the last set ended (rest timer), null before the first set */
  restMs: number | null;
  version: number;
}

let state: WorkoutState = { active: null, live: null, restMs: null, version: 0 };
const listeners = new Set<() => void>();
function emit(patch: Partial<WorkoutState>) {
  state = { ...state, ...patch, version: state.version + 1 };
  listeners.forEach((l) => l());
}
export function useWorkout(): WorkoutState {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => state);
}
export const getWorkout = () => state;

export function workoutsDir(): Directory {
  const d = new Directory(Paths.document, "workouts");
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

const now = () => (Native ? Native.now() : Date.now());

/* ---------------- setup outside a workout (remembered in settings) ---------------- */

export function currentSetup() {
  const s = getSettings();
  return { placements: s.placements, refs: s.refs, exercise: s.exercise, grip: s.grip, weight: s.weight, unit: s.unit };
}

/* ---------------- lifecycle ---------------- */

let timer: ReturnType<typeof setInterval> | null = null;

export function initWorkout() {
  if (timer || !Native) return;
  // resume if the app restarted while the service kept recording
  const st = Native.recordingStatus();
  if (st) {
    const id = st.path.split("/").filter(Boolean).pop()!;
    const dir = new Directory(workoutsDir(), id);
    try {
      const meta: WorkoutMeta = JSON.parse(new File(dir, "workout.json").textSync());
      const events = readEvents(dir);
      state = { ...state, active: { meta, dir, origin: Native.now() - st.elapsedMs, events, frozen: [], current: [], frozenUntil: 0 } };
    } catch {}
  }
  timer = setInterval(tick, 1000);
}

export function startWorkout(): boolean {
  if (!Native || state.active) return false;
  const started = new Date();
  const id = started.toISOString().replace(/[:.]/g, "-");
  const dir = new Directory(workoutsDir(), id);
  dir.create({ intermediates: true, idempotent: true });
  const s = getSettings();
  const meta: WorkoutMeta = { id, name: defaultName(started), startedAt: started.toISOString(), unit: s.unit, app: APP_VERSION };
  writeJson(new File(dir, "workout.json"), meta);
  if (!Native.startRecording(dir.uri, meta.name)) return false;
  const st = Native.recordingStatus();
  const origin = Native.now() - (st?.elapsedMs ?? 0);
  const active: Active = { meta, dir, origin, events: [], frozen: [], current: [], frozenUntil: 0 };
  state = { ...state, active, live: null, restMs: null };
  // the current setup carries into the workout
  const setup = currentSetup();
  if (setup.placements.length) addEvent({ type: "placement", placements: setup.placements });
  for (const p of setup.placements) {
    const r = setup.refs[refKey(p)];
    // dry electrodes: a calibration only carries over if it's recent (same session, same placement)
    if (r && Date.now() - r.at < 3 * 3600_000) addEvent({ type: "calibration", sensorId: p.sensorId, muscle: p.muscle, side: p.side, ref: r.ref, snrDb: r.snrDb });
  }
  if (setup.exercise) addEvent({ type: "exercise", exerciseId: setup.exercise.id, name: setup.exercise.name });
  addEvent({ type: "grip", grip: setup.grip });
  if (setup.weight !== null) addEvent({ type: "weight", value: setup.weight, unit: setup.unit });
  emit({});
  return true;
}

export async function endWorkout(): Promise<string | null> {
  const a = state.active;
  if (!a || !Native) return null;
  Native.stopRecording();
  a.meta.endedAt = new Date().toISOString();
  // name the workout after what was done in it
  const names = [...new Set(liveLog().map((s) => shortName({ id: s.exerciseId, name: s.exerciseName })))];
  if (names.length) a.meta.name = names.slice(0, 3).join(" · ") + (names.length > 3 ? ` +${names.length - 3}` : "");
  writeJson(new File(a.dir, "workout.json"), a.meta);
  // keep the live result until the full analysis replaces it
  writeJson(new File(a.dir, "analysis.json"), { live: true, sets: [...a.frozen, ...a.current] });
  emit({ active: null, live: null, restMs: null });
  try { await analyseWorkout(a.meta.id); } catch {}
  return a.meta.id;
}

function defaultName(d: Date) {
  const h = d.getHours();
  const part = h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
  return `${part} workout`;
}

/* ---------------- quick inputs ---------------- */

export function refKey(p: { sensorId: string; muscle: string; side: Side }) {
  return `${p.sensorId}|${p.muscle}|${p.side}`;
}

type NewEvent = WorkoutEvent extends infer E ? (E extends WorkoutEvent ? Omit<E, "t"> : never) : never;

/** Record an input now. Also updates the remembered setup so the next workout starts the same way. */
export function addEvent(e: NewEvent) {
  const s = getSettings();
  if (e.type === "exercise") updateSettings({ exercise: { id: e.exerciseId, name: e.name }, recentExercises: [e.exerciseId, ...s.recentExercises.filter((x) => x !== e.exerciseId)].slice(0, 12) });
  if (e.type === "weight") updateSettings({ weight: e.value, unit: e.unit, recentWeights: [e.value, ...s.recentWeights.filter((w) => w !== e.value)].slice(0, 8) });
  if (e.type === "grip") updateSettings({ grip: e.grip });
  if (e.type === "placement") updateSettings({ placements: e.placements });
  if (e.type === "calibration") updateSettings({ refs: { ...s.refs, [refKey(e)]: { ref: e.ref, snrDb: e.snrDb, at: Date.now(), placement: e.placement } } });
  const a = state.active;
  if (!a) { emit({}); return; }
  const ev = { ...e, t: now() - a.origin } as WorkoutEvent;
  a.events.push(ev);
  appendLine(new File(a.dir, "events.jsonl"), JSON.stringify(ev));
  emit({});
}

export function editSet(setStart: number, patch: Extract<WorkoutEvent, { type: "setEdit" }>["patch"], workoutId?: string) {
  const a = state.active;
  if (a && (!workoutId || workoutId === a.meta.id)) { addEvent({ type: "setEdit", setStart, patch }); return; }
  if (!workoutId) return;
  // finished workout: append the edit to its event log
  const dir = new Directory(workoutsDir(), workoutId);
  const ev: WorkoutEvent = { t: Date.now(), type: "setEdit", setStart, patch };
  appendLine(new File(dir, "events.jsonl"), JSON.stringify(ev));
}

function appendLine(f: File, line: string) {
  try {
    if (!f.exists) f.create();
    f.write(line + "\n", { append: true });
  } catch {}
}

/* ---------------- live detection ---------------- */

function liveChannels(a: Active, from: number, to: number): Channel[] {
  return liveChannelsAt(a, from, to, to);
}

function liveChannelsAt(a: Active, from: number, to: number, at: number): Channel[] {
  const { placement, refs } = stateAt(a.events, at);
  const out: Channel[] = [];
  for (const p of placement) {
    const s = getSensor(p.sensorId);
    const cal = refs.get(p.sensorId);
    if (!s || !cal || cal.muscle !== p.muscle || cal.side !== p.side) continue;
    // bins are on the native clock; convert to workout time
    const k0 = Math.max(0, Math.floor((a.origin + from - BIN_ORIGIN) / ACT_DT));
    const k1 = Math.min(s.bins.length, Math.ceil((a.origin + to - BIN_ORIGIN) / ACT_DT));
    if (k1 - k0 < 50) continue;
    const scale = 100 / cal.ref.mvcRms;
    const v = new Float32Array(k1 - k0);
    for (let k = k0; k < k1; k++) { const x = s.bins[k]; v[k - k0] = x === undefined ? NaN : x * scale; }
    out.push({ key: p.sensorId, side: p.side, muscle: p.muscle, ref: cal.ref, act: { t0: BIN_ORIGIN + k0 * ACT_DT - a.origin, v: movingAverage(v, 10) } });
  }
  return out;
}

function tick() {
  const a = state.active;
  if (!a) return;
  const t = now() - a.origin;
  const opt = { ...DEFAULT_DETECT, restGapS: getSettings().restGapS, repParams: resolverFor(a.events) };
  const from = Math.max(0, a.frozenUntil + 500, t - 10 * 60_000);
  const sets = detectSets(liveChannels(a, from, t), opt);
  const closeBefore = t - (opt.restGapS + 1.5) * 1000;
  const current: DetectedSet[] = [];
  for (const s of sets) {
    if (s.end < closeBefore) { a.frozen.push(s); a.frozenUntil = s.end; }
    else current.push(s);
  }
  a.current = current;
  const live = current.find((s) => s.end > t - opt.restGapS * 1000) ?? null;
  const lastEnd = a.frozen.length ? a.frozen[a.frozen.length - 1].end : null;
  emit({ live, restMs: live ? null : lastEnd !== null ? t - lastEnd : null });
}

/** After the rep settings changed: detect this placement period's sets again with the new settings. */
export function redetectLive() {
  const a = state.active;
  if (!a) return;
  const t = now() - a.origin;
  let from = 0;
  for (const e of a.events) if (e.type === "placement" && e.t <= t) from = e.t;
  const opt = { ...DEFAULT_DETECT, restGapS: getSettings().restGapS, repParams: resolverFor(a.events) };
  const sets = detectSets(liveChannels(a, from, t), opt);
  const closeBefore = t - (opt.restGapS + 1.5) * 1000;
  a.frozen = [...a.frozen.filter((s) => s.end < from), ...sets.filter((s) => s.end < closeBefore)];
  a.frozenUntil = a.frozen.length ? a.frozen[a.frozen.length - 1].end : 0;
  a.current = sets.filter((s) => s.end >= closeBefore);
  emit({});
}

export function activeWorkoutId(): string | null {
  return state.active?.meta.id ?? null;
}

export function liveLog(): LoggedSet[] {
  return liveLogFull().sets;
}

export function liveLogFull(): { sets: LoggedSet[]; ignored: Ignored[] } {
  const a = state.active;
  if (!a) return { sets: [], ignored: [] };
  return buildLogFull([...a.frozen, ...a.current], a.events, a.meta.unit);
}

/** Paused right now? (nothing counts as a set while paused) */
export function isPaused(): boolean {
  const a = state.active;
  if (!a) return false;
  let p = false;
  for (const e of a.events) if (e.type === "pause") p = e.paused;
  return p;
}

export function workoutTime(): number {
  return state.active ? now() - state.active.origin : 0;
}

/* ---------------- stored workouts ---------------- */

function readEvents(dir: Directory): WorkoutEvent[] {
  const f = new File(dir, "events.jsonl");
  if (!f.exists) return [];
  return f.textSync().split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

function readJson<T>(f: File, fallback: T): T {
  try { return f.exists ? JSON.parse(f.textSync()) : fallback; } catch { return fallback; }
}

function writeJson(f: File, v: unknown) {
  if (!f.exists) f.create();
  f.write(JSON.stringify(v));
}

export interface WorkoutSummary {
  meta: WorkoutMeta;
  sets: LoggedSet[];
  events: WorkoutEvent[];
  analysed: boolean;
  bytes: number;
}

export function listWorkouts(): WorkoutSummary[] {
  let items: ReturnType<Directory["list"]> = [];
  try { items = workoutsDir().list(); } catch { return []; }
  const out: WorkoutSummary[] = [];
  for (const d of items) {
    if (!(d instanceof Directory)) continue;
    const w = loadWorkout(d.name);
    if (w) out.push(w);
  }
  return out.sort((x, y) => y.meta.startedAt.localeCompare(x.meta.startedAt));
}

/** Workouts that start within `gapMin` minutes of the previous one ending form one session. */
export function groupSessions(list: WorkoutSummary[], gapMin = 20): WorkoutSummary[][] {
  const asc = [...list].sort((a, b) => a.meta.startedAt.localeCompare(b.meta.startedAt));
  const groups: WorkoutSummary[][] = [];
  for (const w of asc) {
    const g = groups[groups.length - 1];
    const prev = g?.[g.length - 1];
    const prevEnd = prev ? new Date(prev.meta.endedAt ?? prev.meta.startedAt).getTime() : -Infinity;
    if (g && new Date(w.meta.startedAt).getTime() - prevEnd < gapMin * 60_000) g.push(w);
    else groups.push([w]);
  }
  return groups.reverse();
}

export function loadWorkout(id: string): WorkoutSummary | null {
  const dir = new Directory(workoutsDir(), id);
  const meta = readJson<WorkoutMeta | null>(new File(dir, "workout.json"), null);
  if (!meta) return null;
  const events = readEvents(dir);
  const analysis: { live?: boolean; sets: DetectedSet[] } = readJson(new File(dir, "analysis.json"), { sets: [] });
  const sensors: { file: string }[] = readJson(new File(dir, "sensors.json"), []);
  const bytes = sensors.reduce((n, s) => { const f = new File(dir, s.file); return n + (f.exists ? f.size : 0); }, 0);
  return { meta, events, sets: buildLog(analysis.sets, events, meta.unit), analysed: !analysis.live, bytes };
}

/**
 * Full analysis from the raw recording: per sensor, envelope bins for the whole workout, then
 * per placement period, sets + reps + holds; per-rep median frequency from the filtered EMG.
 */
export async function analyseWorkout(id: string): Promise<void> {
  const dir = new Directory(workoutsDir(), id);
  const events = readEvents(dir);
  const sensors: { id: string; name: string; file: string }[] = readJson(new File(dir, "sensors.json"), []);
  const files = new Map<string, { bytes: Uint8Array; fit: ReturnType<typeof fitClock>; bins: Float32Array }>();
  for (const s of sensors) {
    const f = new File(dir, s.file);
    if (!f.exists) continue;
    const bytes = await f.bytes();
    const fit = fitClock(bytes);
    if (fit.n < 10) continue;
    const bins = envelopeBins(bytes, fit, FILTERS);
    files.set(s.id, { bytes, fit, bins });
    // 50 Hz envelope (µV) for plots, so set details don't re-read the raw file
    const af = new File(dir, s.file.replace(/\.bin$/, ".act"));
    if (af.exists) af.delete();
    af.create();
    af.write(new Uint8Array(bins.buffer, bins.byteOffset, bins.byteLength));
    await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive
  }
  // placement periods
  const placements = events.filter((e) => e.type === "placement");
  const bounds = placements.map((p) => p.t);
  const all: DetectedSet[] = [];
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i] as Extract<WorkoutEvent, { type: "placement" }>;
    const from = bounds[i], to = bounds[i + 1] ?? Infinity;
    const channels: Channel[] = [];
    for (const pl of p.placements) {
      const f = files.get(pl.sensorId);
      // the calibration for this sensor + placement: the last one before the period ends
      const cal = [...events].reverse().find((e): e is Extract<WorkoutEvent, { type: "calibration" }> =>
        e.type === "calibration" && e.sensorId === pl.sensorId && e.muscle === pl.muscle && e.side === pl.side && e.t < to);
      if (!f || !cal) continue;
      channels.push({ key: pl.sensorId, side: pl.side, muscle: pl.muscle, ref: cal.ref, act: binsToActivation(f.bins, cal.ref, from, Math.min(to, f.bins.length * ACT_DT)) });
    }
    const sets = detectSets(channels, { ...DEFAULT_DETECT, restGapS: getSettings().restGapS, repParams: resolverFor(events) });
    for (const set of sets) {
      for (const side of set.sides) {
        const f = files.get(side.key)!;
        const win = filteredWindow(f.bytes, f.fit, FILTERS, set.start, set.end);
        for (const r of side.reps) {
          const a = lower(win.t, r.start), b = lower(win.t, r.end);
          r.mdf = medianFrequency(win.v.subarray(a, b), win.fs);
        }
        const m = side.reps.map((r) => r.mdf).filter((x): x is number => x !== undefined && x === x);
        const k = Math.max(1, Math.floor(m.length / 3));
        if (m.length >= 3) { side.mdfStart = avg(m.slice(0, k)); side.mdfEnd = avg(m.slice(-k)); }
      }
      set.flags = formFlags(set.sides);
      all.push(set);
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  writeJson(new File(dir, "analysis.json"), { live: false, sets: all, computedAt: new Date().toISOString() });
}

function binsToActivation(bins: Float32Array, ref: Reference, from: number, to: number): Activation {
  const k0 = Math.max(0, Math.floor(from / ACT_DT)), k1 = Math.min(bins.length, Math.ceil(to / ACT_DT));
  const scale = 100 / ref.mvcRms;
  const v = new Float32Array(Math.max(0, k1 - k0));
  for (let k = k0; k < k1; k++) v[k - k0] = bins[k] * scale;
  return { t0: k0 * ACT_DT, v: movingAverage(v, 10) };
}

const avg = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
function lower(t: Float64Array, x: number) {
  let lo = 0, hi = t.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

/** 50 Hz envelope (µV) of one sensor: live buffer for the active workout, saved file otherwise. Bin 0 = workout start. */
export async function envelopeOf(workoutId: string | null, sensorId: string): Promise<Float32Array | null> {
  const a = state.active;
  if (a && (!workoutId || workoutId === a.meta.id)) {
    const s = getSensor(sensorId);
    if (!s) return null;
    const k0 = Math.round((a.origin - BIN_ORIGIN) / ACT_DT);
    const out = new Float32Array(Math.max(0, s.bins.length - k0));
    for (let k = 0; k < out.length; k++) { const v = s.bins[k0 + k]; out[k] = v === undefined ? NaN : v; }
    return out;
  }
  if (!workoutId) return null;
  const dir = new Directory(workoutsDir(), workoutId);
  const sensors: { id: string; file: string }[] = readJson(new File(dir, "sensors.json"), []);
  const f = sensors.find((x) => x.id === sensorId);
  if (!f) return null;
  const af = new File(dir, f.file.replace(/\.bin$/, ".act"));
  if (!af.exists) return null;
  const b = await af.bytes();
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
}

export function deleteWorkout(id: string) {
  const d = new Directory(workoutsDir(), id);
  if (d.exists) d.delete();
}

export function renameWorkout(id: string, name: string) {
  const f = new File(workoutsDir(), id, "workout.json");
  const meta: WorkoutMeta = JSON.parse(f.textSync());
  writeJson(f, { ...meta, name });
}

/* ---------------- exports ---------------- */

export function exportSetsCsv(w: WorkoutSummary): File {
  const dir = new Directory(workoutsDir(), w.meta.id);
  const f = new File(dir, `myolift_${w.meta.id.slice(0, 10)}_sets.csv`);
  if (f.exists) f.delete();
  f.create();
  const rows = ["set,start_s,end_s,exercise,grip,weight,unit,reps,group,side,muscle,side_reps,mean_peak_pct,effort_pct_s,active_s,holds,hold_s,mdf_start_hz,mdf_end_hz,flags"];
  w.sets.forEach((s, i) => {
    for (const side of s.sides) {
      const holdS = side.holds.reduce((t, h) => t + (h.end - h.start) / 1000, 0);
      rows.push([i + 1, (s.start / 1000).toFixed(1), (s.end / 1000).toFixed(1), q(s.exerciseName), q(s.grip), s.weight ?? "", s.unit, s.reps, s.group ?? "",
        side.side, side.muscle, side.reps.length, side.peak.toFixed(1), side.effort.toFixed(0), side.activeS.toFixed(1), side.holds.length, holdS.toFixed(1),
        side.mdfStart?.toFixed(0) ?? "", side.mdfEnd?.toFixed(0) ?? "", q(s.flags.map((x) => x.text).join("; "))].join(","));
    }
  });
  f.write(rows.join("\n") + "\n");
  return f;
}

export function exportRepsCsv(w: WorkoutSummary): File {
  const dir = new Directory(workoutsDir(), w.meta.id);
  const f = new File(dir, `myolift_${w.meta.id.slice(0, 10)}_reps.csv`);
  if (f.exists) f.delete();
  f.create();
  const rows = ["set,exercise,grip,weight,side,rep,start_s,peak_s,end_s,peak_pct,mean_pct,rise_s,fall_s,mdf_hz"];
  w.sets.forEach((s, i) => {
    for (const side of s.sides) side.reps.forEach((r, j) => rows.push([i + 1, q(s.exerciseName), q(s.grip), s.weight ?? "", side.side, j + 1,
      (r.start / 1000).toFixed(2), (r.peakT / 1000).toFixed(2), (r.end / 1000).toFixed(2), r.peak.toFixed(1), r.mean.toFixed(1), r.riseS.toFixed(2), r.fallS.toFixed(2), r.mdf?.toFixed(0) ?? ""].join(",")));
  });
  f.write(rows.join("\n") + "\n");
  return f;
}

const q = (s: string) => `"${String(s).replace(/"/g, '""')}"`;

export type { Placement };

// the rep-learning module reads set activation through these
registerWorkoutsDir(workoutsDir);
registerLiveChannels(async (wid, span) => {
  const a = state.active;
  if (!a || a.meta.id !== wid) return [];
  return liveChannelsAt(a, span.start - 2000, span.end + 2000, span.start);
});
