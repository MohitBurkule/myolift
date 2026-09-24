/**
 * Biophysical elbow-extensor model: EMG drive -> muscle fatigue state -> triceps torque -> elbow angle.
 *
 *  1. Fatigue / recovery: Xia & Frey-Law (2008) three-compartment motor-unit model. Motor units are
 *     resting (MR), active (MA) or fatigued (MF); a controller recruits toward the target load (the
 *     EMG drive), active units fatigue at rate F and fatigued units recover at rate R. Capacity =
 *     MA + MR = 1 - MF is the strength left.
 *  2. Hill-type muscle: torque = Tmax * activation * force-length(angle) * force-velocity + passive.
 *     Force per unit drive also drops as the muscle fatigues, so the same load needs more EMG late in a set.
 *  3. Elbow mechanics: forearm + load inertia, the exercise's load torque curve, forearm gravity,
 *     joint stops at full extension and full flexion.
 *
 * Angles are elbow FLEXION in degrees: 0 = arm locked out straight, ~95 = top of a pushdown.
 * Everything here is pure TS so it runs in the app, the tests and the tools.
 */
import { ACT_DT, medianFrequency, type Activation, type Rep } from "./workout";

const G = 9.81, D2R = Math.PI / 180;

export type ModelExercise = "rope_pushdown" | "machine_pushdown" | "generic";

export interface ModelParams {
  /** maximal isometric elbow-extension torque at the optimal angle, N·m */
  tmax: number;
  /** activation = gain * (%MVC / 100); > 1 when the calibration squeeze was weaker than working effort */
  gain: number;
  /** fatigue rate of active motor units, 1/s */
  F: number;
  /** recovery rate of fatigued motor units, 1/s */
  R: number;
  /** how much force per unit drive falls with fatigue (0 = none, 1 = in proportion to capacity lost) */
  peripheral: number;
}

export const DEFAULT_MODEL: ModelParams = { tmax: 70, gain: 1, F: 0.01, R: 0.002, peripheral: 0.5 };

/** Exercise geometry and load curve. */
export interface ExerciseGeom {
  id: ModelExercise;
  /** effective lever from elbow to hand / handle, m */
  lever: number;
  /** cable or lever direction offset: load torque = W·g·lever·sin(angle + phi) */
  phiDeg: number;
  /** usual top-of-rep angle for a full rep, deg of flexion */
  topDeg: number;
  /** rep reference point: "top" = starts at the low-activation turnaround at the top (rope);
   *  "lockout" = the low activation is at lockout (machine, the joint stop takes the load) */
  anchor: "top" | "lockout";
  /** extension counted as reaching lockout, deg */
  lockoutDeg: number;
}

export const GEOMS: Record<ModelExercise, ExerciseGeom> = {
  // the pulley sits above and slightly in front, so the cable still loads the triceps at lockout
  rope_pushdown: { id: "rope_pushdown", lever: 0.3, phiDeg: 15, topDeg: 95, anchor: "top", lockoutDeg: 12 },
  // lever arm machine: load torque vanishes toward lockout, the triceps relax there
  machine_pushdown: { id: "machine_pushdown", lever: 0.3, phiDeg: 0, topDeg: 90, anchor: "lockout", lockoutDeg: 12 },
  generic: { id: "generic", lever: 0.3, phiDeg: 10, topDeg: 90, anchor: "top", lockoutDeg: 12 },
};

export function geomFor(exerciseId: string, name = ""): ExerciseGeom {
  const n = `${exerciseId} ${name}`.toLowerCase();
  if (/machine/.test(n) && /push ?down|press ?down|dip/.test(n)) return GEOMS.machine_pushdown;
  if (/push ?down|press ?down/.test(n)) return GEOMS.rope_pushdown;
  return GEOMS.generic;
}

// ---------- 1. fatigue / recovery ----------

export interface FatigueState { MA: number; MF: number; MR: number }
export const FRESH: FatigueState = { MA: 0, MF: 0, MR: 1 };
const LD = 10, LR = 10; // controller gains (1/s), Xia & Frey-Law

