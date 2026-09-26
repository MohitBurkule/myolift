/**
 * Session insights on the phone: gathers a day's experiments and workouts (one gym session),
 * builds the per-recording inputs (EMG envelopes, video traces, weights, labels) and runs
 * src/core/insights.ts + src/core/technique.ts. Results are cached per day; recordings are only read.
 */
import { useSyncExternalStore } from "react";
import { Directory, File, Paths } from "expo-file-system";
import { envelopeBins, filteredWindow, fitClock } from "../core/offline";
import { emgRepsFromEnvelope, sessionInsights, type RecordingInput, type SessionInsights, type Side, type SideEmg } from "../core/insights";
import { detectTechniques, type TechniqueCard } from "../core/technique";
import { medianFrequency } from "../core/workout";
import { weightAt } from "../core/expdata";
import { experimentsDir, listExperiments, type ExperimentMeta } from "./experiments";
import { loadExperimentMotion, loadWorkoutMotions } from "./videoanalysis";
import { listWorkouts, workoutsDir, type WorkoutSummary } from "./workout";

export interface DayInsights { day: string; computedAt: string; ins: SessionInsights; cards: TechniqueCard[]; recordings: { id: string; kind: "experiment" | "workout"; title: string; video: boolean }[]; missingVideo: string[] }

export const dayKey = (d: Date | string) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };

function cacheDir() { const d = new Directory(Paths.document, "insights"); if (!d.exists) d.create({ intermediates: true, idempotent: true }); return d; }
const cacheFile = (day: string) => new File(cacheDir(), `${day}.json`);

export function loadDayInsights(day: string): DayInsights | null {
  try { const f = cacheFile(day); return f.exists ? JSON.parse(f.textSync()) : null; } catch { return null; }
}
/** Drop the cached result (our own cache file only) so it's recomputed next time. */
export function invalidateDay(d: Date | string) { try { const f = cacheFile(dayKey(d)); if (f.exists) f.delete(); } catch {} bump(); }

let busy: string | null = null, version = 0;
const subs = new Set<() => void>();
const bump = () => { version++; subs.forEach((f) => f()); };
export const useInsightsState = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => `${busy ?? ""}|${version}`);
export const insightsBusy = () => busy;

const filters = { band: "emg" as const, notch: 50 as const };

