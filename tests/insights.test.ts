// Run: npx tsx tests/insights.test.ts
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { envelopeBins, filteredWindow, fitClock } from "../src/core/offline";
import { medianFrequency } from "../src/core/workout";
import { detectTechniques } from "../src/core/technique";
import { anchoredCurve, fitLoadCurve, kgEquivalent, sessionInsights, type RecordingInput } from "../src/core/insights";

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log("ok -", name); };

test("load curve: recovers E0 + k(W+3)^b and inverts to kg", () => {
  const f = (w: number) => 60 + 2 * (w + 3) ** 1.4;
  const pts = [5, 10, 20, 30, 40].flatMap((w) => [0.97, 1, 1.03].map((m) => ({ w, e: f(w) * m })));
  const c = fitLoadCurve(pts)!;
  assert.ok(Math.abs(c.b - 1.4) < 0.25, `b ${c.b}`);
  assert.ok(Math.abs(kgEquivalent(f(25), c) - 25) < 2.5, `kg ${kgEquivalent(f(25), c)}`);
  assert.equal(fitLoadCurve([{ w: 10, e: 100 }, { w: 10, e: 110 }]), null);
  const a = anchoredCurve(20, 200);
  assert.ok(Math.abs(kgEquivalent(200, a) - 20) < 1e-6);
});

/** A synthetic rope recording: reps every 6 s, EMG proportional to effort that grows with fatigue. */
function synth(id: string, startMs: number, w: number, reps: number, fatigue: number, eccArmLeft = false): RecordingInput {
  const fs = 10, T = reps * 6 + 6, t: number[] = [], v: number[] = [];
  for (let i = 0; i < T * fs; i++) { const tt = i / fs; t.push(tt); const ph = ((tt - 3) % 6 + 6) % 6; v.push(tt < 3 || tt > T - 3 ? 0 : ph < 2 ? ph / 2 * 100 : ph < 5 ? 100 - (ph - 2) / 3 * 100 : 0); }
  const env = (side: "left" | "right") => {
    const out = new Float32Array(T * 50);
    for (let k = 0; k < out.length; k++) {
      const tt = k / 50, ph = ((tt - 3) % 6 + 6) % 6, rep = Math.floor((tt - 3) / 6);
      const base = 40 + 4 * (w + 3) ** 1.3 * (1 + fatigue * rep);
      const ecc = ph >= 2 && ph < 5, lr = eccArmLeft && ecc ? (side === "left" ? 1.6 : 0.5) : 1;
      out[k] = tt < 3 || tt > T - 3 ? 4 : ph < 2 ? base * lr : ecc ? base * 0.6 * lr : 6;
    }
    return out;
  };
  return { id, startMs, label: "rope", exercise: "rope pushdown", weightAt: () => w, sides: [{ side: "left", env: env("left") }, { side: "right", env: env("right") }], motion: { t, v, offsetS: -0.13 } };
}

test("session: reps from motion, fatigue shows as rising effort per kg, one-arm eccentric flagged", () => {
  const s = sessionInsights([synth("a", 0, 10, 6, 0), synth("b", 120e3, 20, 6, 0), synth("c", 240e3, 15, 6, 0.02), synth("d", 900e3, 15, 8, 0.05, true)]);
  assert.ok(s.reps.length >= 16, `reps ${s.reps.length}`);
  const r = s.reps[0];
  assert.ok(Math.abs(r.conS - 2) < 0.5 && Math.abs(r.eccS - 3) < 1.0, `con ${r.conS} ecc ${r.eccS}`);
  assert.ok(s.curves.left && s.curves.right);
  assert.ok((s.metrics.eccConRatio ?? 0) > 0.45 && (s.metrics.eccConRatio ?? 1) < 0.8, `ecc/con ${s.metrics.eccConRatio}`);
  const d = s.sets.find((x) => x.rec === "d")!;
  assert.ok((d.eccLR ?? 0) > 2, `eccLR ${d.eccLR}`);
  assert.ok((s.metrics.effortPerKgChangePct ?? 0) > 5, `effort/kg change ${s.metrics.effortPerKgChangePct}`);
});