/** One step of the three-compartment model toward target load TL (0..1) over dt seconds. */
export function fatigueStep(s: FatigueState, TL: number, p: Pick<ModelParams, "F" | "R">, dt: number): FatigueState {
  let C: number;
  if (s.MA < TL) C = s.MR > TL - s.MA ? LD * (TL - s.MA) : LD * s.MR;
  else C = LR * (TL - s.MA);
  let MA = s.MA + (C - p.F * s.MA) * dt;
  let MF = s.MF + (p.F * s.MA - p.R * s.MF) * dt;
  MA = Math.min(1, Math.max(0, MA));
  MF = Math.min(1 - MA, Math.max(0, MF));
  return { MA, MF, MR: Math.max(0, 1 - MA - MF) };
}

/** Rest for `seconds` (no drive): fatigued units recover. Closed form of the TL = 0 case after MA decays. */
export function recover(s: FatigueState, seconds: number, p: Pick<ModelParams, "R">): FatigueState {
  // active units stop within a fraction of a second (controller), then fatigued ones recover
  const MF = s.MF * Math.exp(-p.R * seconds);
  return { MA: 0, MF, MR: 1 - MF };
}

export const capacity = (s: FatigueState) => 1 - s.MF;

// ---------- 2. Hill-type muscle ----------

/** Elbow-extension strength vs flexion: best around 85°, ~55% of that when locked out (triceps short). */
export const forceLength = (deg: number) => Math.exp(-(((deg - 85) / 110) ** 2));

const VMAX = 14; // rad/s maximal shortening velocity of the elbow extensors
/** Force-velocity: > 1 lengthening (eccentric), 1 isometric, < 1 shortening (concentric). w = extension velocity, rad/s. */
export function forceVelocity(w: number): number {
  if (w >= 0) { const v = Math.min(w / VMAX, 1); return (1 - v) / (1 + v / 0.25); }
  const v = -w / VMAX;
  return 1.8 - 0.8 / (1 + v / 0.18);
}

/** Passive stretch torque of the triceps at deep flexion (acts toward extension), N·m. */
export const passiveTorque = (deg: number) => (deg > 115 ? 2 * (Math.exp((deg - 115) / 12) - 1) : 0);

/** Activation actually delivered: what the active units can do, less the fatigue loss in force per drive. */
export function effectiveActivation(s: FatigueState, TL: number, p: Pick<ModelParams, "peripheral">): number {
  return Math.min(s.MA, TL + 0.02) * (1 - p.peripheral * (1 - capacity(s)));
}

export function muscleTorque(deg: number, wExt: number, a: number, p: Pick<ModelParams, "tmax">): number {
  return p.tmax * a * forceLength(deg) * forceVelocity(wExt) + passiveTorque(deg);
}

// ---------- 3. elbow mechanics ----------

const FOREARM_KG = 1.6, FOREARM_COM = 0.16, FOREARM_I = 0.07;

/** Torque bending the elbow (flexion positive) from the load, minus forearm gravity (which helps extension). */
export function loadTorque(deg: number, weightKg: number, g: ExerciseGeom): number {
  return weightKg * G * g.lever * Math.sin((deg + g.phiDeg) * D2R) - FOREARM_KG * G * FOREARM_COM * Math.sin(deg * D2R);
}

const inertia = (weightKg: number, g: ExerciseGeom) => FOREARM_I + weightKg * g.lever * g.lever;

/** Joint stops: stiff spring past full extension (0°) and full flexion (140°), flexion-positive torque. */
function stopTorque(deg: number, w: number): number {
  if (deg < 0) return -deg * 3 - w * 2;
  if (deg > 140) return -(deg - 140) * 3 - w * 2;
  return 0;
}

/** Activation needed to hold the load still at an angle. */
export function holdActivation(deg: number, weightKg: number, g: ExerciseGeom, p: ModelParams): number {
  const need = loadTorque(deg, weightKg, g) - passiveTorque(deg);
  return Math.max(0, need / (p.tmax * forceLength(deg)));
}