async function sidesFrom(dir: Directory, sideOf: (sensorId: string) => Side | undefined): Promise<SideEmg[]> {
  let sensors: { id: string; file: string }[] = [];
  try { sensors = JSON.parse(new File(dir, "sensors.json").textSync()); } catch {}
  const out: SideEmg[] = [];
  for (const s of sensors) {
    const f = new File(dir, s.file);
    if (!f.exists) continue;
    const side = sideOf(s.id);
    if (!side || out.some((o) => o.side === side)) continue;
    const bytes = await f.bytes();
    const fit = fitClock(bytes);
    if (fit.n < 20) continue;
    const env = envelopeBins(bytes, fit, filters);
    out.push({ side, env, mdf: (a, b) => { const w = filteredWindow(bytes, fit, filters, a * 1000, b * 1000); return medianFrequency(w.v, w.fs); } });
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

const sumEnv = (sides: SideEmg[]) => {
  const n = Math.max(0, ...sides.map((s) => s.env.length)), out = new Float32Array(n);
  for (const s of sides) for (let i = 0; i < s.env.length; i++) { const v = s.env[i]; if (v === v) out[i] += v; }
  return out;
};

async function fromExperiment(m: ExperimentMeta): Promise<RecordingInput | null> {
  const dir = new Directory(experimentsDir(), m.id);
  const pl = (m.placements as { sensorId: string; side: Side }[] | undefined) ?? [];
  const sides = await sidesFrom(dir, (id) => pl.find((p) => p.sensorId === id)?.side);
  if (!sides.length) return null;
  const vm = loadExperimentMotion(m.id);
  const tr = vm?.traceFull ?? vm?.trace;
  const label = `${m.preset} ${m.title} ${m.notes}`;
  return {
    id: m.id, startMs: Date.parse(m.startedAt), label, exercise: m.exercise?.name ?? "",
    weightAt: (t) => weightAt(m.weights ?? [], t) ?? m.weight ?? null, sides,
    motion: vm?.mode === "rope" && tr ? { t: tr.t, v: tr.v, offsetS: m.video?.offsetS ?? 0 } : undefined,
    emgReps: vm?.mode === "scale" ? vm.reps.map((r) => ({ start: r.start + (m.video?.offsetS ?? 0), peak: r.t + (m.video?.offsetS ?? 0), end: r.end + (m.video?.offsetS ?? 0), range: r.range === "full" ? "full" : "mid" })) : emgRepsFromEnvelope(sumEnv(sides)),
  };
}

async function fromWorkout(w: WorkoutSummary): Promise<RecordingInput[]> {
  const dir = new Directory(workoutsDir(), w.meta.id);
  const place = [...w.events].reverse().find((e) => e.type === "placement") as { placements: { sensorId: string; side: Side }[] } | undefined;
  const sides = await sidesFrom(dir, (id) => place?.placements.find((p) => p.sensorId === id)?.side);
  if (!sides.length) return [];
  const setAt = (t: number) => w.sets.find((s) => t * 1000 >= s.start - 1000 && t * 1000 <= s.end + 1000);
  const wAt = (t: number) => { const s = setAt(t); if (!s) return null; const g = s.segments?.find((x) => t * 1000 >= x.start && t * 1000 <= x.end); return s.assisted ? null : g?.weight ?? s.weight; };
  const label = (t: number) => { const s = setAt(t); return s ? `${s.exerciseId} ${s.exerciseName} ${s.group ?? ""}` : ""; };
  const reps = w.sets.flatMap((s) => {
    const side = s.sides.reduce((a, b) => (b.reps.length > (a?.reps.length ?? -1) ? b : a), s.sides[0]);
    return (side?.reps ?? []).map((r) => ({ start: r.start / 1000, peak: r.peakT / 1000, end: r.end / 1000, range: r.range }));
  });
  const motions = loadWorkoutMotions(w.meta.id).filter((m) => m.mode === "rope");
  const inVideo = (t: number) => motions.some((m) => t >= m.startS && t <= m.startS + (m.traceFull?.t ?? m.trace.t).slice(-1)[0]);
  const startMs = Date.parse(w.meta.startedAt);
  const first = w.sets[0];
  const base: RecordingInput = {
    id: w.meta.id, startMs, label: first ? label(first.start / 1000) : w.meta.name, exercise: first?.exerciseName ?? "",
    weightAt: wAt, sides, emgReps: reps.filter((r) => !inVideo(r.peak)),
    rir: w.sets.filter((s) => s.rir !== null && s.rir !== undefined).map((s) => ({ t: s.start / 1000, rir: s.rir! })),
  };
  const out = [base];
  for (const m of motions) {
    const tr = m.traceFull ?? m.trace;
    out.push({ ...base, id: `${w.meta.id}:${m.file}`, label: label(m.startS + 1), emgReps: undefined, motion: { t: tr.t, v: tr.v, offsetS: m.startS } });
  }
  return out;
}

/** True when a recording of that day ended, or a video was analysed, after the cached result. */
export function isStale(day: string, d: DayInsights | null): boolean {
  if (!d) return true;
  const at = Date.parse(d.computedAt);
  for (const e of listExperiments().filter((x) => dayKey(x.startedAt) === day)) {
    if (Date.parse(e.endedAt ?? e.startedAt) > at) return true;
    const vm = loadExperimentMotion(e.id);
    if (vm && Date.parse(vm.analysedAt) > at) return true;
  }
  for (const w of listWorkouts().filter((x) => dayKey(x.meta.startedAt) === day)) {
    if (Date.parse(w.meta.endedAt ?? w.meta.startedAt) > at) return true;
    if (loadWorkoutMotions(w.meta.id).some((m) => Date.parse(m.analysedAt) > at)) return true;
  }
  return false;
}

/** Compute (and cache) the insights for one calendar day. */
export async function computeDayInsights(day: string): Promise<DayInsights | null> {
  if (busy) return loadDayInsights(day);
  busy = day; bump();
  try {
    const exps = listExperiments().filter((e) => dayKey(e.startedAt) === day);
    // a workout imported from these experiments would count them twice: the experiments win (they carry the labels)
    const works = listWorkouts().filter((w) => dayKey(w.meta.startedAt) === day && !(w.meta as any).fromExperiments);
    const recs: RecordingInput[] = [], recordings: DayInsights["recordings"] = [], labels: Record<string, string> = {};
    for (const e of exps) {
      const r = await fromExperiment(e);
      if (r) { recs.push(r); labels[r.id] = r.label; }
      recordings.push({ id: e.id, kind: "experiment", title: e.title, video: !!e.video });
    }
    for (const w of works) {
      for (const r of await fromWorkout(w)) { recs.push(r); labels[r.id] = r.label; }
      recordings.push({ id: w.meta.id, kind: "workout", title: w.meta.name, video: loadWorkoutMotions(w.meta.id).length > 0 });
    }
    if (!recs.length) return null;
    const ins = sessionInsights(recs);
    const holds: Record<string, { where: "stretch" | "mid" | "lockout"; s: number }[]> = {};
    for (const w of works) for (const s of w.sets) if (s.model?.holds?.length) holds[`${w.meta.id}#0`] = [...(holds[`${w.meta.id}#0`] ?? []), ...s.model.holds.map((h) => ({ where: h.where, s: (h.end - h.start) / 1000 }))];
    const cards = detectTechniques(ins, { labels, holds });
    const missingVideo = exps.filter((e) => e.video && !loadExperimentMotion(e.id)).map((e) => e.id);
    // keep the cached file small: reps without the per-side detail the charts don't need
    const out: DayInsights = { day, computedAt: new Date().toISOString(), ins, cards, recordings, missingVideo };
    const f = cacheFile(day);
    if (!f.exists) f.create();
    f.write(JSON.stringify(out));
    return out;
  } finally { busy = null; bump(); }
}
