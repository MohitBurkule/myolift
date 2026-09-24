/** Body measurements log (arm circumference, bodyweight, a fixed-weight rep test), stored in its own JSON file. */
import { useSyncExternalStore } from "react";
import { File, Paths } from "expo-file-system";

export interface Measurement {
  id: string;
  at: string; // ISO
  leftRelaxed?: number; // cm
  rightRelaxed?: number;
  leftFlexed?: number;
  rightFlexed?: number;
  leftForearm?: number;
  rightForearm?: number;
  bodyweight?: number; // kg
  test?: { exercise: string; weight: number; reps: number };
  notes?: string;
}

const file = () => new File(Paths.document, "measurements.json");
let cache: Measurement[] | null = null;
const subs = new Set<() => void>();

export function listMeasurements(): Measurement[] {
  if (!cache) {
    try { cache = JSON.parse(file().textSync()); } catch { cache = []; }
  }
  return cache!;
}

function save(list: Measurement[]) {
  cache = [...list].sort((a, b) => a.at.localeCompare(b.at));
  const f = file();
  if (!f.exists) f.create();
  f.write(JSON.stringify(cache, null, 2));
  subs.forEach((s) => s());
}

export const useMeasurements = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), listMeasurements);
export function addMeasurement(m: Omit<Measurement, "id">) { save([...listMeasurements(), { ...m, id: `${Date.now()}` }]); }
export function deleteMeasurement(id: string) { save(listMeasurements().filter((m) => m.id !== id)); }

/** Days since the last entry (null if none). */
export function daysSinceLast(now = Date.now()): number | null {
  const l = listMeasurements();
  return l.length ? Math.floor((now - new Date(l[l.length - 1].at).getTime()) / 86400000) : null;
}

/** For the export zips. */
export function measurementsJson(): Uint8Array { return new TextEncoder().encode(JSON.stringify(listMeasurements(), null, 2)); }
