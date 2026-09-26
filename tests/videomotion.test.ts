// Run: npx tsx tests/videomotion.test.ts
// Synthetic checks always run; the real-video checks run only where ~/myolift-data and ffmpeg exist.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { analyseMotion, motionModeFor, peaks, type GrayFrames } from "../src/core/videomotion";

let passed = 0;
const tests: [string, () => Promise<void> | void][] = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

/** Textured background + a textured patch moving vertically along `y(t)`. */
function synthRope(ys: number[], w = 96, h = 160): GrayFrames {
  const tex = (x: number, y: number, s: number) => ((Math.sin(x * 0.9 + s) * Math.cos(y * 0.7 - s) + 1) * 60 + ((x * 7 + y * 13) % 17) * 3) | 0;
  const data = new Uint8Array(ys.length * w * h);
  ys.forEach((py, k) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const inPatch = x >= 30 && x < 62 && y >= py && y < py + 30;
      data[k * w * h + y * w + x] = inPatch ? 120 + tex(x, y - py, 2) : tex(x, y, 0) / 2;
    }
  });
  return { width: w, height: h, data, t: ys.map((_, i) => i / 10) };
}

test("rope: 5 full + 3 half reps of a moving patch", async () => {
  const ys: number[] = [];
  const rep = (amp: number) => { for (let i = 0; i < 30; i++) ys.push(40 + amp * (1 - Math.cos((2 * Math.PI * i) / 30)) / 2); };
  for (let i = 0; i < 10; i++) ys.push(40);
  for (let r = 0; r < 5; r++) rep(60);
  for (let r = 0; r < 3; r++) rep(25);
  for (let i = 0; i < 10; i++) ys.push(40);
  const res = await analyseMotion(synthRope(ys), "rope");
  assert.ok(res.reps.length >= 7 && res.reps.length <= 9, `reps ${res.reps.length}`);
  assert.ok(res.full >= 4 && res.full <= 6, `full ${res.full}`);
  assert.ok(res.partial >= 2, `partial ${res.partial}`);
});

test("scale: 3 cycles of zooming towards a textured ceiling", async () => {
  const w = 96, h = 160, n = 120, data = new Uint8Array(n * w * h);
  const base = (x: number, y: number) => (((Math.sin(x * 0.35) + Math.cos(y * 0.3) + Math.sin((x + y) * 0.17)) * 40 + 128) | 0);
  const t: number[] = [];
  for (let k = 0; k < n; k++) {
    const s = Math.exp(0.25 * (1 - Math.cos((2 * Math.PI * Math.max(0, k - 15)) / 30)) / 2 * (k >= 15 && k < 105 ? 1 : 0));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[k * w * h + y * w + x] = base((x - w / 2) / s + w / 2, (y - h / 4) / s + h / 4);
    t.push(k / 10);
  }
  const res = await analyseMotion({ width: w, height: h, data, t }, "scale");
  assert.equal(res.reps.length, 3, `reps ${res.reps.length}`);
});

test("peaks: prominence and distance", () => {
  const x = [0, 5, 0, 1, 0.8, 1.2, 0, 4, 0];
  assert.deepEqual(peaks(x, 2, 1), [1, 7]);
  assert.deepEqual(peaks(x, 0.5, 1), [1, 5, 7]);
});

test("mode per exercise", () => {
  assert.equal(motionModeFor("Triceps_Pushdown_-_Rope_Attachment", "Triceps Pushdown - Rope Attachment"), "rope");
  assert.equal(motionModeFor("machine_assisted_pullup", "Assisted pull-up machine"), "scale");
  assert.equal(motionModeFor("machine_assisted_dip", "Assisted dip"), "scale");
  assert.equal(motionModeFor("Barbell_Curl", "Barbell Curl"), null);
});

// ---- real videos (local only) ----
const root = `${homedir()}/myolift-data/exp1/experiments/`;
const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
function realFrames(key: string, W = 160): GrayFrames | null {
  if (!hasFfmpeg || !existsSync(root)) return null;
  const d = readdirSync(root).find((x) => x.includes(key));
  if (!d || !existsSync(root + d + "/video.mp4")) return null;
  const out = `${tmpdir()}/myolift-vm-${d}-${W}.gray`;
  if (!existsSync(out)) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", root + d + "/video.mp4", "-vf", `fps=10,scale=${W}:-2`, "-pix_fmt", "gray", "-f", "rawvideo", out]);
  const h = Math.round((W * 1280) / 720 / 2) * 2, data = new Uint8Array(readFileSync(out));
  const n = Math.floor(data.length / (W * h));
  return { width: W, height: h, data, t: Array.from({ length: n }, (_, i) => i / 10) };
}
const real = (key: string, name: string, fn: (f: GrayFrames) => Promise<void>) =>
  test(name, async () => { const f = realFrames(key); if (!f) { console.log("skip -", name, "(no local video)"); passed--; return; } await fn(f); });

real("17-32-55", "real: usual rope set 8 full + 16 half (python: 24 reps, 8 full)", async (f) => {
  const r = await analyseMotion(f, "rope");
  assert.ok(r.reps.length >= 21 && r.reps.length <= 27, `reps ${r.reps.length}`);
  assert.ok(r.full >= 6 && r.full <= 11, `full ${r.full}`);
  console.log(`   ${r.reps.length} reps = ${r.full} full + ${r.partial} partial, ${r.ms} ms for ${f.t.length} frames`);
});
real("17-21-13", "real: top-half partials (python: 11 reps, 8 full)", async (f) => {
  const r = await analyseMotion(f, "rope");
  assert.ok(r.reps.length >= 9 && r.reps.length <= 13, `reps ${r.reps.length}`);
});
real("17-57-51", "real: assisted pull-ups by the machine frame's scale (3–4 reps)", async (f) => {
  const r = await analyseMotion(f, "scale");
  assert.ok(r.reps.length >= 3 && r.reps.length <= 4, `reps ${r.reps.length}`);
});

(async () => {
  for (const [name, fn] of tests) { await fn(); passed++; console.log("ok -", name); }
  console.log(`\n${passed} tests passed`);
})();
