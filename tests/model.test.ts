// Run: npx tsx tests/model.test.ts
import assert from "node:assert/strict";
import {
  capacity, classifyHold, DEFAULT_MODEL, fatigueStep, FRESH, GEOMS, holdActivation, holdFeatures, recover, simulateSet,
  trainHoldClassifier, type FatigueState, type HoldClass,
} from "../src/core/musclemodel";
import { ACT_DT, type Rep } from "../src/core/workout";

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log("ok -", name); };
const HZ = 1000 / ACT_DT;

test("fatigue: capacity falls under load and recovers at rest", () => {
  let s: FatigueState = FRESH;
  for (let i = 0; i < 60 * HZ; i++) s = fatigueStep(s, 0.5, DEFAULT_MODEL, 1 / HZ);
  const tired = capacity(s);
  assert.ok(tired < 0.8 && tired > 0.5, `capacity after 60 s at 50%: ${tired}`);
  const rested = capacity(recover(s, 300, DEFAULT_MODEL));
  assert.ok(rested > tired + 0.1, `recovered ${rested} vs ${tired}`);
  // light effort fatigues less
  let l: FatigueState = FRESH;
  for (let i = 0; i < 60 * HZ; i++) l = fatigueStep(l, 0.1, DEFAULT_MODEL, 1 / HZ);
  assert.ok(capacity(l) > tired);
});

/** Synthetic rope pushdown: each rep starts at the low (holding at the top), rises to a lockout squeeze, returns. */
function ropeSet(lows: number[], peak = 0.85, repS = 4) {
  const v: number[] = [], reps: Rep[] = [];
  for (const low of lows) {
    const t0 = v.length * ACT_DT, n = repS * HZ;
    for (let k = 0; k < n; k++) { const x = Math.sin((Math.PI * k) / n) ** 2; v.push(100 * (low + (peak - low) * x)); }
    reps.push({ start: t0, peakT: t0 + (repS / 2) * 1000, end: v.length * ACT_DT, peak: peak * 100, mean: 50, riseS: repS / 2, fallS: repS / 2, valleyBefore: low * 100, valleyAfter: low * 100, range: "full" });
  }
  return { act: { t0: 0, v: Float32Array.from(v) }, reps };
}

test("rope: full reps reach lockout; a raised low is flagged as a partial at the top", () => {
  const W = 8, g = GEOMS.rope_pushdown;
  const hold = holdActivation(g.topDeg, W, g, DEFAULT_MODEL);
  const { act, reps } = ropeSet([hold, hold, hold, hold * 1.9, hold * 1.05]);
  const sim = simulateSet(act, reps, W, DEFAULT_MODEL, g);
  assert.ok(sim.reps.slice(0, 3).every((r) => r.reachedLockout), sim.reps.map((r) => r.endDeg.toFixed(0)).join(","));
  assert.deepEqual(sim.reps.map((r) => r.partialTop), [false, false, false, true, false]);
  assert.ok(sim.reps[3].startDeg < g.topDeg - 20);
  assert.ok(sim.reps.every((r, i) => i === 0 || r.strengthLeft <= sim.reps[i - 1].strengthLeft + 1e-9), "strength only drops within a set");
  assert.ok(sim.rir === sim.rir && sim.rir >= 0);
});

test("rope: a weak squeeze does not reach lockout", () => {
  const W = 8, g = GEOMS.rope_pushdown;
  const hold = holdActivation(g.topDeg, W, g, DEFAULT_MODEL);
  const { act, reps } = ropeSet([hold, hold], hold + 0.02);
  const sim = simulateSet(act, reps, W, DEFAULT_MODEL, g);
  assert.ok(sim.reps.every((r) => !r.reachedLockout), sim.reps.map((r) => r.endDeg.toFixed(0)).join(","));
});

/** Synthetic hold: envelope level (%MVC), optional slow modulation (moving), tremor share in the raw EMG. */
function holdWindow(level: number, opts: { move?: number; tremor?: number; seed?: number } = {}) {
  const fs = 975, secs = 5;
  let s = opts.seed ?? 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5);
  const env: number[] = [], raw: number[] = [];
  for (let i = 0; i < secs * HZ; i++) env.push(level * (1 + (opts.move ?? 0) * Math.sin(2 * Math.PI * 0.5 * (i / HZ))) + rnd() * level * 0.05);
  for (let i = 0; i < secs * fs; i++) {
    const t = i / fs;
    const amp = level * (1 + (opts.move ?? 0) * Math.sin(2 * Math.PI * 0.5 * t)) * (1 + (opts.tremor ?? 0) * Math.sin(2 * Math.PI * 10 * t));
    raw.push(amp * rnd() * 3);
  }
  return { env, raw, fs };
}

test("holds: passive, actively pushing and moving are told apart", () => {
  const p = holdWindow(12, { seed: 2 }), a = holdWindow(70, { tremor: 0.8, seed: 3 }), m = holdWindow(40, { move: 0.6, seed: 4 });
  assert.equal(classifyHold(holdFeatures(p.env, p.raw, p.fs, 10)), "passive");
  assert.equal(classifyHold(holdFeatures(a.env, a.raw, a.fs, 20)), "active");
  assert.equal(classifyHold(holdFeatures(m.env, m.raw, m.fs, 30)), "moving");
  const fa = holdFeatures(a.env, a.raw, a.fs), fp = holdFeatures(p.env, p.raw, p.fs);
  assert.ok(fa.tremor > fp.tremor, `tremor ${fa.tremor} vs ${fp.tremor}`);
});

test("holds: classifier trained on labelled windows", () => {
  const labelled: { features: ReturnType<typeof holdFeatures>; label: HoldClass }[] = [];
  for (let k = 0; k < 4; k++) {
    const p = holdWindow(10 + k, { seed: 10 + k }), a = holdWindow(60 + 5 * k, { tremor: 0.7, seed: 20 + k }), m = holdWindow(35 + k, { move: 0.5, seed: 30 + k });
    labelled.push({ features: holdFeatures(p.env, p.raw, p.fs), label: "passive" }, { features: holdFeatures(a.env, a.raw, a.fs), label: "active" }, { features: holdFeatures(m.env, m.raw, m.fs), label: "moving" });
  }
  const c = trainHoldClassifier(labelled);
  assert.ok(c.accuracy >= 0.9, `accuracy ${c.accuracy}`);
  const t = holdWindow(65, { tremor: 0.7, seed: 99 });
  assert.equal(c.classify(holdFeatures(t.env, t.raw, t.fs)), "active");
});

console.log(`\n${passed} tests passed`);
