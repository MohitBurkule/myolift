// Run: npx tsx tests/workout.test.ts
import assert from "node:assert/strict";
import { Chain } from "../src/core/dsp";
import { repeat, simulateArm, type SimSet } from "../src/core/sim";
import { detectSets, toActivation, type Channel, type Reference } from "../src/core/workout";

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log("ok -", name); };
const FS = 975;

/** raw -> EMG chain -> envelope -> activation, like the app does */
function channel(raw: Float32Array, side: "left" | "right", key: string, ref?: Reference): Channel & { refUsed: Reference } {
  const chain = new Chain({ band: "emg", notch: 50 }, FS);
  const t = new Float64Array(raw.length), env = new Float32Array(raw.length), filt = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) { chain.step(raw[i]); t[i] = (i * 1000) / FS; env[i] = chain.envelope; filt[i] = chain.filtered; }
  // reference: MVC-level envelope measured the way calibration does (simulated 100 % squeeze)
  const r = ref ?? calibrate(side);
  return { key, side, muscle: "triceps", ref: r, refUsed: r, act: toActivation(t, env, r), raw: { t, v: filt, fs: FS } };
}

function calibrate(side: "left" | "right"): Reference {
  const sets: SimSet[] = [{ startS: 3, arms: [side], reps: [{ liftS: 0.2, holdS: 3, lowerS: 0.2, level: 1 }] }];
  const raw = simulateArm(sets, { side, gain: 1 }, 7, FS, 150, 99);
  const chain = new Chain({ band: "emg", notch: 50 }, FS);
  const rest: number[] = [], mvc: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    chain.step(raw[i]);
    const e = chain.envelope, t = i / FS;
    if (e !== e) continue;
    if (t > 0.5 && t < 2.8) rest.push(e);
    if (t > 3.4 && t < 6) mvc.push(e);
  }
  const m = rest.reduce((a, b) => a + b, 0) / rest.length;
  const sd = Math.sqrt(rest.reduce((a, b) => a + (b - m) ** 2, 0) / rest.length);
  mvc.sort((a, b) => a - b);
  return { restRms: m, restSd: sd, mvcRms: mvc[Math.floor(0.95 * mvc.length)] };
}

test("bilateral pushdowns: 3 sets, rep counts per arm, weaker left arm flagged", () => {
  const sets: SimSet[] = [
    { startS: 5, arms: ["left", "right"], reps: repeat(10, { liftS: 1, lowerS: 1.5, level: 0.6 }) },
    { startS: 60, arms: ["left", "right"], reps: repeat(8, { liftS: 1, lowerS: 1.5, level: 0.7 }) },
    { startS: 110, arms: ["left", "right"], reps: repeat(12, { liftS: 0.8, lowerS: 1.2, level: 0.5 }) },
  ];
  const secs = 150;
  const L = channel(simulateArm(sets, { side: "left", gain: 0.7 }, secs, FS, 150, 1), "left", "L", calibrate("right"));
  const R = channel(simulateArm(sets, { side: "right", gain: 1 }, secs, FS, 150, 2), "right", "R");
  const found = detectSets([L, R]);
  assert.equal(found.length, 3, `sets ${found.length}`);
  assert.deepEqual(found.map((s) => s.sides.map((x) => x.reps.length)), [[10, 10], [8, 8], [12, 12]]);
  assert.ok(Math.abs(found[0].start / 1000 - 5) < 1.5, `set 1 starts ${found[0].start / 1000}`);
  assert.ok(found[0].flags.some((f) => /left arm \d+% weaker/.test(f.text)), JSON.stringify(found[0].flags));
});

test("one arm at a time: separate left and right sets", () => {
  const sets: SimSet[] = [
    { startS: 5, arms: ["left"], reps: repeat(8, { liftS: 1, lowerS: 1.2, level: 0.6 }) },
    { startS: 30, arms: ["right"], reps: repeat(8, { liftS: 1, lowerS: 1.2, level: 0.6 }) },
  ];
  const L = channel(simulateArm(sets, { side: "left", gain: 1 }, 60, FS, 150, 3), "left", "L");
  const R = channel(simulateArm(sets, { side: "right", gain: 1 }, 60, FS, 150, 4), "right", "R");
  const found = detectSets([L, R]);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((s) => [s.sides.length, s.sides[0].side, s.reps]), [[1, "left", 8], [1, "right", 8]]);
});

test("slow reps with holds: counted once each, holds found at the top", () => {
  const sets: SimSet[] = [{ startS: 5, arms: ["right"], reps: repeat(6, { liftS: 2, holdS: 2, lowerS: 3, pauseS: 0.5, level: 0.7 }) }];
  const R = channel(simulateArm(sets, { side: "right", gain: 1 }, 60, FS, 150, 5), "right", "R");
  const [set] = detectSets([R]);
  assert.equal(set.reps, 6);
  const side = set.sides[0];
  assert.ok(side.holds.length >= 5, `holds ${side.holds.length}`);
  assert.ok(side.holds.every((h) => h.position === "top"));
  assert.ok(set.flags.some((f) => f.kind === "good" && /controlled tempo/.test(f.text)), JSON.stringify(set.flags));
});