// ---------- set simulation ----------

/** A rep's low this many times the fatigue-corrected full-range low = turned around early (partial at the top). */
export const PARTIAL_TOP_RATIO = 1.4;
const median = (x: number[]) => { const a = [...x].sort((p, q) => p - q); return a.length ? a[a.length >> 1] : NaN; };

export interface RepSim {
  start: number; end: number;
  /** elbow angle every ACT_DT from start to end, deg */
  angle: number[];
  startDeg: number;
  /** most extended angle reached (rope) / most flexed (machine), deg */
  endDeg: number;
  reachedLockout: boolean;
  /** capacity (strength left, 0..1) at the end of the rep */
  strengthLeft: number;
  /** drive at the rep's low vs what a full-range turnaround would need at this fatigue */
  lowRatio: number;
  /** turned around well below the usual top: a partial at the top */
  partialTop: boolean;
  /** peak drive in the rep (0..1) */
  peakDrive: number;
}

export interface SetSim { reps: RepSim[]; rir: number; strengthLeft: number; state: FatigueState }

/**
 * Simulate one set. `act` is %MVC (per sensor, or both arms combined); reps from the detector.
 * The fatigue state runs continuously from the set start (pass `from` to carry fatigue across sets).
 * Each rep's angle is re-anchored at its low-activation point, so errors can't build up over the set.
 */
export function simulateSet(act: Activation, reps: Rep[], weightKg: number, p: ModelParams, g: ExerciseGeom, from: FatigueState = FRESH): SetSim {
  const out: RepSim[] = [];
  const dtS = ACT_DT / 1000, SUB = 4, h = dtS / SUB, I = inertia(weightKg, g);
  const idx = (t: number) => Math.max(0, Math.min(act.v.length - 1, Math.round((t - act.t0) / ACT_DT)));
  const TLat = (i: number) => { const v = act.v[i]; return v === v ? Math.min(1, Math.max(0, (p.gain * v) / 100)) : 0; };
  let s = from, i = reps.length ? idx(reps[0].start) : 0;
  const advance = (to: number) => { for (; i < to; i++) s = fatigueStep(s, TLat(i), p, dtS); };
  let baseLow: number | null = null;
  const lows: { tl: number; eff: number }[] = [];
  for (const r of reps) {
    const anchorT = g.anchor === "lockout" ? r.lockoutAt ?? r.start : r.start;
    const a0 = idx(anchorT), e = idx(r.end), b = idx(r.start);
    advance(b);
    // The rep's low. On the rope the hold demand is nearly flat across the range (weaker short muscle vs
    // smaller cable lever), so the angle can't be solved from the low alone. Instead the low is compared
    // with the low of the fresh full reps, corrected for fatigue (a tired muscle needs more drive to hold
    // the same weight at the top): a low well above that means the rep turned around early.
    const lowTL = TLat(a0);
    advance(a0);
    const cap = capacity(s), eff = Math.max(0.05, 1 - p.peripheral * (1 - cap));
    if (g.anchor === "top" && baseLow === null && lows.length >= 2) baseLow = median(lows.slice(0, 2).map((l) => l.tl * l.eff));
    const expectedLow = baseLow !== null ? baseLow / eff : lowTL;
    const lowRatio = expectedLow > 0 ? lowTL / expectedLow : 1;
    const partialTop = g.anchor === "top" && baseLow !== null && lowRatio > PARTIAL_TOP_RATIO && lowTL - expectedLow > 0.05;
    lows.push({ tl: lowTL, eff });
    // start angle: top for a full-range low; for an early turnaround, lower in proportion to the excess
    // (heuristic until camera recordings calibrate it)
    const startDeg = g.anchor === "lockout" ? 2 : partialTop ? g.topDeg * (1 - Math.min(0.6, (lowRatio - 1) / 1.5)) : g.topDeg;
    // integrate the elbow from the anchor to the rep end
    let deg = startDeg, w = 0; // w = flexion velocity, rad/s
    const angle: number[] = [];
    let peak = 0, ext = startDeg, flex = startDeg;
    for (let k = a0; k <= e; k++) {
      const TL = TLat(k);
      peak = Math.max(peak, TL);
      for (let j = 0; j < SUB; j++) {
        const aEff = effectiveActivation(s, TL, p);
        const net = loadTorque(deg, weightKg, g) - muscleTorque(deg, -w, aEff, p) + stopTorque(deg, w) - 0.8 * w;
        w += (net / I) * h;
        deg += (w / D2R) * h;
        s = fatigueStep(s, TL, p, h);
      }
      i = k + 1;
      angle.push(deg);
      ext = Math.min(ext, deg);
      flex = Math.max(flex, deg);
    }
    const endDeg = g.anchor === "lockout" ? flex : ext;
    out.push({
      start: r.start, end: r.end, angle, startDeg, endDeg,
      reachedLockout: g.anchor === "lockout" ? true : ext <= g.lockoutDeg,
      strengthLeft: capacity(s), lowRatio,
      partialTop,
      peakDrive: peak,
    });
  }
  return { reps: out, rir: estimateRir(out, requiredActivation(weightKg, g, p), p), strengthLeft: capacity(s), state: s };
}

