// Run: npx tsx tests/placement.test.ts
import assert from "node:assert/strict";
import { Chain } from "../src/core/dsp";
import { compare, fingerprint, protocol, type Fingerprint, type StepCapture, type StepId } from "../src/core/placement";

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log("ok -", name); };
const FS = 975;

/**
 * Simulated triceps placement: the sensor picks up three sources with weights that depend on
 * where it sits. Squeeze: triceps both heads; push back: long head strongly, lateral weakly;
 * arm out: deltoid only. Contact adds noise and 50 Hz hum.
 */
interface Pos { lateral: number; long: number; deltoid: number; gain: number; noise: number; hum: number; hfShift?: number }
const POS: Record<string, Pos> = {
  reference: { lateral: 1, long: 0.35, deltoid: 0.05, gain: 1, noise: 3, hum: 0.5 },
  higher: { lateral: 0.8, long: 0.35, deltoid: 0.45, gain: 1, noise: 3, hum: 0.5 },
  outer: { lateral: 1, long: 0.08, deltoid: 0.08, gain: 1, noise: 3, hum: 0.5 },
  inner: { lateral: 0.55, long: 1, deltoid: 0.04, gain: 1, noise: 3, hum: 0.5 },
  rotated: { lateral: 0.45, long: 0.16, deltoid: 0.03, gain: 1, noise: 3, hum: 0.5, hfShift: 0.3 },
  loose: { lateral: 1, long: 0.35, deltoid: 0.05, gain: 0.8, noise: 9, hum: 25 },
};
const ACT: Record<Exclude<StepId, "identify">, { lateral: number; long: number; deltoid: number }> = {
  rest: { lateral: 0, long: 0, deltoid: 0 },
  mvc: { lateral: 1, long: 0.8, deltoid: 0.1 },
  push: { lateral: 0.2, long: 1, deltoid: 0.3 },
  abduct: { lateral: 0.05, long: 0.05, deltoid: 1 },
  raise: { lateral: 0, long: 0, deltoid: 0.6 },
};

function captureAt(pos: Pos, seed: number): Partial<Record<StepId, StepCapture>> {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const g = () => { let v = 0; for (let k = 0; k < 4; k++) v += rnd(); return (v - 2) * 1.73; };
  const out: Partial<Record<StepId, StepCapture>> = {};
  let lp = 0, t = 0;
  for (const step of protocol("triceps")) {
    const chain = new Chain({ band: "emg", notch: 50 }, FS);
    const env: number[] = [], raw: number[] = [];
    const a = ACT[step.id];
    const amp = 150 * pos.gain * (a.lateral * pos.lateral + a.long * pos.long + a.deltoid * pos.deltoid);
    for (let i = 0; i < step.seconds * FS; i++, t++) {
      const n = g();
      lp = (0.6 - (pos.hfShift ?? 0)) * lp + (0.4 + (pos.hfShift ?? 0)) * n;
      const x = (n - lp) * amp * 1.6 + g() * pos.noise + pos.hum * Math.sin((2 * Math.PI * 50 * t) / FS);
      chain.step(x);
      raw.push(x);
      env.push(chain.envelope === chain.envelope ? chain.envelope : 0);
    }
    out[step.id] = { env, raw };
  }
  return out;
}

const fp = (name: string, seed: number) => fingerprint(captureAt(POS[name], seed), FS)!;
const ref: Fingerprint = fp("reference", 1);

test("protocol: 4 steps for triceps, 2 in quick mode", () => {
  assert.deepEqual(protocol("triceps").map((s) => s.id), ["rest", "mvc", "push", "abduct"]);
  assert.equal(protocol("triceps", true).length, 2);
  assert.deepEqual(protocol("biceps").map((s) => s.id), ["rest", "mvc", "raise", "abduct"]);
});

test("same spot again (different day's noise) matches", () => {
  const v = compare(fp("reference", 2), ref);
  assert.equal(v.status, "match", v.messages.join(" | "));
  assert.ok(v.similarity! > 60, `similarity ${v.similarity}`);
});

test("too high: deltoid crosstalk detected", () => {
  const v = compare(fp("higher", 3), ref);
  assert.equal(v.status, "differs");
  assert.ok(v.messages.some((m) => /higher than usual/.test(m)), v.messages.join(" | "));
});

