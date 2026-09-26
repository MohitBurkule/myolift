// Run the app's set/rep detector on experiment recordings (envelopes pre-computed in 20 ms bins).
// Usage: npx tsx tools/analyse_experiments.ts <act dir with index.json> <out.json>
// Exercise rule as in the app: machine pushdowns/dips count lockout dips, everything else peaks.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DETECT, DEFAULT_DIP, DEFAULT_REP, detectSets, movingAverage, type Channel } from "../src/core/workout";

const dir = process.argv[2];
const idx: Record<string, { id: string; exercise: { id: string; name: string } | null; sides: Record<string, { file: string; mvcRms: number }> }> =
  JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
const out: Record<string, unknown> = {};
for (const [k, e] of Object.entries(idx)) {
  const channels: Channel[] = [];
  for (const [side, s] of Object.entries(e.sides)) {
    const b = readFileSync(join(dir, "..", s.file));
    const bins = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
    const v = new Float32Array(bins.length);
    for (let i = 0; i < bins.length; i++) v[i] = (bins[i] * 100) / s.mvcRms;
    channels.push({ key: side, side: side as "left" | "right", muscle: "triceps", ref: { mvcRms: s.mvcRms, restRms: 3, restSd: 1 }, act: { t0: 0, v: movingAverage(v, 10) } });
  }
  const n = (e.exercise?.name ?? "").toLowerCase();
  const params = /machine/.test(n) && /push ?down|dip/.test(n) ? DEFAULT_DIP : DEFAULT_REP;
  const sets = detectSets(channels, { ...DEFAULT_DETECT, repParams: () => params });
  out[k] = sets.map((s) => ({
    start: s.start / 1000, end: s.end / 1000,
    reps: (s.sides.find((x) => x.side === "left") ?? s.sides[0]).reps.map((r) => ({ start: r.start / 1000, peakT: r.peakT / 1000, end: r.end / 1000, range: r.range ?? "full", peak: r.peak })),
    holds: s.sides.flatMap((x) => x.holds.map((h) => ({ side: x.side, start: h.start / 1000, end: h.end / 1000, level: h.level, position: h.position }))),
  }));
  const all = (out[k] as { reps: { range: string }[] }[]).flatMap((s) => s.reps);
  const c: Record<string, number> = {};
  for (const r of all) c[r.range] = (c[r.range] ?? 0) + 1;
  console.log(k, `${(out[k] as unknown[]).length} sets`, `${all.length} reps`, JSON.stringify(c));
}
writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
