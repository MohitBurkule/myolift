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
  /** unilateral: one arm at a time (single-arm sets count); assisted: weight is assistance (not load) */
  | { t: number; type: "exercise"; exerciseId: string; name: string; unilateral?: boolean; assisted?: boolean }
  /** while paused nothing counts as a set (drinking, adjusting the machine…) */
  | { t: number; type: "pause"; paused: boolean }
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
  /** weight is assistance (assisted pull-up machine): not counted as load */
  assisted: boolean;
  unilateral: boolean;
  /** full reps (partials are counted separately) */
  reps: number;
  partials: number;
  /** estimated range of each rep (side with most reps) */
  ranges: { full: number; top: number; bottom: number; mid: number };
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

export interface Ignored { start: number; end: number; reason: string }

export function buildLog(detected: DetectedSet[], events: WorkoutEvent[], defaultUnit: Unit = "kg"): LoggedSet[] {
  return buildLogFull(detected, events, defaultUnit).sets;
}

function pausedAt(evs: WorkoutEvent[], t: number) {
  return lastBefore(evs, "pause", t)?.paused ?? false;
}

/** Log plus the movements that were not counted (paused, one arm during a both-arms exercise). */
export function buildLogFull(detected: DetectedSet[], events: WorkoutEvent[], defaultUnit: Unit = "kg"): { sets: LoggedSet[]; ignored: Ignored[] } {
  const evs = [...events].sort((a, b) => a.t - b.t);
  const ignored: Ignored[] = [];
  const edits = evs.filter((e): e is Extract<WorkoutEvent, { type: "setEdit" }> => e.type === "setEdit");
  const out: LoggedSet[] = [];
  for (const d of [...detected].sort((a, b) => a.start - b.start)) {
    // an exercise or weight chosen in the first 2 s of a set still applies to it
    const ex = lastBefore(evs, "exercise", d.start + 2000);
    if (pausedAt(evs, d.start) && pausedAt(evs, d.end)) { ignored.push({ start: d.start, end: d.end, reason: "paused" }); continue; }
    // both-arms exercise but only one arm moved (e.g. lifting a bottle): not a set
    const placed = lastBefore(evs, "placement", d.start)?.placements ?? [];
    const bothPlaced = placed.some((p) => p.side === "left") && placed.some((p) => p.side === "right");
    if (bothPlaced && !ex?.unilateral && d.sides.length === 1) { ignored.push({ start: d.start, end: d.end, reason: `only the ${d.sides[0].side} arm moved` }); continue; }
    const main = [...d.sides].sort((x, y) => y.reps.length - x.reps.length)[0];
    const ranges = { full: 0, top: 0, bottom: 0, mid: 0 };
    for (const r of main?.reps ?? []) ranges[r.range ?? "full"]++;
    const w = lastBefore(evs, "weight", d.start + 2000);
    const g = lastBefore(evs, "grip", d.start + 2000);
    const set: LoggedSet = {
      id: (Math.round(d.start / 100) / 10).toFixed(1),
      start: d.start, end: d.end,
      exerciseId: ex?.exerciseId ?? "unknown", exerciseName: ex?.name ?? "Unassigned exercise", grip: g?.grip ?? "",
      weight: w?.value ?? null, unit: w?.unit ?? defaultUnit,
      assisted: !!ex?.assisted, unilateral: !!ex?.unilateral, ranges,
      reps: ranges.full, partials: ranges.top + ranges.bottom + ranges.mid, sides: d.sides, flags: d.flags, group: null, groupId: null, edited: false,
    };
    // weight tapped mid-set: drop set within the set
    const mid = evs.filter((e): e is Extract<WorkoutEvent, { type: "weight" }> => e.type === "weight" && e.t > d.start + 2000 && e.t < d.end);
    if (mid.length) {
      const cuts = [d.start, ...mid.map((m) => m.t), d.end];
      const weights = [set.weight ?? 0, ...mid.map((m) => m.value)];
      const repsOf = (a: number, b: number) => Math.max(0, ...d.sides.map((s) => s.reps.filter((r: Rep) => r.peakT >= a && r.peakT < b && (r.range ?? "full") === "full").length));
      // quick successive taps (14.7 -> 12.7 -> 10.7) leave empty segments: keep only the ones with reps
      set.segments = weights.map((wt, i) => ({ weight: wt, start: cuts[i], end: cuts[i + 1], reps: repsOf(cuts[i], cuts[i + 1]) })).filter((g) => g.reps > 0);
      if (set.segments.length < 2) { if (set.segments.length === 1) set.weight = set.segments[0].weight; set.segments = undefined; }
      else set.group = "drop";
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
  const sets = out;
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
  return { sets, ignored };
}

/**
 * Did the sets go well above the calibrated maximum? Then the calibration squeeze was weak and
 * every % is inflated. Returns the highest mean rep peak per side, in % of the calibration.
 */
export function calibrationHeadroom(sets: LoggedSet[]): { side: Side; muscle: string; peak: number }[] {
  const best = new Map<string, { side: Side; muscle: string; peak: number }>();
  for (const s of sets) for (const x of s.sides) {
    const k = x.side + x.muscle;
    if (!best.has(k) || best.get(k)!.peak < x.peak) best.set(k, { side: x.side, muscle: x.muscle, peak: x.peak });
  }
  return [...best.values()].filter((b) => b.peak > 110);
}

/** Placement and calibration in force at time t. */
export function stateAt(events: WorkoutEvent[], t: number) {
  const placement = lastBefore(events, "placement", t)?.placements ?? [];
  const refs = new Map<string, Extract<WorkoutEvent, { type: "calibration" }>>();
  for (const e of events) if (e.type === "calibration" && e.t <= t) refs.set(e.sensorId, e);
  return { placement, refs };
}

/** Summary numbers for a set of logged sets (one exercise or a whole workout). */
/**
 * EMG load of a set: weight × area under the activation curve (%MVC·s / 100), summed over the
 * arms that worked. Unlike weight × reps it rewards slow reps, holds and time under tension,
 * and it is 0 for reps that barely used the measured muscle. Units: kg·s at 100 % activation.
 */
export function emgLoad(s: LoggedSet): number {
  if (!s.weight || s.assisted) return 0;
  return s.sides.reduce((a, x) => a + (s.weight! * x.effort) / 100, 0);
}

export function totals(sets: LoggedSet[]) {
  let volume = 0, reps = 0, tut = 0, effort = 0, holds = 0, load = 0;
  for (const s of sets) {
    load += emgLoad(s);
    reps += s.reps;
    if (s.weight && !s.assisted) volume += s.segments ? s.segments.reduce((v, g) => v + g.weight * g.reps, 0) : s.weight * s.reps;
    tut += Math.max(0, ...s.sides.map((x) => x.activeS));
    effort += s.sides.reduce((e, x) => e + x.effort, 0);
    holds += s.sides.reduce((h, x) => h + x.holds.reduce((t, hh) => t + (hh.end - hh.start) / 1000, 0), 0);
  }
  return { sets: sets.length, reps, volume, tutS: tut, effort, holdS: holds, emgLoad: load };
}
