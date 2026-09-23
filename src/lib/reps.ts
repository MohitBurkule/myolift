/**
 * Rep counting per exercise: which way reps show up in the EMG (peaks or lockout dips) and the
 * settings learned from the user's corrections. Used by live detection and re-analysis.
 */
import { Directory, File } from "expo-file-system";
import type { WorkoutEvent } from "../core/log";
import { stateAt } from "../core/log";
import { tuneRepParams, type RepLabel } from "../core/tuning";
import { ACT_DT, DEFAULT_DIP, DEFAULT_REP, movingAverage, type Channel, type RepParams, type Span } from "../core/workout";
import { findExercise } from "./exercises";
import { getSettings, updateSettings, type RepProfile } from "./settings";

/** Machines where the muscle relaxes at lockout (joints + machine hold the load): reps are dips. */
export function defaultMode(exerciseId: string, name: string): "peak" | "dip" {
  const ex = findExercise(exerciseId);
  const n = (ex?.name ?? name).toLowerCase();
  if (exerciseId === "machine_triceps_pushdown" || exerciseId === "machine_assisted_dip") return "dip";
  if ((ex?.equipment === "machine" || /machine/.test(n)) && /push ?down|press ?down|dip/.test(n)) return "dip";
  return "peak";
}

export function paramsFor(exerciseId: string, name: string): RepParams {
  const prof = getSettings().repProfiles[exerciseId];
  if (prof) return prof.params;
  return defaultMode(exerciseId, name) === "dip" ? DEFAULT_DIP : DEFAULT_REP;
}

/** For detection: rep settings of the exercise that was selected when a set started. */
export function resolverFor(events: WorkoutEvent[]) {
  return (t: number): RepParams => {
    let ex: Extract<WorkoutEvent, { type: "exercise" }> | undefined;
    for (const e of events) if (e.type === "exercise" && e.t <= t + 2000) ex = e;
    return ex ? paramsFor(ex.exerciseId, ex.name) : DEFAULT_REP;
  };
}

export function setMode(exerciseId: string, name: string, mode: "peak" | "dip") {
  const s = getSettings();
  const prof = s.repProfiles[exerciseId];
  const base = mode === "dip" ? DEFAULT_DIP : DEFAULT_REP;
  const next: RepProfile = { params: base, labels: prof?.labels ?? [], error: 0, at: Date.now() };
  updateSettings({ repProfiles: { ...s.repProfiles, [exerciseId]: next } });
}

export function resetProfile(exerciseId: string) {
  const n = { ...getSettings().repProfiles };
  delete n[exerciseId];
  updateSettings({ repProfiles: n });
}

/* ---- activation for a stored set (to learn from) ---- */

type ChannelsFor = (wid: string, span: Span) => Promise<Channel[]>;
let liveChannelsFor: ChannelsFor | null = null;
/** workout.ts registers how to get channels for the active workout (live buffers). */
export function registerLiveChannels(fn: ChannelsFor) { liveChannelsFor = fn; }
let workoutsRoot: (() => Directory) | null = null;
export function registerWorkoutsDir(fn: () => Directory) { workoutsRoot = fn; }

async function storedChannels(wid: string, span: Span): Promise<Channel[]> {
  if (!workoutsRoot) return [];
  const dir = new Directory(workoutsRoot(), wid);
  const evFile = new File(dir, "events.jsonl"), sFile = new File(dir, "sensors.json");
  if (!evFile.exists || !sFile.exists) return [];
  const events: WorkoutEvent[] = evFile.textSync().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const sensors: { id: string; file: string }[] = JSON.parse(sFile.textSync());
  const { placement, refs } = stateAt(events, span.start);
  const out: Channel[] = [];
  for (const p of placement) {
    const s = sensors.find((x) => x.id === p.sensorId), cal = refs.get(p.sensorId);
    if (!s || !cal) continue;
    const af = new File(dir, s.file.replace(/\.bin$/, ".act"));
    if (!af.exists) continue;
    const b = await af.bytes();
    const bins = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
    const k0 = Math.max(0, Math.floor((span.start - 2000) / ACT_DT)), k1 = Math.min(bins.length, Math.ceil((span.end + 2000) / ACT_DT));
    const v = new Float32Array(Math.max(0, k1 - k0));
    for (let k = k0; k < k1; k++) v[k - k0] = (bins[k] * 100) / cal.ref.mvcRms;
    out.push({ key: p.sensorId, side: p.side, muscle: p.muscle, ref: cal.ref, act: { t0: k0 * ACT_DT, v: movingAverage(v, 10) } });
  }
  return out;
}

/**
 * The user corrected a set's rep count: store it as a label for the exercise and re-learn that
 * exercise's settings from all its labels. Returns the new profile.
 */
export async function learnFromCorrection(exerciseId: string, name: string, wid: string, isLive: boolean, span: Span, full: number): Promise<RepProfile> {
  const s = getSettings();
  const prof = s.repProfiles[exerciseId];
  const mode = prof?.params.mode ?? defaultMode(exerciseId, name);
  const labels = [...(prof?.labels ?? []).filter((l) => !(l.wid === wid && Math.abs(l.setStart - span.start) < 3000)),
    { wid, setStart: span.start, setEnd: span.end, full }].slice(-30);
  const data: RepLabel[] = [];
  for (const l of labels) {
    const sp = { start: l.setStart, end: l.setEnd };
    const ch = l.wid === wid && isLive && liveChannelsFor ? await liveChannelsFor(wid, sp) : await storedChannels(l.wid, sp);
    if (ch.length) data.push({ channels: ch, span: sp, full: l.full });
  }
  const tuned = tuneRepParams(data, mode);
  const next: RepProfile = { params: tuned.params, labels, error: tuned.error, at: Date.now() };
  updateSettings({ repProfiles: { ...getSettings().repProfiles, [exerciseId]: next } });
  return next;
}
