// Run: npx tsx tests/photo.test.ts   (uses local photos in tests/photos/, not committed)
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import jpeg from "jpeg-js";
import { compareSpots, findSensor } from "../src/core/sensorspot";

const load = (f: string) => { const d = jpeg.decode(readFileSync(f), { useTArray: true }); return { width: d.width, height: d.height, data: d.data }; };
if (!existsSync("tests/photos/s1.jpg")) { console.log("skipped: no local test photos"); process.exit(0); }
let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log("ok -", name); };
const spots = [1, 2, 3, 4].map((i) => findSensor(load(`tests/photos/s${i}.jpg`)));
spots.forEach((s, i) => console.log(`photo ${i + 1}:`, s ? `x ${s.x.toFixed(0)} y ${s.y.toFixed(0)} angle ${s.angle.toFixed(0)}° logo ${s.logoPx.toFixed(0)} px conf ${s.confidence.toFixed(2)}` : "not found"));
test("sensor found in photos 1-3 (logo visible)", () => { for (const s of spots.slice(0, 3)) assert.ok(s && s.confidence > 0.4); });
test("no sensor in photo 4 (behind the arm)", () => assert.equal(spots[3], null));
test("photo 2 sensor is higher than photo 1", () => { const d = compareSpots(spots[1]!, spots[0]!); console.log("   ", d.messages.join(" | ")); assert.ok(d.downMm < 0); });
console.log(`\n${passed} tests passed`);