/**
 * Activation needed to move the load through the hardest point of the range at a normal lifting
 * speed (force-velocity costs ~30% at ~1 rad/s).
 */
export function requiredActivation(weightKg: number, g: ExerciseGeom, p: ModelParams): number {
  let need = 0;
  for (let deg = g.lockoutDeg; deg <= g.topDeg; deg += 2) need = Math.max(need, holdActivation(deg, weightKg, g, p));
  return need / forceVelocity(1);
}

/**
 * Reps in reserve: how many more reps, at the per-rep strength loss of the last few, before the
 * strength left can no longer deliver the activation the load needs (capacity × fatigue-reduced
 * force per drive < required).
 */
export function estimateRir(reps: RepSim[], required: number, p: Pick<ModelParams, "peripheral">): number {
  if (reps.length < 2) return NaN;
  const deliverable = (cap: number) => cap * (1 - p.peripheral * (1 - cap));
  let capNeed = 1;
  for (let c = 0; c <= 1; c += 0.005) if (deliverable(c) >= required) { capNeed = c; break; }
  if (deliverable(1) < required) return 0;
  const k = Math.min(4, reps.length - 1);
  const last = reps[reps.length - 1], prev = reps[reps.length - 1 - k];
  const drop = (prev.strengthLeft - last.strengthLeft) / k;
  if (last.strengthLeft <= capNeed) return 0;
  if (drop <= 1e-4) return 20;
  return Math.min(20, (last.strengthLeft - capNeed) / drop);
}

// ---------- fitting ----------

export interface FitSet {
  act: Activation;
  reps: Rep[];
  weight: number;
  /** full reps the user confirmed; otherwise the detector's full-range count */
  fullTarget?: number;
  /** seconds of rest before this set (fatigue recovers in between); undefined = fresh */
  restBeforeS?: number;
}

export interface FitResult { params: ModelParams; loss: number }

/**
 * Fit gain, F and R per exercise. Constraints: fresh full reps reach lockout, the number of reps
 * reaching lockout matches the full-rep count, and the smallest gain that does it wins (a larger
 * gain just slams every rep into the joint stop). Tmax stays fixed: with EMG as the input only
 * gain × Tmax is identifiable.
 */
export function fitParams(sets: FitSet[], g: ExerciseGeom, base: ModelParams = DEFAULT_MODEL): FitResult {
  let best: FitResult = { params: base, loss: Infinity };
  const gains = Array.from({ length: 18 }, (_, k) => 0.4 * 1.15 ** k); // 0.4 .. ~4.3
  for (const F of [0.005, 0.01, 0.02, 0.04]) for (const R of [0.001, 0.003, 0.01]) for (const gain of gains) {
    const p = { ...base, gain, F, R };
    let loss = 0, st: FatigueState = FRESH;
    for (const fs of sets) {
      st = fs.restBeforeS === undefined ? FRESH : recover(st, fs.restBeforeS, p);
      const sim = simulateSet(fs.act, fs.reps, fs.weight, p, g, st);
      st = sim.state;
      const target = fs.fullTarget ?? fs.reps.filter((r) => (r.range ?? "full") === "full").length;
      const lock = sim.reps.filter((r) => r.reachedLockout && !r.partialTop).length;
      loss += Math.abs(lock - target);
      loss += 2 * sim.reps.slice(0, 2).filter((r) => !r.reachedLockout).length;
    }
    loss += gain * 0.01;
    if (loss < best.loss) best = { params: p, loss };
  }
  return best;
}

