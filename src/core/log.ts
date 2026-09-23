/**
 * Workout log = auto-detected sets + the user's quick inputs, which are timestamped events:
 * exercise picked, weight tapped, sensors moved, calibration, set edits, notes.
 * Nothing is entered per set: a set takes whatever exercise and weight were current when it
 * started. A weight tapped during a set turns it into a drop set.
 */
import type { DetectedSet, Reference, Rep, SideResult } from "./workout";
import type { Fingerprint } from "./placement";

export type Side = "left" | "right";
export type Unit = "kg" | "lb";

export interface Placement {
  sensorId: string;
  sensorName: string;
  muscle: string; // e.g. "triceps"
  side: Side;
}

export type WorkoutEvent =
  | { t: number; type: "exercise"; exerciseId: string; name: string; unilateral?: boolean }
  | { t: number; type: "weight"; value: number; unit: Unit }
  /** grip / attachment, e.g. "Rope", "V-bar", "Straight bar", "Underhand" ("" = none) */
  | { t: number; type: "grip"; grip: string }
  | { t: number; type: "placement"; placements: Placement[] }
  | { t: number; type: "calibration"; sensorId: string; muscle: string; side: Side; ref: Reference; snrDb: number; fingerprint?: Fingerprint; placement?: { status: string; similarity: number | null; messages: string[] } }
  | { t: number; type: "setEdit"; setStart: number; patch: SetPatch }
  | { t: number; type: "note"; text: string }
  | { t: number; type: "photo"; muscle: string; side: Side; uri: string; messages: string[] };

export interface SetPatch {
  deleted?: boolean;
  reps?: number;
  weight?: number;
  exerciseId?: string;
  exerciseName?: string;
  grip?: string;
}

export interface LoggedSet {
  /** stable id: start time rounded to 0.1 s */
  id: string;
  start: number;
  end: number;
  exerciseId: string;
  exerciseName: string;
  grip: string;
  weight: number | null;
  unit: Unit;
  reps: number;
  sides: SideResult[];
  flags: DetectedSet["flags"];
  /** "drop" / "super" when part of a drop set or superset; groupId links the members */
  group: "drop" | "mech" | "super" | null;
  groupId: number | null;
  edited: boolean;
  /** sub-segments when the weight changed mid-set */
  segments?: { weight: number; reps: number; start: number; end: number }[];
}

const DROP_GAP_MS = 15000;
const SUPER_GAP_MS = 25000;
const EDIT_MATCH_MS = 3000;

function lastBefore<T extends WorkoutEvent["type"]>(events: WorkoutEvent[], type: T, t: number): Extract<WorkoutEvent, { type: T }> | undefined {
  let found: any;
  for (const e of events) if (e.type === type && e.t <= t) found = e;
  return found;
}

export function buildLog(detected: DetectedSet[], events: WorkoutEvent[], defaultUnit: Unit = "kg"): LoggedSet[] {
  const evs = [...events].sort((a, b) => a.t - b.t);
  const edits = evs.filter((e): e is Extract<WorkoutEvent, { type: "setEdit" }> => e.type === "setEdit");
  const out: LoggedSet[] = [];
  for (const d of [...detected].sort((a, b) => a.start - b.start)) {
    // an exercise or weight chosen in the first 2 s of a set still applies to it
    const ex = lastBefore(evs, "exercise", d.start + 2000);
    const w = lastBefore(evs, "weight", d.start + 2000);
    const g = lastBefore(evs, "grip", d.start + 2000);
    const set: LoggedSet = {
      id: (Math.round(d.start / 100) / 10).toFixed(1),
      start: d.start, end: d.end,
      exerciseId: ex?.exerciseId ?? "unknown", exerciseName: ex?.name ?? "Unassigned exercise", grip: g?.grip ?? "",
      weight: w?.value ?? null, unit: w?.unit ?? defaultUnit,
      reps: d.reps, sides: d.sides, flags: d.flags, group: null, groupId: null, edited: false,
    };
    // weight tapped mid-set: drop set within the set
    const mid = evs.filter((e): e is Extract<WorkoutEvent, { type: "weight" }> => e.type === "weight" && e.t > d.start + 2000 && e.t < d.end);
    if (mid.length) {
      const cuts = [d.start, ...mid.map((m) => m.t), d.end];
      const weights = [set.weight ?? 0, ...mid.map((m) => m.value)];
      const repsOf = (a: number, b: number) => Math.max(0, ...d.sides.map((s) => s.reps.filter((r: Rep) => r.peakT >= a && r.peakT < b).length));
      set.segments = weights.map((wt, i) => ({ weight: wt, start: cuts[i], end: cuts[i + 1], reps: repsOf(cuts[i], cuts[i + 1]) }));
      set.group = "drop";
    }
    // user corrections
    for (const e of edits) {
      if (Math.abs(e.setStart - d.start) > EDIT_MATCH_MS) continue;
      const p = e.patch;
      set.edited = true;
      if (p.deleted !== undefined) (set as any).deleted = p.deleted;
      if (p.reps !== undefined) set.reps = p.reps;
      if (p.weight !== undefined) set.weight = p.weight;
      if (p.exerciseId) { set.exerciseId = p.exerciseId; set.exerciseName = p.exerciseName ?? set.exerciseName; }
      if (p.grip !== undefined) set.grip = p.grip;
    }
    if (!(set as any).deleted) out.push(set);
  }
  // drop sets and supersets across sets
  let group = 0;
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1], b = out[i], gap = b.start - a.end;
    let kind: "drop" | "mech" | "super" | null = null;
    if (a.exerciseId === b.exerciseId && gap < DROP_GAP_MS && a.weight !== null && b.weight !== null && b.weight < a.weight) kind = "drop";
    // same exercise, grip changed, no rest: mechanical drop set
    else if (a.exerciseId === b.exerciseId && gap < DROP_GAP_MS && a.grip !== b.grip) kind = "mech";
    else if (a.exerciseId !== b.exerciseId && gap < SUPER_GAP_MS) kind = "super";
    if (!kind) continue;
    if (a.groupId === null || a.group !== kind) { a.groupId = ++group; a.group = kind; }
    b.group = kind; b.groupId = a.groupId;
  }
  return out;
}

/** Placement and calibration in force at time t. */
export function stateAt(events: WorkoutEvent[], t: number) {
  const placement = lastBefore(events, "placement", t)?.placements ?? [];
  const refs = new Map<string, Extract<WorkoutEvent, { type: "calibration" }>>();
  for (const e of events) if (e.type === "calibration" && e.t <= t) refs.set(e.sensorId, e);
  return { placement, refs };
}

/** Summary numbers for a set of logged sets (one exercise or a whole workout). */
export function totals(sets: LoggedSet[]) {
  let volume = 0, reps = 0, tut = 0, effort = 0, holds = 0;
  for (const s of sets) {
    reps += s.reps;
    if (s.weight) volume += s.segments ? s.segments.reduce((v, g) => v + g.weight * g.reps, 0) : s.weight * s.reps;
    tut += Math.max(0, ...s.sides.map((x) => x.activeS));
    effort += s.sides.reduce((e, x) => e + x.effort, 0);
    holds += s.sides.reduce((h, x) => h + x.holds.reduce((t, hh) => t + (hh.end - hh.start) / 1000, 0), 0);
  }
  return { sets: sets.length, reps, volume, tutS: tut, effort, holdS: holds };
}
