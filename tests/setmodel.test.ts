// Run: npx tsx tests/setmodel.test.ts
import assert from "node:assert/strict";
import { buildLog, type LoggedSet, type WorkoutEvent } from "../src/core/log";
import { DEFAULT_MODEL, fitParams, GEOMS, holdActivation } from "../src/core/musclemodel";
import { effectiveRir, hardSetsByMuscle, hardWeight, isHard, modelWorkout, rirLabel, RIR_CHOICES } from "../src/core/setmodel";
import { ACT_DT, type DetectedSet, type Rep } from "../src/core/workout";

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log("ok -", name); };
const HZ = 1000 / ACT_DT;

/** Synthetic rope pushdown reps (same shape as tests/model.test.ts), starting at t0 ms. */
function ropeReps(n: number, low: number, peak: number, t0 = 0, repS = 4) {
  const v: number[] = [], reps: Rep[] = [];
  for (let r = 0; r < n; r++) {
    const s = t0 + v.length * ACT_DT, m = repS * HZ;
    for (let k = 0; k < m; k++) { const x = Math.sin((Math.PI * k) / m) ** 2; v.push(100 * (low + (peak - low) * x)); }
    reps.push({ start: s, peakT: s + (repS / 2) * 1000, end: t0 + v.length * ACT_DT, peak: peak * 100, mean: 50, riseS: repS / 2, fallS: repS / 2, valleyBefore: low * 100, valleyAfter: low * 100, range: "full" });
  }
  return { act: { t0, v: Float32Array.from(v) }, reps };
}

function detected(reps: Rep[]): DetectedSet {
  return {
    start: reps[0].start, end: reps[reps.length - 1].end, reps: reps.length, flags: [],
    sides: [{ key: "s1", side: "left", muscle: "triceps", reps, holds: [], peak: 80, effort: 100, activeS: 20 }],
  };
}

const events = (ex: string, name: string, extra: WorkoutEvent[] = []): WorkoutEvent[] => [
  { t: 0, type: "exercise", exerciseId: ex, name },
  { t: 0, type: "weight", value: 8, unit: "kg" },
  ...extra,
];

test("rating choices, labels and hard-set weights", () => {
  assert.deepEqual(RIR_CHOICES.map((c) => c.value), [0, 1.5, 3.5, 6]);
  assert.deepEqual(RIR_CHOICES.map((c) => rirLabel(c.value)), ["0", "1–2", "3–4", "5+"]);
  assert.deepEqual(RIR_CHOICES.map((c) => hardWeight(c.value)), [1, 1, 0.5, 0]);
  assert.equal(hardWeight(2.5), 0.8);
  assert.ok(isHard(3.5) && !isHard(6) && !isHard(null) && !isHard(NaN));
});

test("a rating is stored as a set edit without marking the set as corrected", () => {
  const { reps } = ropeReps(5, 0.2, 0.8);
  const d = detected(reps);
  const log = buildLog([d], events("Triceps_Pushdown", "Triceps Pushdown", [{ t: 30000, type: "setEdit", setStart: d.start, patch: { rir: 1.5 } }]));
  assert.equal(log[0].rir, 1.5);
  assert.equal(log[0].edited, false);
  const cleared = buildLog([d], events("Triceps_Pushdown", "Triceps Pushdown", [
    { t: 30000, type: "setEdit", setStart: d.start, patch: { rir: 1.5 } },
    { t: 40000, type: "setEdit", setStart: d.start, patch: { rir: null } },
  ]));
  assert.equal(cleared[0].rir, null);
});

test("effective reps left: the user's rating beats the model", () => {
  const base = { rir: undefined, model: undefined } as Pick<LoggedSet, "rir" | "model">;
  assert.deepEqual(effectiveRir(base), { rir: null, source: null });
  const model = { rirModel: 2.2, rirCalibrated: true } as LoggedSet["model"];
  assert.deepEqual(effectiveRir({ ...base, model }), { rir: 2.2, source: "model" });
  // no rating anywhere for this exercise yet: the model's number isn't used
  assert.deepEqual(effectiveRir({ ...base, model: { ...model!, rirCalibrated: false } }), { rir: null, source: null });
  assert.deepEqual(effectiveRir({ rir: 0, model }), { rir: 0, source: "you" });
});

test("hard sets per muscle: weighted by reps left, unrated counted separately", () => {
  const mk = (rir: number | null | undefined, muscle = "triceps") => ({ rir, model: undefined, sides: [{ muscle }] }) as unknown as LoggedSet;
  const rows = hardSetsByMuscle([mk(0), mk(1.5), mk(3.5), mk(6), mk(undefined), mk(0, "biceps")], (s) => s.sides.map((x) => x.muscle));
  const tri = rows.find((r) => r.muscle === "triceps")!;
  assert.equal(tri.sets, 5);
  assert.equal(tri.unrated, 1);
  assert.equal(tri.hard, 2.5);
  assert.equal(rows.find((r) => r.muscle === "biceps")!.hard, 1);
});

test("model per workout: pushdowns get strength left, reps left and time at stretch / lockout; curls get none", () => {
  const g = GEOMS.rope_pushdown, W = 8;
  const hold = holdActivation(g.topDeg, W, g, DEFAULT_MODEL);
  const { act, reps } = ropeReps(8, hold, 0.9);
  const push = buildLog([detected(reps)], events("Triceps_Pushdown", "Triceps Pushdown"))[0];
  const out = modelWorkout([{ set: push, act, holds: [] }]);
  const m = out[push.id];
  assert.ok(m, "pushdown modelled");
  assert.equal(m.exercise, "rope_pushdown");
  assert.ok(m.strengthLeft > 0 && m.strengthLeft < 1, `strength left ${m.strengthLeft}`);
  assert.ok(m.tutStretchS > 0 && m.tutLockoutS > 0, `stretch ${m.tutStretchS} lockout ${m.tutLockoutS}`);
  const curl = buildLog([detected(reps)], events("Barbell_Curl", "Barbell Curl"))[0];
  assert.deepEqual(modelWorkout([{ set: curl, act, holds: [] }]), {});
  // a bad input never throws
  assert.deepEqual(modelWorkout([{ set: { ...push, sides: [] }, act, holds: [] }]), {});
});

test("fitting: a reps-left rating is a target", () => {
  const g = GEOMS.rope_pushdown, W = 8;
  const hold = holdActivation(g.topDeg, W, g, DEFAULT_MODEL);
  const { act, reps } = ropeReps(10, hold, 0.95);
  const near = fitParams([{ act, reps, weight: W, rirTarget: 0 }], g);
  const far = fitParams([{ act, reps, weight: W, rirTarget: 6 }], g);
  assert.ok(near.params.F >= far.params.F, `F near failure ${near.params.F} vs far ${far.params.F}`);
});

console.log(`\n${passed} tests passed`);
