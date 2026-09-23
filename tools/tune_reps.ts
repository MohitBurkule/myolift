// Grid-search rep detection settings: real recording counts vs the simulated tests' expectations.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Chain } from "../src/core/dsp";
import { repeat, simulateArm, type SimSet } from "../src/core/sim";
import { detectSets, movingAverage, REP_TUNING, toActivation, type Channel } from "../src/core/workout";

const root = process.argv[2];
function realChannels(wid: string): Channel[] {
  const d = join(root, "workouts", wid);
  const events = readFileSync(join(d, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
  const sensors: { id: string; file: string }[] = JSON.parse(readFileSync(join(d, "sensors.json"), "utf8"));
  const pl = events.find((e: any) => e.type === "placement").placements;
  return sensors.map((s) => {
    const cal = events.filter((e: any) => e.type === "calibration" && e.sensorId === s.id).pop();
    const b = readFileSync(join(d, s.file.replace(/\.bin$/, ".act")));
    const bins = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
    const v = new Float32Array(bins.length); for (let k = 0; k < v.length; k++) v[k] = (bins[k] * 100) / cal.ref.mvcRms;
    const p = pl.find((x: any) => x.sensorId === s.id);
    return { key: s.id, side: p.side, muscle: p.muscle, ref: cal.ref, act: { t0: 0, v: movingAverage(v, 10) } };
  });
}
const FS = 975;
function simPartial() {
  const reps = [...repeat(4, { liftS: 1, lowerS: 1.4, level: 0.7 }), ...repeat(4, { liftS: 0.6, lowerS: 0.7, pauseS: 0.1, level: 0.7, floor: 0.6 }), ...repeat(4, { liftS: 0.6, lowerS: 0.7, level: 0.4 })];
  const raw = simulateArm([{ startS: 5, arms: ["right"], reps }], { side: "right", gain: 1 }, 50, FS, 150, 21);
  const ch = new Chain({ band: "emg", notch: 50 }, FS); const t = new Float64Array(raw.length), e = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) { ch.step(raw[i]); t[i] = i * 1000 / FS; e[i] = ch.envelope; }
  const ref = { restRms: 3, restSd: 1, mvcRms: 150 };
  return [{ key: "R", side: "right" as const, muscle: "t", ref, act: toActivation(t, e, ref) }];
}
const set1 = realChannels("2026-09-23T17-02-29-819Z");
const sim = simPartial();
for (const promFrac of [0.22, 0.26, 0.3, 0.34, 0.38]) for (const sepS of [0.6, 0.8, 1.0, 1.2]) for (const smooth of [8, 12, 18]) {
  Object.assign(REP_TUNING, { promFrac, sepS, smooth, usePeriod: false });
  const real = detectSets(set1)[0];
  const firstHalf = real.sides[0].reps.filter((r) => r.peakT < 125000);
  const full = firstHalf.filter((r) => r.range === "full").length, top = firstHalf.filter((r) => r.range === "top").length;
  const s = detectSets(sim)[0].sides[0].reps;
  console.log(`prom ${promFrac} sep ${sepS} sm ${smooth}: real set1 0-125s ${firstHalf.length} (full ${full}, top ${top})   sim ${s.length}/12 ${s.map((r) => r.range![0]).join("")}`);
}