test("more outer / more inner from the long-head response", () => {
  const o = compare(fp("outer", 4), ref), i = compare(fp("inner", 5), ref);
  assert.ok(o.messages.some((m) => /more to the outside/.test(m)), o.messages.join(" | "));
  assert.ok(i.messages.some((m) => /inside/.test(m)), i.messages.join(" | "));
});

test("rotated / moved along the arm: amplitude and frequency change", () => {
  const v = compare(fp("rotated", 6), ref);
  assert.equal(v.status, "differs");
  assert.ok(v.messages.some((m) => /moved along the arm or rotated/.test(m)), v.messages.join(" | "));
});

test("loose strap is reported as contact, not position", () => {
  const v = compare(fp("loose", 7), ref);
  assert.equal(v.status, "contact", v.messages.join(" | "));
});

test("learned offsets: nearest labelled example wins", () => {
  const library = [{ label: "2 cm higher", fp: fp("higher", 8) }, { label: "more outer", fp: fp("outer", 9) }];
  assert.equal(compare(fp("higher", 10), ref, library).closest?.label, "2 cm higher");
  assert.equal(compare(fp("outer", 11), ref, library).closest?.label, "more outer");
  assert.equal(compare(fp("reference", 12), ref, library).closest?.label, "reference");
});

import { defaultStack, parseStack, stepStack } from "../src/core/stack";
test("weight stack: the user's machine and stepping", () => {
  const kg = defaultStack("kg");
  assert.deepEqual(kg.slice(0, 4), [1.1, 3.4, 5.7, 7.9]);
  assert.ok(kg.includes(14.7) && kg.includes(19.3) && kg.includes(44.2), kg.join(","));
  assert.equal(stepStack(kg, 17, 1), 19.3);
  assert.equal(stepStack(kg, 18, -1), 17);
  assert.deepEqual(parseStack("5, 2.5, 10"), [2.5, 5, 10]);
  assert.deepEqual(parseStack("1.1-5.7 step 2.3"), [1.1, 3.4, 5.7]);
});

import { assignArms } from "../src/core/placement";
test("identify arms: the sensor that fired is the left one, swapped if needed", () => {
  const ps = [{ sensorId: "a", muscle: "triceps", side: "left" as const }, { sensorId: "b", muscle: "triceps", side: "right" as const }];
  const env = (hi: string) => new Map([["a", Array(4000).fill(hi === "a" ? 120 : 8)], ["b", Array(4000).fill(hi === "b" ? 120 : 8)]]);
  const same = assignArms(ps, env("a"), FS);
  assert.deepEqual(same.placements.map((p) => p.side), ["left", "right"]);
  assert.ok(same.checks.every((c) => !c.changed));
  const swap = assignArms(ps, env("b"), FS);
  assert.deepEqual(swap.placements.map((p) => p.side), ["right", "left"]);
  assert.ok(swap.checks.every((c) => c.changed));
  const flat = assignArms(ps, new Map([["a", Array(4000).fill(20)], ["b", Array(4000).fill(25)]]), FS);
  assert.deepEqual(flat.unsure, ["triceps"]);
  assert.deepEqual(flat.placements.map((p) => p.side), ["left", "right"]);
});

import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { ZipWriter } from "../src/core/zip";
test("zip writer output passes unzip -t", () => {
  const chunks: Uint8Array[] = [];
  const z = new ZipWriter((c) => chunks.push(c));
  z.add("workouts/a/events.jsonl", new TextEncoder().encode('{"t":1}\n'));
  z.add("workouts/a/S1.bin", Uint8Array.from({ length: 5000 }, (_, i) => i & 255));
  z.add("README.txt", new TextEncoder().encode("µV ✓"));
  const big = Uint8Array.from({ length: 70000 }, (_, i) => (i * 7) & 255);
  let pos = 0;
  z.addChunked("experiments/x/video.mp4", () => { if (pos >= big.length) return null; const c = big.subarray(pos, pos + 16384); pos += c.length; return c; });
  z.finish();
  const f = `${tmpdir()}/myolift-test.zip`;
  writeFileSync(f, Buffer.concat(chunks.map((c) => Buffer.from(c))));
  const out = execSync(`unzip -t ${f}`).toString();
  assert.ok(/No errors detected/.test(out), out);
});

console.log(`\n${passed} tests passed`);
