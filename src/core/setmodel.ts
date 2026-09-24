/**
 * Per-set results from the muscle model, the user's reps-left rating, and hard sets.
 *
 * Hard sets (sets within ~0–4 reps of failure) are the best-supported volume measure for muscle
 * growth, so they are the headline. Reps left comes from the user's one-tap rating when there is
 * one (it is also a fitting target for the model), otherwise from the model.
 */
import type { LoggedSet } from "./log";
import {
  classifyHold, DEFAULT_MODEL, FIT_F, FIT_GAINS, FIT_R, fitParams, FRESH, geomFor, holdActivation, recover, simulateSet,
  type FatigueState, type FitSet, type HoldClass, type HoldFeatures, type ModelExercise, type ModelParams, type RepSim,
} from "./musclemodel";
import { ACT_DT, type Activation, type Rep } from "./workout";

/** The rating choices: what the user taps after a set. value = reps left used in the maths. */
export const RIR_CHOICES = [
  { label: "0 left", short: "0", value: 0 },
  { label: "1–2 left", short: "1–2", value: 1.5 },
  { label: "3–4 left", short: "3–4", value: 3.5 },
  { label: "5+ left", short: "5+", value: 6 },
] as const;

export function rirLabel(v: number): string {
  if (v < 0.75) return "0";
  if (v < 2.5) return "1–2";
  if (v <= 4.5) return "3–4";
  return "5+";
}

/** Hard-set weight by reps left (illustrative, shaped like the proximity-to-failure evidence). */
export function hardWeight(rir: number): number {
  if (!(rir === rir)) return 0;
  if (rir <= 1.5) return 1;
  if (rir <= 3) return 0.8;
  if (rir <= 4.5) return 0.5;
  return 0;
}
export const isHard = (rir: number | null | undefined) => rir !== null && rir !== undefined && rir === rir && rir <= 4.5;

export type HoldWhere = "stretch" | "mid" | "lockout";
export interface HoldModel { start: number; end: number; cls: HoldClass; where: HoldWhere }

export interface SetModel {
  exercise: ModelExercise;
  /** strength left at the end of the set, 0..1 */
  strengthLeft: number;
  /** model's reps-in-reserve estimate (null when it can't tell) */
  rirModel: number | null;
  /** the fit had at least one reps-left rating for this exercise: only then is rirModel used for hard sets */
  rirCalibrated: boolean;
  /** seconds under load with the triceps stretched / near lockout / in between (from the simulated angle) */
  tutStretchS: number;
  tutLockoutS: number;
  tutMidS: number;
  holds: HoldModel[];
  params: { gain: number; F: number; R: number };
}

/** Reps left for a set: the user's rating wins, then the model. */
export function effectiveRir(s: Pick<LoggedSet, "rir" | "model">): { rir: number | null; source: "you" | "model" | null } {
  if (s.rir !== undefined && s.rir !== null) return { rir: s.rir, source: "you" };
  const m = s.model?.rirModel;
  // without any rating to anchor the fatigue rates the model's estimate is too uncertain to count
  if (s.model?.rirCalibrated && m !== undefined && m !== null && m === m) return { rir: m, source: "model" };
  return { rir: null, source: null };
}

/** Input for one set: its log entry, the activation used for the model, and features of its holds. */
export interface ModelJob {
  set: LoggedSet;
  act: Activation;
  /** hold features for the main side's holds (same order as its holds), null when unavailable */
  holds: ({ start: number; end: number; features: HoldFeatures } | null)[];
}

const STRETCH_FRAC = 0.6, LOCKOUT_MARGIN = 15;

function whereAt(deg: number, top: number, lockout: number): HoldWhere {
  if (deg >= STRETCH_FRAC * top) return "stretch";
  if (deg <= lockout + LOCKOUT_MARGIN) return "lockout";
  return "mid";
}

function parts(set: LoggedSet): { weight: number; reps: Rep[] }[] {
  const side = [...set.sides].sort((a, b) => b.reps.length - a.reps.length)[0];
  const reps = side?.reps ?? [];
  if (set.segments?.length) return set.segments.map((g) => ({ weight: g.weight, reps: reps.filter((r) => r.start >= g.start - 500 && r.start < g.end) })).filter((p) => p.reps.length);
  return set.weight !== null && reps.length ? [{ weight: set.weight, reps }] : [];
}

/**
 * Fit the model per exercise geometry over the workout's sets (user ratings are fitting targets),
 * then simulate every set in order, carrying fatigue across sets with recovery during rests.
 * Sets without a load model (pull-ups, curls…) and sets without weight get no model.
 */
