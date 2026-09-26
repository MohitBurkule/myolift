/**
 * Session insights: effort (from EMG) vs movement (from the video, or EMG timing) for every rep,
 * and the trends across a whole gym session. Port of tools/effort_analysis.py + model_fit/emgload.py.
 *
 * Effort is expressed as "kg-equivalent": the weight whose fresh concentric EMG matches this rep's,
 * from a per-side EMG-vs-load curve fitted on the first fresh full reps of the session
 * (E = E0 + k·(W + 3)^b). That replaces the maximum-squeeze calibration.
 */
import { peaks } from "./videomotion";

export type Side = "left" | "right";
export const BIN_HZ = 50;
/** the video file starts ~0.13 s after the recorder (measured on the 26 Sep recordings) */
export const VIDEO_LAG_S = 0.13;
const W0 = 3;

export interface SideEmg {
  side: Side;
  /** envelope µV in 20 ms bins from t = 0 of the recording's EMG clock */
  env: ArrayLike<number>;
  /** median frequency of the raw EMG between t0 and t1 (s), if available */
  mdf?: (t0: number, t1: number) => number;
}

export interface RecordingInput {
  id: string;
  /** wall clock ms at EMG t = 0 */
  startMs: number;
  /** what was done (experiment preset id / exercise id), used for technique detection */
  label: string;
  exercise: string;
  /** stack weight at t (s, EMG clock); null if unknown */
  weightAt: (t: number) => number | null;
  /** assisted machine: weight is assistance, not load */
  assisted?: boolean;
  sides: SideEmg[];
  /** video motion (rope mode): t = s since the video started, v = hand position, down + */
  motion?: { t: number[]; v: number[]; offsetS: number };
  /** fallback when there's no usable video: EMG-detected reps (s, EMG clock) */
  emgReps?: { start: number; peak: number; end: number; range?: string }[];
  /** weights per set inside the recording (drop set segments), overrides weightAt */
  segWeights?: number[];
  /** user rating of reps left for sets in this recording, by set start (s) */
  rir?: { t: number; rir: number }[];
}

export interface RepRow {
  rec: string;
  set: string;
  seg: number;
  label: string;
  exercise: string;
  w: number;
  /** minutes since the session started */
  tMin: number;
  /** s on the recording's EMG clock (lockout) */
  t: number;
  conS: number;
  eccS: number;
  holdS: number;
  /** travel relative to the recording's full reps (1 = full), null without video */
  rel: number | null;
  /** end reached: "lockout" partial (arms straight end), "stretch" partial, or full */
  partialEnd: "lockout" | "stretch" | "mid" | null;
  /** full-rep travel per s of push, null without video */
  speed: number | null;
  mcon: Partial<Record<Side, number>>;
  mecc: Partial<Record<Side, number>>;
  icon: Partial<Record<Side, number>>;
  iecc: Partial<Record<Side, number>>;
  mdf: Partial<Record<Side, number>>;
  kgEq: number | null;
  effortPerKg: number | null;
  nme: number | null;
  leftShare: number | null;
  video: boolean;
}

export interface LoadCurve { E0: number; k: number; b: number; r2: number; n: number; loads: number[]; kind: "fit" | "anchored" }