test("fatigue lowers median frequency and is flagged", () => {
  const sets: SimSet[] = [{ startS: 5, arms: ["right"], fatigue: 1, reps: repeat(15, { liftS: 1, lowerS: 1.5, level: 0.8 }, 0.45) }];
  const R = channel(simulateArm(sets, { side: "right", gain: 1 }, 60, FS, 150, 6), "right", "R");
  const [set] = detectSets([R]);
  const s = set.sides[0];
  assert.ok(s.mdfStart! > s.mdfEnd!, `mdf ${s.mdfStart} -> ${s.mdfEnd}`);
  assert.ok(set.flags.some((f) => /fatigue/.test(f.text)), JSON.stringify(set.flags));
  assert.ok(set.flags.some((f) => /activation fell/.test(f.text)), JSON.stringify(set.flags));
});

test("rest and fidgeting produce no sets", () => {
  const sets: SimSet[] = [{ startS: 10, arms: ["right"], reps: [{ liftS: 0.3, lowerS: 0.3, level: 0.25 }] }];
  const R = channel(simulateArm(sets, { side: "right", gain: 1 }, 40, FS, 150, 7), "right", "R");
  assert.equal(detectSets([R]).length, 0);
});



import { buildLog, type WorkoutEvent } from "../src/core/log";
test("log: sticky exercise/weight, mid-set drop, superset, edits", () => {
  const mk = (start: number, end: number, reps: number) => ({
    start: start * 1000, end: end * 1000, reps, flags: [],
    sides: [{ key: "R", side: "right" as const, muscle: "triceps", holds: [], peak: 50, effort: 100, activeS: end - start,
      reps: Array.from({ length: reps }, (_, i) => ({ start: 0, end: 0, peak: 50, mean: 30, riseS: 1, fallS: 1, peakT: (start + ((i + 0.5) * (end - start)) / reps) * 1000 })) }],
  });
  const detected = [mk(10, 40, 10), mk(100, 130, 10), mk(135, 150, 6), mk(200, 230, 8), mk(240, 260, 8)];
  const ev: WorkoutEvent[] = [
    { t: 0, type: "exercise", exerciseId: "pushdown", name: "Pushdown" },
    { t: 1000, type: "weight", value: 30, unit: "kg" },
    { t: 115000, type: "weight", value: 25, unit: "kg" },       // mid set 2 -> drop within set
    { t: 132000, type: "weight", value: 20, unit: "kg" },       // before set 3, no rest -> drop set
    { t: 190000, type: "exercise", exerciseId: "curl", name: "Curl" },
    { t: 232000, type: "exercise", exerciseId: "pushdown", name: "Pushdown" }, // superset
    { t: 300000, type: "setEdit", setStart: 40000 * 5, patch: { reps: 9 } },
  ];
  const log = buildLog(detected, ev);
  assert.deepEqual(log.map((s) => [s.exerciseName, s.weight, s.reps, s.group]), [
    ["Pushdown", 30, 10, null], ["Pushdown", 30, 10, "drop"], ["Pushdown", 20, 6, "drop"], ["Curl", 20, 9, "super"], ["Pushdown", 20, 8, "super"],
  ]);
  assert.deepEqual(log[1].segments!.map((g) => [g.weight, g.reps]), [[30, 5], [25, 5]]);
  assert.ok(log[3].edited);
});

import { envelopeBins, filteredWindow, fitClock } from "../src/core/offline";
import { medianFrequency, movingAverage, ACT_DT } from "../src/core/workout";
import { ROW_BYTES, PER_PACKET, UV_PER_LSB } from "../src/core/protocol";

/** raw µV -> stored rows (float64 ms + 244-byte packet), with BLE arrival jitter */
function toRows(raw: Float32Array, module: number, fs = 975): Uint8Array {
  const n = Math.floor(raw.length / PER_PACKET), out = new Uint8Array(n * ROW_BYTES), dv = new DataView(out.buffer);
  for (let p = 0; p < n; p++) {
    const o = p * ROW_BYTES;
    dv.setFloat64(o, ((p + 1) * PER_PACKET * 1000) / fs + 5 + ((p * 7919) % 25), true);
    out[o + 8] = module; out[o + 9] = p & 255; out[o + 10] = (p >> 8) & 255; out[o + 11] = (p >> 16) & 255;
    dv.setUint16(o + 12, 6800, true);
    for (let i = 0; i < PER_PACKET; i++) dv.setUint16(o + 14 + i * 2, Math.max(0, Math.min(16383, Math.round(8192 + raw[p * PER_PACKET + i] / UV_PER_LSB))), true);
  }
  return out;
}