// ---- regression on the real 26 Sep session (local only) ----
const EXP = `${process.env.HOME}/myolift-data/exp1/experiments`;
const LABELS = "/tmp/claude-1000/-home-mohit/3b339da3-a486-4d8d-8451-d60feabcc24b/scratchpad/analysis26/labels.json";
if (existsSync(EXP) && existsSync(LABELS)) {
  const labels = JSON.parse(readFileSync(LABELS, "utf8"));
  const recs: RecordingInput[] = [];
  for (const k of readdirSync(EXP).sort()) {
    const L = labels[k]; if (!L || L.ex !== "rope" || !existsSync(`${EXP}/${k}/motion.csv`)) continue;
    const meta = JSON.parse(readFileSync(`${EXP}/${k}/experiment.json`, "utf8"));
    const sensors = JSON.parse(readFileSync(`${EXP}/${k}/sensors.json`, "utf8"));
    const sides = sensors.map((s: any) => {
      const bytes = new Uint8Array(readFileSync(`${EXP}/${k}/${s.file}`));
      const fit = fitClock(bytes);
      const side = meta.placements.find((p: any) => p.sensorId === s.id)?.side ?? "left";
      return { side, env: envelopeBins(bytes, fit, { band: "emg", notch: 50 }), mdf: (a: number, b: number) => { const w = filteredWindow(bytes, fit, { band: "emg", notch: 50 }, a * 1000, b * 1000); return medianFrequency(w.v, w.fs); } };
    });
    const rows = readFileSync(`${EXP}/${k}/motion.csv`, "utf8").trim().split("\n").slice(1).map((l) => l.split(",").map(Number));
    recs.push({ id: k.slice(11, 19), startMs: Date.parse(meta.startedAt), label: L.q, exercise: "rope pushdown", weightAt: () => L.weight, segWeights: L.dropWeights,
      sides, motion: { t: rows.map((r) => r[0]), v: rows.map((r) => r[1]), offsetS: meta.video?.offsetS ?? 0 } });
  }
  const t0 = Date.now();
  const s = sessionInsights(recs);
  const m = s.metrics;
  const drop = m.dropSets[0];
  console.log(`   ${s.reps.length} reps in ${s.sets.length} sets, ${Date.now() - t0} ms`);
  console.log(`   effort/kg ${m.effortPerKgFirst?.toFixed(2)} -> ${m.effortPerKgLast?.toFixed(2)} (${m.effortPerKgChangePct?.toFixed(0)}%), NME ${m.nmeChangePer10Min?.toFixed(1)}%/10 min, ${m.nmeChangePer10kEffort?.toFixed(0)}%/10k`);
  console.log(`   ecc/con ${m.eccConRatio?.toFixed(2)}, up ${m.conS?.toFixed(1)} s down ${m.eccS?.toFixed(1)} s, MDF/10 min L ${m.mdfPer10Min.left?.toFixed(1)} R ${m.mdfPer10Min.right?.toFixed(1)}`);
  console.log(`   drop set ${drop?.weights.join("/")} effort/kg ${drop?.effortPerKg.map((v) => v.toFixed(2)).join(" ")} reps ${drop?.reps.join(",")}`);
  const one = s.sets.filter((x) => x.label === "unilateral_ecc").map((x) => x.eccLR?.toFixed(2));
  console.log(`   one-arm ecc sets eccLR ${one.join(", ")}; curves L b ${s.curves.left?.b.toFixed(2)} R b ${s.curves.right?.b.toFixed(2)}`);
  const cards = detectTechniques(s, { labels: Object.fromEntries(recs.map((r) => [r.id, r.label])) });
  for (const c of cards) console.log(`   [${c.verdict}] ${c.title}: ${c.yours}`);
  test("real 26 Sep: technique cards for what was done", () => {
    const keys = cards.map((c) => c.key);
    for (const k of ["one_arm_eccentric", "drop_set", "slow_tempo", "partial_short", "partial_long", "hold_stretch", "hold_lockout", "pushdown_only"]) assert.ok(keys.includes(k), `missing ${k}: ${keys}`);
    assert.ok(cards.every((c) => c.yours && c.source && !/TODO/.test(c.summary)));
  });
  test("real 26 Sep: headline numbers close to the python analysis", () => {
    assert.ok(s.reps.length >= 100 && s.reps.length <= 150, `reps ${s.reps.length} (python 127)`);
    assert.ok(m.eccConRatio! > 0.5 && m.eccConRatio! < 0.72, `ecc/con ${m.eccConRatio} (python 0.61)`);
    assert.ok(Math.abs(m.conS! - 2.0) < 0.6 && Math.abs(m.eccS! - 3.0) < 0.8, `tempo ${m.conS}/${m.eccS} (python 2.0/3.0)`);
    assert.ok(m.effortPerKgChangePct! > 3 && m.effortPerKgChangePct! < 30, `effort/kg ${m.effortPerKgChangePct}% (python ~+12%)`);
    assert.ok(m.nmeChangePer10Min! < 0, `NME ${m.nmeChangePer10Min}%/10 min (python -8%)`);
    assert.ok(drop && drop.weights.length >= 5, "drop set found");
    assert.ok(drop.effortPerKg[drop.effortPerKg.length - 1] > 1.4 * drop.effortPerKg[0], `drop set ${drop.effortPerKg} (python 0.96 -> 1.96)`);
  });
} else console.log("skip real-data regression (no local 26 Sep data)");

console.log(`\n${passed} tests passed`);