export function modelWorkout(jobs: ModelJob[], base: ModelParams = DEFAULT_MODEL): Record<string, SetModel> {
  const out: Record<string, SetModel> = {};
  const ok = [...jobs].sort((a, b) => a.set.start - b.set.start).filter((j) => !j.set.assisted && geomFor(j.set.exerciseId, j.set.exerciseName).id !== "generic" && parts(j.set).length);
  const fitted = new Map<ModelExercise, ModelParams>();
  const rated = new Set<ModelExercise>();
  for (const gid of new Set(ok.map((j) => geomFor(j.set.exerciseId, j.set.exerciseName).id))) {
    const js = ok.filter((j) => geomFor(j.set.exerciseId, j.set.exerciseName).id === gid);
    let prevEnd: number | null = null;
    const fs: FitSet[] = [];
    for (const j of js) {
      const ps = parts(j.set);
      ps.forEach((p, k) => fs.push({
        act: j.act, reps: p.reps, weight: p.weight,
        restBeforeS: k ? 0 : prevEnd === null ? undefined : (j.set.start - prevEnd) / 1000,
        fullTarget: k === ps.length - 1 && j.set.edited && !j.set.segments ? j.set.reps : p.reps.filter((r) => (r.range ?? "full") === "full").length,
        rirTarget: k === ps.length - 1 && j.set.rir !== undefined && j.set.rir !== null ? j.set.rir : undefined,
      }));
      prevEnd = j.set.end;
    }
    if (fs.some((f) => f.rirTarget !== undefined)) rated.add(gid);
    try { fitted.set(gid, fastFit(fs, geomFor(js[0].set.exerciseId, js[0].set.exerciseName), base)); } catch { fitted.set(gid, base); }
  }
  let state: FatigueState = FRESH, prevEnd: number | null = null;
  for (const j of ok) {
    const g = geomFor(j.set.exerciseId, j.set.exerciseName);
    const p = fitted.get(g.id) ?? base;
    state = prevEnd === null ? FRESH : recover(state, Math.max(0, (j.set.start - prevEnd) / 1000), p);
    prevEnd = j.set.end;
    try {
      const sims: { sim: RepSim; weight: number }[] = [];
      let rir = NaN;
      for (const part of parts(j.set)) {
        const r = simulateSet(j.act, part.reps, part.weight, p, g, state);
        state = r.state;
        rir = r.rir;
        for (const s of r.reps) sims.push({ sim: s, weight: part.weight });
      }
      let st = 0, lo = 0, mid = 0;
      for (const { sim } of sims) for (const deg of sim.angle) {
        const w = whereAt(deg, g.topDeg, g.lockoutDeg);
        if (w === "stretch") st++; else if (w === "lockout") lo++; else mid++;
      }
      const angleAt = (t: number): { deg: number; weight: number } | null => {
        for (const { sim, weight } of sims) {
          const k0 = sim.start;
          if (t < sim.start || t > sim.end || !sim.angle.length) continue;
          const i = Math.min(sim.angle.length - 1, Math.max(0, Math.round((t - k0) / ACT_DT)));
          return { deg: sim.angle[i], weight };
        }
        return null;
      };
      const holds: HoldModel[] = [];
      for (const h of j.holds) {
        if (!h) continue;
        const at = angleAt((h.start + h.end) / 2);
        const needed = at ? (holdActivation(at.deg, at.weight, g, p) * 100) / Math.max(1e-6, p.gain) : NaN;
        const f = { ...h.features, excessDrive: needed > 0 ? h.features.level / needed : NaN };
        holds.push({ start: h.start, end: h.end, cls: classifyHold(f), where: at ? whereAt(at.deg, g.topDeg, g.lockoutDeg) : "mid" });
      }
      const dt = ACT_DT / 1000;
      out[j.set.id] = {
        exercise: g.id, strengthLeft: sims.length ? sims[sims.length - 1].sim.strengthLeft : state.MR + state.MA,
        rirModel: rir === rir ? Math.round(rir * 10) / 10 : null, rirCalibrated: rated.has(g.id),
        tutStretchS: +(st * dt).toFixed(1), tutLockoutS: +(lo * dt).toFixed(1), tutMidS: +(mid * dt).toFixed(1),
        holds, params: { gain: +p.gain.toFixed(3), F: p.F, R: p.R },
      };
    } catch {
      // a bad set never breaks the rest of the analysis
    }
  }
  return out;
}

/**
 * Coordinate search instead of the full grid (it runs on the phone at the end of a workout):
 * the gain with default fatigue rates first, then the fatigue rates around that gain.
 */
function fastFit(fs: FitSet[], g: ReturnType<typeof geomFor>, base: ModelParams): ModelParams {
  const a = fitParams(fs, g, base, { F: [base.F], R: [FIT_R[1]] }).params;
  const k = FIT_GAINS.findIndex((x) => Math.abs(x - a.gain) < 1e-9);
  const gains = FIT_GAINS.slice(Math.max(0, k - 1), k + 2);
  return fitParams(fs, g, base, { gains: gains.length ? gains : [a.gain], F: FIT_F, R: FIT_R }).params;
}

export interface HardSets { muscle: string; hard: number; sets: number; unrated: number }

/**
 * Hard sets per muscle: each set counts for every muscle it trains, weighted by its reps left
 * (user rating, else model). Sets with no estimate at all are counted as unrated.
 */
export function hardSetsByMuscle(sets: LoggedSet[], musclesOf: (s: LoggedSet) => string[]): HardSets[] {
  const m = new Map<string, HardSets>();
  for (const s of sets) {
    const { rir } = effectiveRir(s);
    for (const mu of new Set(musclesOf(s))) {
      const e = m.get(mu) ?? { muscle: mu, hard: 0, sets: 0, unrated: 0 };
      e.sets++;
      if (rir === null) e.unrated++;
      else e.hard += hardWeight(rir);
      m.set(mu, e);
    }
  }
  return [...m.values()].map((e) => ({ ...e, hard: Math.round(e.hard * 10) / 10 })).sort((a, b) => b.hard - a.hard || b.sets - a.sets);
}
