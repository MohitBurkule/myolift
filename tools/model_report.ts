// Run the muscle model on an exported MyoLift zip (unzipped folder): fit per exercise, then per rep
// end angle, strength left, reps in reserve and partial-at-the-top flags.
// Usage: npx tsx tools/model_report.ts <unzipped-dir> [out.json]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildLogFull, type LoggedSet, type WorkoutEvent } from "../src/core/log";
import { fitParams, FRESH, geomFor, recover, simulateSet, type ExerciseGeom, type FatigueState, type FitSet, type ModelParams } from "../src/core/musclemodel";
import { averageActivation, DEFAULT_DETECT, DEFAULT_DIP, DEFAULT_REP, detectSets, movingAverage, type Activation, type Channel, type Rep } from "../src/core/workout";

const root = process.argv[2];
interface Job { wid: string; set: LoggedSet; act: Activation; parts: { weight: number; reps: Rep[] }[]; rest?: number; geom: ExerciseGeom }
const jobs: Job[] = [];

for (const wid of readdirSync(join(root, "workouts")).sort()) {
  const d = join(root, "workouts", wid);
  const events: WorkoutEvent[] = readFileSync(join(d, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const sensors: { id: string; file: string }[] = JSON.parse(readFileSync(join(d, "sensors.json"), "utf8"));
  const placement = (events.find((e) => e.type === "placement") as any).placements as { sensorId: string; side: "left" | "right"; muscle: string }[];
  const channels: Channel[] = [];
  for (const s of sensors) {
    const cal = [...events].reverse().find((e: any) => e.type === "calibration" && e.sensorId === s.id) as any;
    const p = placement.find((x) => x.sensorId === s.id)!;
    const b = readFileSync(join(d, s.file.replace(/\.bin$/, ".act")));
    const bins = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
    const v = new Float32Array(bins.length);
    for (let k = 0; k < bins.length; k++) v[k] = (bins[k] * 100) / cal.ref.mvcRms;
    channels.push({ key: s.id, side: p.side, muscle: p.muscle, ref: cal.ref, act: { t0: 0, v: movingAverage(v, 10) } });
  }
  const exAt = (t: number) => [...events].filter((e: any) => e.type === "exercise" && e.t <= t + 2000).pop() as any;
  const repParams = (t: number) => { const n = (exAt(t)?.name ?? "").toLowerCase(); return /machine/.test(n) && /push ?down|dip/.test(n) ? DEFAULT_DIP : DEFAULT_REP; };
  const log = buildLogFull(detectSets(channels, { ...DEFAULT_DETECT, repParams }), events);
  // both arms combined (rep timing is shared); one arm alone otherwise
  const act = channels.length >= 2 ? averageActivation(channels[0].act, channels[1].act) : channels[0].act;
  let prevEnd: number | null = null;
  for (const set of log.sets) {
    if (set.weight === null) continue;
    // only elbow-extension exercises have a load model (pull-ups etc. use the triceps as helpers)
    if (geomFor(set.exerciseId, set.exerciseName).id === "generic") { console.log(`skip ${set.exerciseName}: no elbow-extension load model`); prevEnd = set.end; continue; }
    const side = [...set.sides].sort((a, b) => b.reps.length - a.reps.length)[0];
    const reps = side?.reps ?? [];
    const parts = set.segments?.length
      ? set.segments.map((g) => ({ weight: g.weight, reps: reps.filter((r) => r.start >= g.start - 500 && r.start < g.end) })).filter((p) => p.reps.length)
      : [{ weight: set.weight, reps }];
    jobs.push({ wid, set, act, parts, rest: prevEnd === null ? undefined : (set.start - prevEnd) / 1000, geom: geomFor(set.exerciseId, set.exerciseName) });
    prevEnd = set.end;
  }
}

// fit one parameter set per exercise geometry over all its sets (drop-set parts carry fatigue: no rest)
const fitted = new Map<string, ModelParams>();
for (const gid of new Set(jobs.map((j) => j.geom.id))) {
  const js = jobs.filter((j) => j.geom.id === gid);
  const fitSets: FitSet[] = js.flatMap((j) => j.parts.map((p, k) => ({
    act: j.act, reps: p.reps, weight: p.weight, restBeforeS: k ? 0 : j.rest,
    fullTarget: p.reps.filter((r) => (r.range ?? "full") === "full").length,
  })));
  const f = fitParams(fitSets, js[0].geom);
  fitted.set(gid, f.params);
  console.log(`fit ${gid}: gain ${f.params.gain.toFixed(2)} F ${f.params.F} R ${f.params.R} (loss ${f.loss.toFixed(2)} over ${fitSets.length} set parts)`);
}

const out: any[] = [];
let state: FatigueState = FRESH, lastWid = "";
for (const j of jobs) {
  const p = fitted.get(j.geom.id)!;
  if (j.wid !== lastWid || j.rest === undefined) state = FRESH; else state = recover(state, j.rest, p);
  lastWid = j.wid;
  const reps: any[] = [];
  let rir = NaN;
  for (const part of j.parts) {
    const sim = simulateSet(j.act, part.reps, part.weight, p, j.geom, state);
    state = sim.state;
    rir = sim.rir;
    for (const [k, r] of sim.reps.entries()) reps.push({
      t: +(r.start / 1000).toFixed(1), weight: part.weight, detected: part.reps[k].range ?? "full",
      startDeg: Math.round(r.startDeg), endDeg: Math.round(r.endDeg), reachedLockout: r.reachedLockout,
      partialTop: r.partialTop, lowRatio: +r.lowRatio.toFixed(2), strengthLeft: +r.strengthLeft.toFixed(3), peakDrive: +r.peakDrive.toFixed(2),
    });
  }
  const lock = reps.filter((r) => r.reachedLockout && !r.partialTop).length;
  const row = {
    workout: j.wid, start: +(j.set.start / 1000).toFixed(0), end: +(j.set.end / 1000).toFixed(0), exercise: j.set.exerciseName, model: j.geom.id,
    weights: j.parts.map((q) => q.weight), detectedFull: j.set.reps, detectedPartials: j.set.partials,
    modelFull: lock, modelPartialTop: reps.filter((r) => r.partialTop).length, notToLockout: reps.filter((r) => !r.reachedLockout).length,
    strengthLeftEnd: reps.length ? reps[reps.length - 1].strengthLeft : null, rir: rir === rir ? +rir.toFixed(1) : null, reps,
  };
  out.push(row);
  console.log(`${j.wid.slice(-8)} ${String(row.start).padStart(4)}s ${row.exercise.slice(0, 20).padEnd(20)} ${row.weights.join("→").padEnd(10)} detected ${row.detectedFull}+${row.detectedPartials}  model: ${lock} to lockout, ${row.modelPartialTop} partial-top, ${row.notToLockout} short  strength left ${row.strengthLeftEnd?.toFixed(2)}  RIR ${row.rir}`);
}
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify({ params: Object.fromEntries(fitted), sets: out }, null, 1));
