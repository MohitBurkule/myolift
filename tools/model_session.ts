// Muscle model across a whole day of experiments: every rope-pushdown set on one timeline with
// the real rest gaps (from the wall-clock start/end of each recording), fitted once, then simulated
// in order so fatigue carries over and recovers during rests.
// Usage: npx tsx tools/model_session.ts <act dir> <labels.json> <experiments dir> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODEL, FRESH, fitParams, geomFor, recover, simulateSet, type FatigueState, type FitSet } from "../src/core/musclemodel";
import { DEFAULT_DETECT, DEFAULT_REP, detectSets, movingAverage, type Activation, type Channel } from "../src/core/workout";

const [actDir, labelsPath, expDir, outPath] = process.argv.slice(2);
const idx: Record<string, { id: string; sides: Record<string, { file: string; mvcRms: number }> }> = JSON.parse(readFileSync(join(actDir, "index.json"), "utf8"));
const labels: Record<string, { ex: string; q: string; weight: number; dropWeights?: number[] }> = JSON.parse(readFileSync(labelsPath, "utf8"));
const g = geomFor("Triceps_Pushdown_-_Rope_Attachment", "Triceps Pushdown - Rope Attachment");

interface Job { k: string; q: string; startWall: number; endWall: number; act: Activation; parts: { weight: number; reps: ReturnType<typeof detectSets>[number]["sides"][number]["reps"]; start: number; end: number }[] }
const jobs: Job[] = [];
for (const [k, e] of Object.entries(idx).sort()) {
  const lab = labels[e.id];
  if (lab.ex !== "rope") continue;
  const meta = JSON.parse(readFileSync(join(expDir, e.id, "experiment.json"), "utf8"));
  const channels: Channel[] = [];
  for (const [side, s] of Object.entries(e.sides)) {
    const b = readFileSync(join(actDir, "..", s.file));
    const bins = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
    const v = new Float32Array(bins.length);
    for (let i = 0; i < bins.length; i++) v[i] = (bins[i] * 100) / s.mvcRms;
    channels.push({ key: side, side: side as "left" | "right", muscle: "triceps", ref: { mvcRms: s.mvcRms, restRms: 3, restSd: 1 }, act: { t0: 0, v: movingAverage(v, 10) } });
  }
  // both arms averaged, as the app's model does
  const n = Math.min(...channels.map((c) => c.act.v.length));
  const avg = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0, c = 0; for (const ch of channels) { const x = ch.act.v[i]; if (x === x) { s += x; c++; } } avg[i] = c ? s / c : NaN; }
  const sets = detectSets(channels, { ...DEFAULT_DETECT, repParams: () => DEFAULT_REP });
  const ws = lab.dropWeights ?? [lab.weight];
  const parts = sets.map((s, i) => ({ weight: ws[Math.min(i, ws.length - 1)], reps: [...s.sides].sort((a, b) => b.reps.length - a.reps.length)[0].reps, start: s.start, end: s.end })).filter((p) => p.reps.length);
  jobs.push({ k, q: lab.q, startWall: Date.parse(meta.startedAt), endWall: Date.parse(meta.endedAt), act: { t0: 0, v: avg }, parts });
}

// fit once over all rope sets of the day
const fs: FitSet[] = [];
let prevEndWall: number | null = null;
for (const j of jobs) {
  j.parts.forEach((p, i) => fs.push({ act: j.act, reps: p.reps, weight: p.weight, restBeforeS: i === 0 && prevEndWall !== null ? (j.startWall + p.start - prevEndWall) / 1000 : 0, fullTarget: p.reps.filter((r) => (r.range ?? "full") === "full").length }));
  prevEndWall = j.startWall + j.parts[j.parts.length - 1]?.end;
}
const fit = fitParams(fs, g, DEFAULT_MODEL);
const p = fit.params;

let state: FatigueState = FRESH;
let lastEnd: number | null = null;
const rows: unknown[] = [];
for (const j of jobs) {
  for (const part of j.parts) {
    const startWall = j.startWall + part.start, endWall = j.startWall + part.end;
    const restS = lastEnd === null ? null : (startWall - lastEnd) / 1000;
    if (restS !== null) state = recover(state, Math.max(0, restS), p);
    const before = state.MR + state.MA;
    const sim = simulateSet(j.act, part.reps, part.weight, p, g, state);
    state = sim.state;
    lastEnd = endWall;
    const row = {
      k: j.k, q: j.q, weight: part.weight, minute: (startWall - jobs[0].startWall) / 60000, restBeforeS: restS, reps: part.reps.length,
      capacityBefore: +before.toFixed(3), strengthLeftEnd: +sim.strengthLeft.toFixed(3), rirModel: +sim.rir.toFixed(1),
      reachedLockout: sim.reps.filter((r) => r.reachedLockout).length, partialTop: sim.reps.filter((r) => r.partialTop).length,
    };
    rows.push(row);
    console.log(row);
  }
}
writeFileSync(outPath, JSON.stringify({ params: { gain: p.gain, F: p.F, R: p.R, loss: fit.loss }, rows }, null, 1));