test("offline: recorded rows -> clock fit -> bins -> sets, reps and fatigue", () => {
  const sets: SimSet[] = [
    { startS: 5, arms: ["left", "right"], fatigue: 1, reps: repeat(12, { liftS: 1, lowerS: 1.5, level: 0.7 }, 0.45) },
    { startS: 70, arms: ["left", "right"], reps: repeat(8, { liftS: 1.5, holdS: 2, lowerS: 2.5, level: 0.6 }) },
  ];
  const chans = (["left", "right"] as const).map((side, i) => {
    const bytes = toRows(simulateArm(sets, { side, gain: 1 }, 135, FS, 150, 11 + i), i + 1);
    const fit = fitClock(bytes);
    assert.ok(Math.abs(fit.fs - FS) < 3, `fs ${fit.fs}`);
    const bins = envelopeBins(bytes, fit, { band: "emg", notch: 50 });
    const ref = calibrate(side);
    const v = new Float32Array(bins.length);
    for (let k = 0; k < bins.length; k++) v[k] = (bins[k] * 100) / ref.mvcRms;
    return { ch: { key: side, side, muscle: "triceps", ref, act: { t0: 0, v: movingAverage(v, 10) } } as Channel, bytes, fit };
  });
  const found = detectSets(chans.map((c) => c.ch));
  assert.deepEqual(found.map((s) => s.sides.map((x) => x.reps.length)), [[12, 12], [8, 8]]);
  assert.ok(found[1].sides.every((s) => s.holds.length >= 6), "holds in set 2");
  // pass 2: per-rep median frequency from the filtered window
  const right = chans[1], side = found[0].sides.find((s) => s.side === "right")!;
  const win = filteredWindow(right.bytes, right.fit, { band: "emg", notch: 50 }, found[0].start, found[0].end);
  const mdfs = side.reps.map((r) => {
    const a = win.t.findIndex((x) => x >= r.start), b = win.t.findIndex((x) => x >= r.end);
    return medianFrequency(win.v.subarray(a, b < 0 ? win.v.length : b), win.fs);
  });
  assert.ok(mdfs[0] > mdfs[mdfs.length - 1] * 1.1, `mdf ${mdfs.map((m) => m.toFixed(0)).join(" ")}`);
  void ACT_DT;
});

test("partial reps: full, top-half and bottom-half reps counted and classified", () => {
  const full = { liftS: 1, lowerS: 1.4, level: 0.7 };
  const reps = [
    ...repeat(4, full),
    ...repeat(4, { liftS: 0.6, lowerS: 0.7, pauseS: 0.1, level: 0.7, floor: 0.6 }),  // top half: never relaxes
    ...repeat(4, { liftS: 0.6, lowerS: 0.7, level: 0.4 }),                        // bottom half: never reaches the top
  ];
  const sets: SimSet[] = [{ startS: 5, arms: ["right"], reps }];
  const R = channel(simulateArm(sets, { side: "right", gain: 1 }, 50, FS, 150, 21), "right", "R");
  const [set] = detectSets([R]);
  const got = set.sides[0].reps.map((r) => r.range);
  assert.equal(got.length, 12, `reps ${got.length}: ${got.join(",")}`);
  assert.deepEqual(got.slice(0, 4), ["full", "full", "full", "full"], got.join(","));
  assert.ok(got.slice(5, 8).every((g) => g === "top"), got.join(","));
  assert.ok(got.slice(9).every((g) => g === "bottom"), got.join(","));
});

import { buildLogFull } from "../src/core/log";
test("log: paused and one-arm movements are ignored for both-arms exercises", () => {
  const side = (sd: "left" | "right") => ({ key: sd, side: sd, muscle: "triceps", holds: [], peak: 40, effort: 80, activeS: 10,
    reps: [0, 1, 2].map((i) => ({ start: 0, end: 0, peak: 40, mean: 20, riseS: 1, fallS: 1, peakT: i * 1000 })) });
  const set = (a: number, sides: ("left" | "right")[]) => ({ start: a * 1000, end: (a + 10) * 1000, reps: 3, flags: [], sides: sides.map(side) });
  const placement = { t: 0, type: "placement" as const, placements: [
    { sensorId: "left", sensorName: "1", muscle: "triceps", side: "left" as const }, { sensorId: "right", sensorName: "2", muscle: "triceps", side: "right" as const }] };
  const ev: WorkoutEvent[] = [placement, { t: 0, type: "exercise", exerciseId: "rope", name: "Rope" },
    { t: 50000, type: "pause", paused: true }, { t: 80000, type: "pause", paused: false },
    { t: 150000, type: "exercise", exerciseId: "kick", name: "Kickback", unilateral: true }];
  const r = buildLogFull([set(10, ["left", "right"]), set(30, ["left"]), set(60, ["left", "right"]), set(100, ["left", "right"]), set(160, ["right"])], ev);
  assert.deepEqual(r.sets.map((s) => s.start / 1000), [10, 100, 160]);
  assert.deepEqual(r.ignored.map((i) => i.reason), ["only the left arm moved", "paused"]);
});
console.log(`\n${passed} tests passed`);
