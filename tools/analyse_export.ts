// Re-run the current detection on an exported MyoLift zip (unzipped folder) and print / dump results.
// Usage: npx tsx tools/analyse_export.ts <unzipped-dir> [out.json]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildLogFull, type WorkoutEvent } from "../src/core/log";
import { ACT_DT, DEFAULT_DETECT, DEFAULT_DIP, DEFAULT_REP, detectSets, movingAverage, type Channel } from "../src/core/workout";

const root = process.argv[2], out: Record<string, unknown> = {};
for (const wid of readdirSync(join(root, "workouts")).sort()) {
  const d = join(root, "workouts", wid);
  const events: WorkoutEvent[] = readFileSync(join(d, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const sensors: { id: string; file: string }[] = JSON.parse(readFileSync(join(d, "sensors.json"), "utf8"));
  const placement = (events.find((e) => e.type === "placement") as any).placements as { sensorId: string; side: "left" | "right"; muscle: string }[];
  const channels: Channel[] = [];
  for (const s of sensors) {
    const cal = [...events].reverse().find((e: any) => e.type === "calibration" && e.sensorId === s.id) as any;
    const p = placement.find((x) => x.sensorId === s.id)!;
    const b = readFileSync(join(d, s.file.replace(/\.bin$/, ".act")));
    const bins = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
    const v = new Float32Array(bins.length);
    for (let k = 0; k < bins.length; k++) v[k] = (bins[k] * 100) / cal.ref.mvcRms;
    channels.push({ key: s.id, side: p.side, muscle: p.muscle, ref: cal.ref, act: { t0: 0, v: movingAverage(v, 10) } });
  }
  // same rule as the app: machine pushdowns count lockout dips
  const exAt = (t: number) => [...events].filter((e: any) => e.type === "exercise" && e.t <= t + 2000).pop() as any;
  const repParams = (t: number) => { const n = (exAt(t)?.name ?? "").toLowerCase(); return /machine/.test(n) && /push ?down|dip/.test(n) ? DEFAULT_DIP : DEFAULT_REP; };
  const sets = detectSets(channels, { ...DEFAULT_DETECT, repParams });
  const log = buildLogFull(sets, events);
  console.log(`== ${wid}`);
  for (const s of log.sets) {
    const sides = s.sides.map((x) => `${x.side[0].toUpperCase()}${x.reps.length}`).join(" ");
    console.log(`  ${(s.start / 1000).toFixed(0).padStart(4)}-${(s.end / 1000).toFixed(0).padEnd(4)}s ${s.exerciseName.slice(0, 22).padEnd(22)} ${String(s.weight).padStart(5)} kg  full ${String(s.reps).padStart(2)} + ${s.partials} partial (${sides})  ranges ${JSON.stringify(s.ranges)}${s.segments ? "  segments " + s.segments.map((g) => `${g.weight}x${g.reps}`).join(" ") : ""}`);
  }
  for (const i of log.ignored) console.log(`  ignored ${(i.start / 1000).toFixed(0)}-${(i.end / 1000).toFixed(0)}s: ${i.reason}`);
  out[wid] = sets;
}
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(out));
void ACT_DT;