/* ---------------- small numerics ---------------- */

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
export const median = (a: number[]) => { const s = a.filter((x) => x === x).sort((x, y) => x - y); if (!s.length) return NaN; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a: number[], p: number) => { const s = a.filter((x) => x === x).sort((x, y) => x - y); if (!s.length) return NaN; const i = (s.length - 1) * p / 100, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
export function linfit(x: number[], y: number[]): { slope: number; icpt: number; r: number } {
  const n = Math.min(x.length, y.length);
  if (n < 2) return { slope: NaN, icpt: NaN, r: NaN };
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  const slope = sxx ? sxy / sxx : NaN;
  return { slope, icpt: my - slope * mx, r: sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN };
}
/** Savitzky–Golay, window 7, order 2 (as the python used), edges: shorter windows. */
function savgol7(x: number[]): number[] {
  const c = [-2, 3, 6, 7, 6, 3, -2];
  if (x.length < 7) return x.slice();
  return x.map((_, i) => {
    if (i < 3 || i >= x.length - 3) { const a = x.slice(Math.max(0, i - 1), i + 2); return mean(a); }
    let s = 0; for (let j = -3; j <= 3; j++) s += c[j + 3] * x[i + j]; return s / 21;
  });
}

/* ---------------- EMG vs load ---------------- */

/** Fit E = E0 + k·(W+3)^b (b grid, then linear least squares for E0, k with bounds). */
export function fitLoadCurve(pts: { w: number; e: number }[]): LoadCurve | null {
  const ok = pts.filter((p) => p.w > 0 && p.e === p.e && p.e > 0);
  const loads = [...new Set(ok.map((p) => p.w))].sort((a, b) => a - b);
  if (loads.length < 2 || ok.length < 4) return null;
  let best: LoadCurve | null = null, bestSse = Infinity;
  const ys = ok.map((p) => p.e), my = mean(ys);
  const sst = ys.reduce((s, y) => s + (y - my) ** 2, 0);
  for (let b = 0.5; b <= 3.0001; b += 0.02) {
    const xs = ok.map((p) => (p.w + W0) ** b);
    let { slope: k, icpt: E0 } = linfit(xs, ys);
    if (!(k > 0)) continue;
    if (E0 < 0) { E0 = 0; k = xs.reduce((s, x, i) => s + x * ys[i], 0) / xs.reduce((s, x) => s + x * x, 0); }
    if (E0 > 400) { E0 = 400; k = xs.reduce((s, x, i) => s + x * (ys[i] - 400), 0) / xs.reduce((s, x) => s + x * x, 0); }
    if (!(k > 0)) continue;
    const sse = xs.reduce((s, x, i) => s + (ys[i] - E0 - k * x) ** 2, 0);
    if (sse < bestSse) { bestSse = sse; best = { E0, k, b, r2: sst ? 1 - sse / sst : 0, n: ok.length, loads, kind: "fit" }; }
  }
  return best;
}

/** Only one load: assume the typical shape (b = 1.3, no offset) through that load's EMG. */
export function anchoredCurve(w: number, e: number): LoadCurve {
  const b = 1.3;
  return { E0: 0, k: e / (w + W0) ** b, b, r2: NaN, n: 1, loads: [w], kind: "anchored" };
}

export function kgEquivalent(emg: number, c: LoadCurve): number {
  if (!(emg === emg)) return NaN;
  return Math.max(0, (Math.max(emg - c.E0, 0) / c.k) ** (1 / c.b) - W0);
}

/* ---------------- reps ---------------- */

const envStats = (env: ArrayLike<number>, t0: number, t1: number) => {
  const a = Math.max(0, Math.round(t0 * BIN_HZ)), b = Math.min(env.length, Math.round(t1 * BIN_HZ));
  let s = 0, n = 0;
  for (let i = a; i < b; i++) { const v = env[i]; if (v === v) { s += v; n++; } }
  return { mean: n ? s / n : NaN, integral: s / BIN_HZ, n };
};

function restLevel(env: ArrayLike<number>) {
  const v: number[] = [];
  for (let i = 0; i < env.length; i += 5) { const x = env[i]; if (x === x) v.push(x); }
  return pct(v, 5);
}

/** Rope reps from the video trace (lockout = maximum "down"), with EMG per phase. */
export function repsFromMotion(r: RecordingInput): Omit<RepRow, "tMin" | "kgEq" | "effortPerKg" | "nme" | "set" | "seg">[] {
  const m = r.motion!;
  const n = m.t.length;
  if (n < 30) return [];
  const fs = (n - 1) / (m.t[n - 1] - m.t[0] || 1);
  const p = savgol7(m.v.map((v) => (v === v ? v : 0)));
  const rng = pct(p, 98) - pct(p, 2);
  if (!(rng > 0)) return [];
  const lock = peaks(p, 0.18 * rng, Math.round(2.0 * fs));
  const tops = peaks(p.map((v) => -v), 0.08 * rng, Math.round(1.0 * fs));
  const off = m.offsetS + VIDEO_LAG_S;
  const te = (i: number) => m.t[i] + off;
  const rest = Object.fromEntries(r.sides.map((s) => [s.side, restLevel(s.env)])) as Record<Side, number>;
  const out: ReturnType<typeof repsFromMotion> = [];
  for (const li of lock) {
    const before = tops.filter((x) => x < li), after = tops.filter((x) => x > li);
    if (!before.length || !after.length) continue;
    const a = before[before.length - 1], c = after[0];
    const dn = p[li] - p[a];
    if (!(dn > 0)) continue;
    let lo = Infinity, hi = -Infinity;
    for (let j = a; j <= c; j++) if (Math.abs(p[j] - p[li]) < 0.05 * dn) { lo = Math.min(lo, j); hi = Math.max(hi, j); }
    const row: ReturnType<typeof repsFromMotion>[number] = {
      rec: r.id, label: r.label, exercise: r.exercise, w: r.weightAt(te(li)) ?? NaN, t: te(li),
      conS: (li - a) / fs, eccS: (c - li) / fs, holdS: hi >= lo ? (hi - lo) / fs : 0,
      rel: dn, partialEnd: null, speed: null, mcon: {}, mecc: {}, icon: {}, iecc: {}, mdf: {}, leftShare: null, video: true,
    };
    // keep the levels for the partial-end check
    (row as any)._lock = p[li]; (row as any)._top = p[a];
    let ok = true;
    for (const s of r.sides) {
      const cs = envStats(s.env, te(a), te(li)), es = envStats(s.env, te(li), te(c));
      if (cs.n + es.n < 3) { ok = false; break; }
      row.mcon[s.side] = cs.mean; row.mecc[s.side] = es.mean; row.icon[s.side] = cs.integral; row.iecc[s.side] = es.integral;
      if (s.mdf) row.mdf[s.side] = s.mdf(te(a), te(c));
      // a real rep: this triceps worked well above rest
      if (!(cs.mean >= Math.max(15, 5 * rest[s.side]))) ok = false;
    }
    if (ok && r.sides.length) out.push(row);
  }
  if (!out.length) return out;
  const trav = out.map((x) => x.rel!).sort((x, y) => x - y);
  const ref = median(trav.slice(-Math.max(3, Math.floor(trav.length / 3))));
  const kept = out.filter((x) => x.rel! >= 0.2 * ref);
  const full = kept.filter((x) => x.rel! >= 0.7 * ref);
  const refLock = median(full.map((x) => (x as any)._lock)), refTop = median(full.map((x) => (x as any)._top));
  for (const x of kept) {
    const lk = (x as any)._lock, tp = (x as any)._top;
    x.rel = x.rel! / ref;
    x.speed = x.rel / Math.max(x.conS, 0.1);
    x.partialEnd = x.rel >= 0.7 ? null : Math.abs(lk - refLock) < 0.3 * ref ? "lockout" : Math.abs(tp - refTop) < 0.3 * ref ? "stretch" : "mid";
    delete (x as any)._lock; delete (x as any)._top;
  }
  return kept;
}

/** Reps from EMG timing only (no video): push = onset→peak, lowering = peak→offset. */
export function repsFromEmg(r: RecordingInput): ReturnType<typeof repsFromMotion> {
  return (r.emgReps ?? []).map((q) => {
    const row: ReturnType<typeof repsFromMotion>[number] = {
      rec: r.id, label: r.label, exercise: r.exercise, w: r.weightAt(q.peak) ?? NaN, t: q.peak,
      conS: q.peak - q.start, eccS: q.end - q.peak, holdS: 0,
      rel: q.range ? (q.range === "full" ? 1 : 0.5) : null,
      partialEnd: q.range === "top" ? "lockout" : q.range === "bottom" ? "stretch" : q.range === "mid" ? "mid" : null,
      speed: null, mcon: {}, mecc: {}, icon: {}, iecc: {}, mdf: {}, leftShare: null, video: false,
    };
    for (const s of r.sides) {
      const cs = envStats(s.env, q.start, q.peak), es = envStats(s.env, q.peak, q.end);
      row.mcon[s.side] = cs.mean; row.mecc[s.side] = es.mean; row.icon[s.side] = cs.integral; row.iecc[s.side] = es.integral;
      if (s.mdf) row.mdf[s.side] = s.mdf(q.start, q.end);
    }
    return row;
  });
}

/* ---------------- session ---------------- */

export interface SetRow {
  set: string; rec: string; seg: number; label: string; exercise: string; w: number; n: number;
  tMin: number; tEndMin: number; restBeforeS: number | null;
  effortPerKg: number; firstEffortPerKg: number; kgEq: number;
  nmeChange: number | null; emgRise: number | null; romLoss: number | null;
  tutCon: number; tutEcc: number; tutHold: number; repS: number; speed: number | null; rom: number | null;
  /** lowering-phase L/R EMG ratio relative to the session's usual lowering L/R (1 = usual); conLR likewise for the push */
  eccLR: number | null; conLR: number | null;
  partialsLockout: number; partialsStretch: number; full: number;
  rir: number | null; endedInPartials: boolean;
}

export interface SessionInsights {
  version: 1;
  startMs: number; durationMin: number;
  curves: Partial<Record<Side, LoadCurve>>;
  reps: RepRow[];
  sets: SetRow[];
  metrics: {
    reps: number; withVideo: number;
    effortPerKgFirst: number | null; effortPerKgLast: number | null; effortPerKgChangePct: number | null;
    nmeChangePer10Min: number | null; nmeChangePer10kEffort: number | null;
    mdfPer10Min: Partial<Record<Side, number>>;
    mdfFirstLast: Partial<Record<Side, [number, number]>>;
    eccConRatio: number | null; conS: number | null; eccS: number | null;
    baselineLR: number | null;
    baselineEccLR: number | null;
    restRecoveryR: number | null;
    dropSets: { rec: string; weights: number[]; effortPerKg: number[]; kgEq: number[]; reps: number[] }[];
  };
}

/** Everything for one session (recordings in time order). */
export function sessionInsights(recs: RecordingInput[]): SessionInsights {
  recs = [...recs].sort((a, b) => a.startMs - b.startMs);
  const startMs = recs.length ? recs[0].startMs : 0;
  let rows: RepRow[] = [];
  for (const r of recs) {
    const base = r.motion && r.motion.t.length >= 30 ? repsFromMotion(r) : [];
    const list = base.length ? base : repsFromEmg(r);
    // sets inside a recording: split at gaps > 12 s or weight changes
    let seg = 0, prevT: number | null = null, prevW: number | null = null;
    for (const x of list.sort((a, b) => a.t - b.t)) {
      if (prevT !== null && (x.t - prevT > 12 || (x.w === x.w && prevW !== null && prevW === prevW && x.w !== prevW))) seg++;
      prevT = x.t; prevW = x.w;
      if (r.segWeights?.length) x.w = r.segWeights[Math.min(seg, r.segWeights.length - 1)];
      rows.push({ ...x, seg, set: `${r.id}#${seg}`, tMin: (r.startMs - startMs) / 60000 + x.t / 60, kgEq: null, effortPerKg: null, nme: null });
    }
  }
  const durationMin = rows.length ? Math.max(...rows.map((x) => x.tMin)) : 0;
  // EMG vs load per side from the first fresh full reps
  const curves: Partial<Record<Side, LoadCurve>> = {};
  const fresh = rows.filter((x) => x.tMin <= Math.max(18, 0.45 * durationMin) && (x.rel === null || x.rel >= 0.7) && x.w > 0 && !isAssistedLike(x));
  for (const side of ["left", "right"] as Side[]) {
    const pts = fresh.filter((x) => x.mcon[side] !== undefined).map((x) => ({ w: x.w, e: x.mcon[side]! }));
    let c = fitLoadCurve(pts);
    if (!c && pts.length) { const w = median(pts.map((p) => p.w)); c = anchoredCurve(w, median(pts.filter((p) => p.w === w).map((p) => p.e))); }
    if (c) curves[side] = c;
  }
  for (const x of rows) {
    const k = (Object.keys(x.mcon) as Side[]).filter((s) => curves[s]).map((s) => kgEquivalent(x.mcon[s]!, curves[s]!));
    x.kgEq = k.length ? mean(k) : null;
    x.effortPerKg = x.kgEq !== null && x.w > 0 ? x.kgEq / x.w : null;
    const E = (Object.values(x.icon) as number[]).reduce((s, v) => s + v, 0) + (Object.values(x.iecc) as number[]).reduce((s, v) => s + v, 0);
    x.nme = x.rel !== null && x.w > 0 && E > 0 ? (x.w * x.rel / E) * 1000 : null;
    if (x.icon.left !== undefined && x.icon.right !== undefined && E > 0) x.leftShare = (x.icon.left + (x.iecc.left ?? 0)) / E;
  }
  rows = rows.filter((x) => !(x.w === x.w) || x.w >= 0);

  // baseline L/R (concentric) over the session
  // baseline L/R over the session, per phase (the sensors differ, so compare each set with the session)
  const lrCon = rows.filter((x) => x.mcon.left && x.mcon.right).map((x) => x.mcon.left! / x.mcon.right!);
  const lrEcc = rows.filter((x) => x.mecc.left && x.mecc.right).map((x) => x.mecc.left! / x.mecc.right!);
  const baselineLR = lrCon.length ? median(lrCon) : null;
  const baselineEccLR = lrEcc.length ? median(lrEcc) : null;

  // per set
  const bySet = new Map<string, RepRow[]>();
  for (const x of rows) bySet.set(x.set, [...(bySet.get(x.set) ?? []), x]);
  const sets: SetRow[] = [];
  for (const [set, rr] of bySet) {
    rr.sort((a, b) => a.t - b.t);
    const n = rr.length, k = Math.max(1, Math.floor(n / 3)), f = rr.slice(0, k), l = rr.slice(-k);
    const mk = (xs: RepRow[], g: (x: RepRow) => number | null | undefined) => mean(xs.map(g).filter((v): v is number => v !== null && v !== undefined && v === v));
    const sumEmg = (x: RepRow) => (x.mcon.left ?? 0) + (x.mcon.right ?? 0);
    const r0 = recs.find((r) => r.id === rr[0].rec);
    const rir = r0?.rir?.length ? (r0.rir.slice().sort((a, b) => Math.abs(a.t - rr[0].t) - Math.abs(b.t - rr[0].t))[0]?.rir ?? null) : null;
    const eccLR = baselineEccLR ? median(rr.filter((x) => x.mecc.left && x.mecc.right).map((x) => x.mecc.left! / x.mecc.right!)) / baselineEccLR : null;
    const conLR = baselineLR ? median(rr.filter((x) => x.mcon.left && x.mcon.right).map((x) => x.mcon.left! / x.mcon.right!)) / baselineLR : null;
    const lastRels = rr.slice(-2).map((x) => x.rel ?? 1);
    sets.push({
      set, rec: rr[0].rec, seg: rr[0].seg, label: rr[0].label, exercise: rr[0].exercise, w: rr[0].w, n,
      tMin: rr[0].tMin, tEndMin: rr[n - 1].tMin, restBeforeS: null,
      effortPerKg: mk(rr, (x) => x.effortPerKg), firstEffortPerKg: mk(f, (x) => x.effortPerKg), kgEq: mk(rr, (x) => x.kgEq),
      nmeChange: n >= 3 ? (mk(l, (x) => x.nme) / mk(f, (x) => x.nme) - 1) * 100 : null,
      emgRise: n >= 3 ? (mk(l, sumEmg) / mk(f, sumEmg) - 1) * 100 : null,
      romLoss: n >= 3 && rr[0].rel !== null ? (1 - mk(l, (x) => x.rel) / mk(f, (x) => x.rel)) * 100 : null,
      tutCon: rr.reduce((s, x) => s + x.conS, 0), tutEcc: rr.reduce((s, x) => s + x.eccS, 0), tutHold: rr.reduce((s, x) => s + x.holdS, 0),
      repS: median(rr.map((x) => x.conS + x.eccS + x.holdS)), speed: rr[0].speed === null ? null : mk(rr, (x) => x.speed), rom: rr[0].rel === null ? null : mk(rr, (x) => x.rel),
      eccLR: eccLR !== null && eccLR === eccLR ? eccLR : null, conLR: conLR !== null && conLR === conLR ? conLR : null,
      partialsLockout: rr.filter((x) => x.partialEnd === "lockout").length, partialsStretch: rr.filter((x) => x.partialEnd === "stretch").length,
      full: rr.filter((x) => x.rel === null || x.rel >= 0.7).length, rir,
      endedInPartials: n >= 3 && rr.slice(0, -2).some((x) => (x.rel ?? 1) >= 0.7) && lastRels.every((v) => v < 0.6),
    });
  }
  sets.sort((a, b) => a.tMin - b.tMin);
  sets.forEach((s, i) => { if (i) s.restBeforeS = (s.tMin - sets[i - 1].tEndMin) * 60; });

  // trends on full reps at the usual working weight (limits the load confound)
  const fullRows = rows.filter((x) => (x.rel === null || x.rel >= 0.7) && x.w > 0 && x.effortPerKg !== null && !isAssistedLike(x));
  const wMed = median(fullRows.map((x) => x.w));
  const band = fullRows.filter((x) => x.w >= 0.75 * wMed && x.w <= 1.35 * wMed).sort((a, b) => a.tMin - b.tMin);
  let effortPerKgFirst: number | null = null, effortPerKgLast: number | null = null, effortPerKgChangePct: number | null = null;
  if (band.length >= 6 && band[band.length - 1].tMin - band[0].tMin >= 5) {
    const k = Math.max(2, Math.floor(band.length / 3));
    effortPerKgFirst = median(band.slice(0, k).map((x) => x.effortPerKg!));
    effortPerKgLast = median(band.slice(-k).map((x) => x.effortPerKg!));
    effortPerKgChangePct = (effortPerKgLast / effortPerKgFirst - 1) * 100;
  }
  const nmeRows = rows.filter((x) => x.nme !== null && x.nme === x.nme);
  let nmeChangePer10Min: number | null = null, nmeChangePer10kEffort: number | null = null;
  if (nmeRows.length >= 8) {
    const fit = linfit(nmeRows.map((x) => x.tMin), nmeRows.map((x) => x.nme!));
    nmeChangePer10Min = (fit.slope * 10) / mean(nmeRows.map((x) => x.nme!)) * 100;
    let cum = 0;
    const cumAt = new Map<RepRow, number>();
    for (const x of rows.slice().sort((a, b) => a.tMin - b.tMin)) { cum += (x.kgEq ?? 0) * (x.conS + x.eccS + x.holdS); cumAt.set(x, cum); }
    const f2 = linfit(nmeRows.map((x) => cumAt.get(x)!), nmeRows.map((x) => x.nme!));
    nmeChangePer10kEffort = (f2.slope * 10000) / mean(nmeRows.map((x) => x.nme!)) * 100;
  }
  const mdfPer10Min: Partial<Record<Side, number>> = {}, mdfFirstLast: Partial<Record<Side, [number, number]>> = {};
  for (const side of ["left", "right"] as Side[]) {
    const pts = band.filter((x) => x.mdf[side] !== undefined && x.mdf[side] === x.mdf[side]);
    if (pts.length >= 6) {
      mdfPer10Min[side] = linfit(pts.map((x) => x.tMin), pts.map((x) => x.mdf[side]!)).slope * 10;
      const k = Math.max(2, Math.floor(pts.length / 3));
      mdfFirstLast[side] = [median(pts.slice(0, k).map((x) => x.mdf[side]!)), median(pts.slice(-k).map((x) => x.mdf[side]!))];
    }
  }
  const ratios = rows.map((x) => { const c = (x.mcon.left ?? 0) + (x.mcon.right ?? 0), e = (x.mecc.left ?? 0) + (x.mecc.right ?? 0); return c > 0 ? e / c : NaN; });
  const heavySets = sets.filter((s) => s.w >= 0.75 * wMed && s.restBeforeS !== null && s.firstEffortPerKg === s.firstEffortPerKg);
  const rr = heavySets.length >= 5 ? linfit(heavySets.map((s) => s.restBeforeS!), heavySets.map((s) => s.firstEffortPerKg)).r : NaN;
  const dropSets: SessionInsights["metrics"]["dropSets"] = [];
  for (const rec of [...new Set(sets.map((s) => s.rec))]) {
    const ss = sets.filter((s) => s.rec === rec && s.w > 0).sort((a, b) => a.tMin - b.tMin);
    const ws = ss.map((s) => s.w);
    if (ss.length >= 2 && ws.every((w, i) => i === 0 || w < ws[i - 1])) dropSets.push({ rec, weights: ws, effortPerKg: ss.map((s) => s.effortPerKg), kgEq: ss.map((s) => s.kgEq), reps: ss.map((s) => s.n) });
  }
  return {
    version: 1, startMs, durationMin, curves, reps: rows, sets,
    metrics: {
      reps: rows.length, withVideo: rows.filter((x) => x.video).length,
      effortPerKgFirst, effortPerKgLast, effortPerKgChangePct, nmeChangePer10Min, nmeChangePer10kEffort, mdfPer10Min, mdfFirstLast,
      eccConRatio: ratios.some((v) => v === v) ? median(ratios) : null,
      conS: rows.length ? median(rows.map((x) => x.conS)) : null, eccS: rows.length ? median(rows.map((x) => x.eccS)) : null,
      baselineLR, baselineEccLR, restRecoveryR: rr === rr ? rr : null, dropSets,
    },
  };
}

const isAssistedLike = (x: { exercise: string; label: string }) => /assist|pull.?up|chin|dip/.test(`${x.exercise} ${x.label}`.toLowerCase());

/**
 * Reps from EMG alone (no video): peaks of the smoothed summed envelope; a rep runs from the
 * previous low to the next low (onset → peak = push, peak → offset = lowering).
 */
export function emgRepsFromEnvelope(env: ArrayLike<number>, binHz = BIN_HZ): { start: number; peak: number; end: number }[] {
  const x = Array.from(env, (v) => (v === v ? v : 0));
  const w = Math.round(0.4 * binHz), sm: number[] = [];
  let acc = 0;
  for (let i = 0; i < x.length; i++) { acc += x[i]; if (i >= w) acc -= x[i - w]; sm.push(acc / Math.min(i + 1, w)); }
  const rng = pct(sm, 98) - pct(sm, 5);
  if (!(rng > 0)) return [];
  const on = pct(sm, 5) + 0.25 * rng;
  const pk = peaks(sm, 0.3 * rng, Math.round(1.5 * binHz)).filter((i) => sm[i] > on);
  const lows = peaks(sm.map((v) => -v), 0.1 * rng, Math.round(0.8 * binHz));
  return pk.map((p) => {
    const a = lows.filter((i) => i < p).pop() ?? Math.max(0, p - 2 * binHz), b = lows.find((i) => i > p) ?? Math.min(sm.length - 1, p + 3 * binHz);
    return { start: a / binHz, peak: p / binHz, end: b / binHz };
  });
}
