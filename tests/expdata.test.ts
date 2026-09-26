// Run: npx tsx tests/expdata.test.ts
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { buildImport, logEdit, normalizeMeta, pushNotes, removeWeightAt, setWeightAt, shiftRows, undoEdit, undoNotes, weightAt } from "../src/core/expdata";

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log("ok -", name); };

test("old experiment.json gets defaults, weight becomes the timeline", () => {
  const m = normalizeMeta({ id: "x", weight: 36, notes: "hi" } as any);
  assert.deepEqual(m.weights, [{ t: 0, kg: 36 }]);
  assert.deepEqual(m.notesHistory, []);
  assert.equal(m.audio, false);
  assert.equal(normalizeMeta({} as any).notes, "");
});

test("weight timeline: set, replace, remove, lookup", () => {
  let w = setWeightAt([], 0, 36);
  w = setWeightAt(w, 60, 32); w = setWeightAt(w, 120, 27); w = setWeightAt(w, 60.2, 31);
  assert.deepEqual(w.map((x) => x.kg), [36, 31, 27]);
  assert.equal(weightAt(w, 90), 31);
  assert.equal(weightAt(w, 5), 36);
  w = removeWeightAt(w, 1);
  assert.equal(weightAt(w, 90), 36);
});

test("notes changelog merges typing, keeps the original, undo steps back", () => {
  let h = pushNotes([], "orig", "orig a", 10_000);
  h = pushNotes(h, "orig a", "orig ab", 11_000); // typing: merged
  assert.equal(h.length, 2);
  assert.equal(h[0].text, "orig");
  h = pushNotes(h, "orig ab", "orig ab. more", 30_000);
  assert.equal(h.length, 3);
  const u = undoNotes(h)!;
  assert.equal(u.text, "orig ab");
  assert.equal(undoNotes(undoNotes(u.history)!.history), null);
});

test("edit log undo restores the previous value", () => {
  const e = logEdit([], "weights", [{ t: 0, kg: 41 }], [{ t: 0, kg: 27 }], 1);
  const u = undoEdit(e)!;
  assert.equal(u.field, "weights");
  assert.deepEqual(u.value, [{ t: 0, kg: 41 }]);
  assert.equal(u.edits.length, 0);
});

test("import: shifts on the native clock, events in order", () => {
  const base = { title: "t", notes: "", unit: "kg", exercise: { id: "rope", name: "Rope" }, placements: [{ sensorId: "A", muscle: "triceps", side: "left" as const }], calibrations: { "A|triceps|left": { ref: { mvcRms: 1 }, snrDb: 30 } } };
  const r = buildImport([
    { ...base, id: "b", startedAt: "2026-09-26T17:17:00.000Z", originNative: 1_120_000, weights: [{ t: 0, kg: 18 }] },
    { ...base, id: "a", startedAt: "2026-09-26T17:15:00.000Z", originNative: 1_000_000, weights: [{ t: 0, kg: 36 }, { t: 30, kg: 32 }], durationS: 60 },
  ]);
  assert.equal(r.nativeClock, true);
  assert.equal(r.shift.get("a"), 0);
  assert.equal(r.shift.get("b"), 120_000);
  const ws = r.events.filter((e) => e.type === "weight").map((e) => [e.t, e.value]);
  assert.deepEqual(ws, [[0, 36], [30_000, 32], [120_000, 18]]);
  assert.ok(r.events.some((e) => e.type === "calibration"));
});

test("shiftRows moves timestamps and leaves the packet bytes alone", () => {
  const b = new Uint8Array(252 * 2); const v = new DataView(b.buffer);
  v.setFloat64(0, 5, true); v.setFloat64(252, 10, true); b[100] = 7; b[252 + 200] = 9;
  const s = shiftRows(b, 1000); const w = new DataView(s.buffer);
  assert.equal(w.getFloat64(0, true), 1005); assert.equal(w.getFloat64(252, true), 1010);
  assert.equal(s[100], 7); assert.equal(s[452], 9);
  assert.equal(b[100], 7); assert.equal(v.getFloat64(0, true), 5); // input untouched
});

// real experiment.json files (local only; tests/real is gitignored)
const REAL = "tests/real/experiments";
if (existsSync(REAL)) {
  test("all real experiment.json files load with the new defaults", () => {
    const dirs = readdirSync(REAL);
    for (const d of dirs) {
      const m = normalizeMeta(JSON.parse(readFileSync(`${REAL}/${d}/experiment.json`, "utf8")));
      assert.ok(m.startedAt && m.weights.length >= 1 && Array.isArray(m.marks), d);
    }
    const r = buildImport(dirs.map((d) => normalizeMeta(JSON.parse(readFileSync(`${REAL}/${d}/experiment.json`, "utf8"))) as any));
    assert.equal(r.shift.size, dirs.length);
    assert.ok([...r.shift.values()].every((v) => v >= 0 && v < 3 * 3600_000));
  });
}

console.log(`\n${passed} tests passed`);
