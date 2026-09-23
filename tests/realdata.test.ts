// Checks against the user's real recordings (local only: tests/real/ is not committed).
// Run: npx tsx tests/realdata.test.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DIP, DEFAULT_REP, detectSets, movingAverage, type Channel } from "../src/core/workout";
import { countFull, tuneRepParams } from "../src/core/tuning";

const root = "tests/real";
if (!existsSync(join(root, "workouts"))) { console.log("skipped: no local real data"); process.exit(0); }
let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log("ok -", name); };
function channels(wid: string): Channel[] {
  const d = join(root, "workouts", wid);
  const ev = readFileSync(join(d, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const sensors: { id: string; file: string }[] = JSON.parse(readFileSync(join(d, "sensors.json"), "utf8"));
  const pl = ev.find((e: any) => e.type === "placement").placements;
  return sensors.map((s) => {
    const cal = ev.filter((e: any) => e.type === "calibration" && e.sensorId === s.id).pop();
    const b = readFileSync(join(d, s.file.replace(/\.bin$/, ".act")));
    const bins = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
    const v = new Float32Array(bins.length); for (let k = 0; k < v.length; k++) v[k] = (bins[k] * 100) / cal.ref.mvcRms;
    const p = pl.find((x: any) => x.sensorId === s.id);
    return { key: s.id, side: p.side, muscle: p.muscle, ref: cal.ref, act: { t0: 0, v: movingAverage(v, 10) } };
  });
}
const machine = channels("2026-09-23T17-29-54-324Z");
const mSets = detectSets(machine);

test("machine pushdown: peak counting overcounts, dip counting is close to the user's estimate", () => {
  const peaks = mSets.map((s) => countFull(machine, s, DEFAULT_REP));
  const dips = mSets.map((s) => countFull(machine, s, DEFAULT_DIP));
  console.log("   peaks", peaks, "dips (full lockouts)", dips, "user: ~6 and ~2-3");
  assert.ok(dips[0] <= 8 && dips[0] >= 4, `set 1 dips ${dips[0]}`);
  assert.ok(dips[1] <= 4 && dips[1] >= 1, `set 2 dips ${dips[1]}`);
});

test("learning from two corrections reproduces them", () => {
  const t = tuneRepParams(mSets.map((s, i) => ({ channels: machine, span: s, full: [6, 2][i] })), "dip");
  console.log("   learned", t.params, "error", t.error);
  assert.ok(t.error <= 1, `error ${t.error}`);
});

test("rope pushdown unchanged: set 1 about 23 reps incl. partials", () => {
  const rope = channels("2026-09-23T17-17-59-695Z");
  const sets = detectSets(rope);
  console.log("   rope full reps per set", sets.map((s) => countFull(rope, s, DEFAULT_REP)));
  assert.ok(sets.length === 3);
});
console.log(`\n${passed} tests passed`);