// ---------- holds: passive vs actively pushing vs moving ----------

export interface HoldFeatures {
  /** mean envelope, %MVC */
  level: number;
  /** 1 - coefficient of variation of the envelope (1 = perfectly flat) */
  flatness: number;
  /** slow (0.2–2 Hz) envelope modulation relative to its mean: movement shows up here */
  modulation: number;
  /** envelope drive / drive the load needs at this angle (NaN when unknown); > 1.5 = pushing beyond the load */
  excessDrive: number;
  /** share of rectified-EMG envelope power at 8–12 Hz (physiological tremor rises with hard isometric effort) */
  tremor: number;
  /** coefficient of variation of 100 ms RMS windows of the raw EMG */
  burstVar: number;
  /** median frequency slope, Hz per second (falls during a sustained effort) */
  mdfSlope: number;
}

function bandPower(x: number[], fs: number, lo: number, hi: number): number {
  // direct DFT over the band's bins (windows are short)
  const n = x.length;
  const m = x.reduce((a, b) => a + b, 0) / n;
  let p = 0;
  const k0 = Math.max(1, Math.floor((lo * n) / fs)), k1 = Math.ceil((hi * n) / fs);
  for (let k = k0; k <= k1; k++) {
    let re = 0, im = 0;
    for (let j = 0; j < n; j++) { const a = (2 * Math.PI * k * j) / n, v = x[j] - m; re += v * Math.cos(a); im -= v * Math.sin(a); }
    p += re * re + im * im;
  }
  return p;
}

const mean = (x: ArrayLike<number>) => { let s = 0, c = 0; for (let i = 0; i < x.length; i++) if (x[i] === x[i]) { s += x[i]; c++; } return c ? s / c : NaN; };
const sd = (x: ArrayLike<number>) => { const m = mean(x); let s = 0, c = 0; for (let i = 0; i < x.length; i++) if (x[i] === x[i]) { s += (x[i] - m) ** 2; c++; } return c > 1 ? Math.sqrt(s / (c - 1)) : 0; };

/**
 * Features of a hold window. env: %MVC envelope at 50 Hz; raw: raw EMG (µV) at fs over the same
 * window; neededDrive: %MVC the model says the load needs at the held angle, if known.
 */
export function holdFeatures(env: ArrayLike<number>, raw: ArrayLike<number>, fs: number, neededDrive?: number): HoldFeatures {
  const e = Array.from(env).filter((v) => v === v);
  const level = mean(e);
  const flatness = level > 0 ? 1 - sd(e) / level : 0;
  const envHz = 1000 / ACT_DT;
  // amplitude of the slow modulation (a sinusoid of amplitude A gives band power ≈ (A·n/2)²)
  const slow = e.length >= envHz * 2 ? (2 * Math.sqrt(bandPower(e, envHz, 0.2, 2))) / e.length : 0;
  const modulation = level > 0 ? slow / level : 0;
  // rectified raw EMG envelope at 100 Hz (10 ms bins) for the tremor band
  const bin = Math.max(1, Math.round(fs / 100)), rect: number[] = [];
  for (let i = 0; i + bin <= raw.length; i += bin) { let s = 0; for (let j = 0; j < bin; j++) s += Math.abs(raw[i + j]); rect.push(s / bin); }
  const tot = rect.length >= 64 ? bandPower(rect, 100, 1, 25) : 0;
  const tremor = tot > 0 ? bandPower(rect, 100, 8, 12) / tot : 0;
  const w = Math.max(1, Math.round(fs / 10)), rms: number[] = [];
  for (let i = 0; i + w <= raw.length; i += w) { let s = 0; for (let j = 0; j < w; j++) s += raw[i + j] ** 2; rms.push(Math.sqrt(s / w)); }
  const burstVar = rms.length > 2 && mean(rms) > 0 ? sd(rms) / mean(rms) : 0;
  const win = Math.round(fs / 2), mdf: number[] = [];
  for (let i = 0; i + Math.max(win, 512) <= raw.length; i += win) mdf.push(medianFrequency(Array.from(raw).slice(i, i + Math.max(win, 512)), fs));
  let mdfSlope = 0;
  const md = mdf.map((v, k) => [k * 0.5, v]).filter(([, v]) => v === v);
  if (md.length >= 3) {
    const mx = mean(md.map((q) => q[0])), my = mean(md.map((q) => q[1]));
    let num = 0, den = 0;
    for (const [x, y] of md) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
    mdfSlope = den ? num / den : 0;
  }
  const excessDrive = neededDrive && neededDrive > 0 ? level / neededDrive : NaN;
  return { level, flatness, modulation, excessDrive, tremor, burstVar, mdfSlope };
}

export type HoldClass = "passive" | "active" | "moving";

export interface HoldRule { moveModulation: number; activeExcess: number; activeLevel: number; activeTremor: number }
export const DEFAULT_HOLD_RULE: HoldRule = { moveModulation: 0.25, activeExcess: 1.5, activeLevel: 45, activeTremor: 0.25 };

/** Simple rule until labelled experiments train it: modulation = moving; extra drive or strong tremor = pushing. */
export function classifyHold(f: HoldFeatures, rule: HoldRule = DEFAULT_HOLD_RULE): HoldClass {
  if (f.modulation > rule.moveModulation || f.flatness < 0.3) return "moving";
  if ((f.excessDrive === f.excessDrive && f.excessDrive > rule.activeExcess) || (f.level > rule.activeLevel && f.tremor > rule.activeTremor)) return "active";
  if (f.excessDrive !== f.excessDrive && f.level > rule.activeLevel * 1.5) return "active";
  return "passive";
}

const FEATURE_KEYS: (keyof HoldFeatures)[] = ["level", "flatness", "modulation", "tremor", "burstVar", "mdfSlope", "excessDrive"];

/**
 * Train from labelled experiment windows: a nearest-centroid classifier on standardised features
 * (features that are NaN everywhere are dropped). Returns the classifier and the centroids.
 */
export function trainHoldClassifier(labelled: { features: HoldFeatures; label: HoldClass }[]) {
  const keys = FEATURE_KEYS.filter((k) => labelled.some((l) => l.features[k] === l.features[k]));
  const mu: Record<string, number> = {}, sg: Record<string, number> = {};
  for (const k of keys) { const v = labelled.map((l) => l.features[k]).filter((x) => x === x); mu[k] = mean(v); sg[k] = sd(v) || 1; }
  const z = (f: HoldFeatures) => keys.map((k) => (f[k] === f[k] ? (f[k] - mu[k]) / sg[k] : 0));
  const centroids: Partial<Record<HoldClass, number[]>> = {};
  for (const c of ["passive", "active", "moving"] as HoldClass[]) {
    const rows = labelled.filter((l) => l.label === c).map((l) => z(l.features));
    if (rows.length) centroids[c] = keys.map((_, j) => rows.reduce((s, r) => s + r[j], 0) / rows.length);
  }
  const classify = (f: HoldFeatures): HoldClass => {
    const v = z(f);
    let best: HoldClass = "passive", bd = Infinity;
    for (const [c, m] of Object.entries(centroids) as [HoldClass, number[]][]) {
      const d = m.reduce((s, x, j) => s + (x - v[j]) ** 2, 0);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  };
  const accuracy = labelled.length ? labelled.filter((l) => classify(l.features) === l.label).length / labelled.length : NaN;
  return { keys, mu, sg, centroids, classify, accuracy };
}
