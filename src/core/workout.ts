/**
 * Workout analysis from EMG: activation series -> sets -> reps -> holds, tempo, fatigue, form flags.
 *
 * Everything works on an "activation" series: the EMG envelope resampled to 50 Hz and expressed
 * as % of the session's calibrated maximum (dry electrodes vary between sessions, so only
 * same-session normalisation makes numbers comparable). The same functions run live (on a
 * recent window) and offline (on the whole recording), so results match.
 */
import { FFT_N } from "./dsp";

export const ACT_HZ = 50;
export const ACT_DT = 1000 / ACT_HZ; // ms per activation sample

/** Activation for one sensor: v[i] is % of reference at time t0 + i * ACT_DT (ms). NaN = no data. */
export interface Activation {
  t0: number;
  v: Float32Array;
}

export interface Reference {
  /** envelope µV at 100 % (maximum contraction during calibration) */
  mvcRms: number;
  /** resting envelope, µV */
  restRms: number;
  restSd: number;
}

/* ---------------- building the activation series ---------------- */

/**
 * Envelope samples (µV) with times (ms) -> 50 Hz activation in % of reference.
 * Bins are 20 ms means, then a 200 ms moving average.
 */
export function toActivation(t: ArrayLike<number>, env: ArrayLike<number>, ref: Reference, tStart?: number, tEnd?: number): Activation {
  const n = t.length;
  const t0 = Math.floor((tStart ?? (n ? t[0] : 0)) / ACT_DT) * ACT_DT;
  const t1 = tEnd ?? (n ? t[n - 1] : t0);
  const bins = Math.max(0, Math.ceil((t1 - t0) / ACT_DT) + 1);
  const sum = new Float64Array(bins), cnt = new Uint16Array(bins);
  for (let k = 0; k < n; k++) {
    const e = env[k];
    if (e !== e) continue;
    const b = Math.floor((t[k] - t0) / ACT_DT);
    if (b >= 0 && b < bins) { sum[b] += e; cnt[b]++; }
  }
  const raw = new Float32Array(bins);
  const scale = 100 / Math.max(ref.mvcRms, 1e-6);
  for (let b = 0; b < bins; b++) raw[b] = cnt[b] ? (sum[b] / cnt[b]) * scale : NaN;
  return { t0, v: movingAverage(raw, 10) };
}

/** NaN-aware centred moving average over w samples. */
export function movingAverage(x: Float32Array, w: number): Float32Array {
  const out = new Float32Array(x.length);
  const h = Math.floor(w / 2);
  let s = 0, c = 0;
  // running window [i-h, i+h]
  for (let i = 0; i < Math.min(h, x.length); i++) if (x[i] === x[i]) { s += x[i]; c++; }
  for (let i = 0; i < x.length; i++) {
    const add = i + h, rem = i - h - 1;
    if (add < x.length && x[add] === x[add]) { s += x[add]; c++; }
    if (rem >= 0 && x[rem] === x[rem]) { s -= x[rem]; c--; }
    out[i] = c > 0 && x[i] === x[i] ? s / c : NaN;
  }
  return out;
}

/* ---------------- sets ---------------- */

export interface DetectOptions {
  /** gap of inactivity that ends a set (s) */
  restGapS: number;
  /** minimum set duration (s) */
  minSetS: number;
  /** minimum reps for a set to count */
  minReps: number;
  /** rep settings for a set starting at time t (the exercise's learned profile) */
  repParams?: (t: number) => RepParams;
}

export const DEFAULT_DETECT: DetectOptions = { restGapS: 6, minSetS: 3, minReps: 2 };

/** Activity threshold (% of reference): clearly above resting noise, and at least 6 %. */
export function onThreshold(ref: Reference): number {
  const restPct = (ref.restRms / ref.mvcRms) * 100, sdPct = (ref.restSd / ref.mvcRms) * 100;
  return Math.max(restPct + 4 * sdPct, restPct * 2, 6);
}

export interface Span { start: number; end: number } // ms

/** Active stretches of one sensor, merged across short pauses, as candidate sets. */
export function activeSpans(act: Activation, ref: Reference, opt: DetectOptions = DEFAULT_DETECT): Span[] {
  const on = onThreshold(ref), off = on * 0.7;
  const slow = movingAverage(act.v, 25); // 0.5 s
  const spans: Span[] = [];
  let inside = false, start = 0, lastAbove = 0;
  for (let i = 0; i < slow.length; i++) {
    const v = slow[i], t = act.t0 + i * ACT_DT;
    if (v !== v) continue;
    if (!inside && v > on) { inside = true; start = t; lastAbove = t; }
    else if (inside) {
      if (v > off) lastAbove = t;
      else if (t - lastAbove > opt.restGapS * 1000) { spans.push({ start, end: lastAbove }); inside = false; }
    }
  }
  if (inside) spans.push({ start, end: lastAbove });
  return spans.filter((s) => s.end - s.start >= opt.minSetS * 1000).map((s) => ({ start: s.start - 300, end: s.end + 300 }));
}

/* ---------------- reps and holds ---------------- */

export interface Rep {
  start: number; // ms
  peakT: number;
  end: number;
  /** peak activation (% of reference) */
  peak: number;
  mean: number;
  /** onset -> peak (s): mostly the lifting (concentric) part */
  riseS: number;
  /** peak -> offset (s): mostly the lowering (eccentric) part */
  fallS: number;
  /** median frequency of the raw EMG during the rep (Hz), if computed */
  mdf?: number;
  valleyBefore?: number;
  valleyAfter?: number;
  /** estimated range of motion (from activation, not joint angle) */
  range?: RepRange;
  /** dip-mode exercises: the moment of lockout */
  lockoutAt?: number;
}

export interface Hold {
  start: number;
  end: number;
  level: number; // % of reference
  /** "top" when held near the set's peak activation (contracted), "mid" otherwise */
  position: "top" | "mid";
}

function slice(act: Activation, span: Span) {
  const a = Math.max(0, Math.floor((span.start - act.t0) / ACT_DT));
  const b = Math.min(act.v.length, Math.ceil((span.end - act.t0) / ACT_DT));
  return { a, b };
}

function quantile(values: number[], q: number) {
  if (!values.length) return NaN;
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

/**
 * Reps are activation peaks with enough prominence (how far the signal drops on both sides
 * before a higher peak), at least 0.7 s apart. Small up-and-down movements within a set are
 * found too; each rep is then classified by how high it peaks and how far it relaxes
 * compared with the set's full reps (see classifyRange). A long hold is one peak, so it counts once.
 */
/**
 * How reps show up for an exercise.
 *  peak: a rep is an activation peak (cable pushdowns, curls: activation is highest when contracted)
 *  dip:  a rep is a drop in activation (machine pushdowns: at lockout the joints and machine hold the
 *        load and the muscle relaxes). Deep dips are full reps, shallow ones (half pushes) partials.
 * promFrac: how far (share of the set's range) a rep must stand out; depth: for dips, how close to
 * the set's floor a dip must reach to count as a full lockout (0 = the floor, 1 = the top).
 * Learned per exercise from the user's rep corrections (see tuneRepParams).
 */
export interface RepParams { mode: "peak" | "dip"; promFrac: number; depth: number }
export const DEFAULT_REP: RepParams = { mode: "peak", promFrac: 0.3, depth: 0.38 };
// learned from the first real machine-pushdown sets (user estimate ~6 and ~2-3 lockouts)
export const DEFAULT_DIP: RepParams = { mode: "dip", promFrac: 0.38, depth: 0.35 };
const SEP_S = 0.8, SMOOTH = 10;

/** Prominent maxima of y (NaN-aware) with boundaries at the lowest point between neighbours. */
function prominentPeaks(y: Float32Array, promFrac: number) {
  const vals: number[] = [];
  for (let i = 0; i < y.length; i++) if (y[i] === y[i]) vals.push(y[i]);
  if (vals.length < ACT_HZ) return null;
  const p10 = quantile(vals, 0.1), p95 = quantile(vals, 0.95), range = p95 - p10;
  if (range < 3) return null;
  const n = y.length;
  // a rep swings a good part of the set's range; bumps on a plateau are much smaller
  const minProm = Math.max(promFrac * range, 3), minLevel = p10 + 0.25 * range;
  const minSep = Math.round(SEP_S * ACT_HZ);
  const at = (i: number) => (y[i] === y[i] ? y[i] : -Infinity);
  let peaks: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    const v = at(i);
    if (v >= minLevel && v > at(i - 1) && v >= at(i + 1)) peaks.push(i);
  }
  const prom = (i: number) => {
    const v = at(i);
    let l = v, r = v;
    for (let j = i - 1; j >= 0 && at(j) <= v; j--) if (at(j) !== -Infinity) l = Math.min(l, at(j));
    for (let j = i + 1; j < n && at(j) <= v; j++) if (at(j) !== -Infinity) r = Math.min(r, at(j));
    return v - Math.max(l, r);
  };
  peaks = peaks.filter((i) => prom(i) >= minProm);
  const kept: number[] = [];
  for (const i of peaks) {
    const last = kept[kept.length - 1];
    if (last !== undefined && i - last < minSep) { if (at(i) > at(last)) kept[kept.length - 1] = i; }
    else kept.push(i);
  }
  const valley = (i: number, j: number) => { let m = i; for (let k = i; k <= j; k++) if (at(k) < at(m)) m = k; return m; };
  const onLevel = p10 + 0.2 * range;
  const bounds = kept.map((p, k) => {
    let s0: number, e0: number;
    if (k === 0) { s0 = p; while (s0 > 0 && at(s0 - 1) > onLevel) s0--; } else s0 = valley(kept[k - 1], p);
    if (k === kept.length - 1) { e0 = p; while (e0 < n - 1 && at(e0 + 1) > onLevel) e0++; } else e0 = valley(p, kept[k + 1]);
    return { p, s0, e0 };
  }).filter((r) => (r.e0 - r.s0) * ACT_DT >= 400);
  return { bounds, p10, range, at };
}

/**
 * Reps in a set: prominent activation peaks (or dips, for exercises where the muscle relaxes at
 * lockout), at least 0.8 s apart. Small up-and-down movements are found too and classified by range.
 * A long hold is one peak, so it counts once.
 */
export function detectReps(act: Activation, span: Span, params: RepParams = DEFAULT_REP): Rep[] {
  const { a, b } = slice(act, span);
  const x = movingAverage(act.v.subarray(a, b) as Float32Array, SMOOTH);
  const t = (j: number) => act.t0 + (a + j) * ACT_DT;
  if (params.mode === "dip") {
    // flip the signal inside the set; drop the first/last second (ramp in / out are not lockouts)
    const trim = ACT_HZ, y = new Float32Array(x.length).fill(NaN);
    for (let i = trim; i < x.length - trim; i++) y[i] = x[i] === x[i] ? -x[i] : NaN;
    const f = prominentPeaks(y, params.promFrac);
    if (!f) return [];
    let lo = Infinity, hi = -Infinity;
    for (let i = trim; i < x.length - trim; i++) if (x[i] === x[i]) { lo = Math.min(lo, x[i]); hi = Math.max(hi, x[i]); }
    const span100 = Math.max(hi - lo, 1e-6);
    return f.bounds.map(({ p, s0, e0 }) => {
      let peak = -Infinity, pk = p, sum = 0, c = 0;
      for (let j = s0; j <= e0; j++) if (x[j] === x[j]) { sum += x[j]; c++; if (x[j] > peak) { peak = x[j]; pk = j; } }
      const depth = (x[p] - lo) / span100;
      return {
        start: t(s0), peakT: t(p), end: t(e0), peak, mean: sum / Math.max(1, c),
        // for dip exercises: rise = push until lockout, fall = back up to the next rep
        riseS: ((p - s0) * ACT_DT) / 1000, fallS: ((e0 - p) * ACT_DT) / 1000,
        valleyBefore: x[s0], valleyAfter: x[e0], lockoutAt: t(p),
        range: depth <= params.depth ? "full" : "mid",
      } as Rep;
    });
  }
  const f = prominentPeaks(x, params.promFrac);
  if (!f) return [];
  const reps: Rep[] = f.bounds.map(({ p, s0, e0 }) => {
    let sum = 0, c = 0;
    for (let j = s0; j <= e0; j++) if (x[j] === x[j]) { sum += x[j]; c++; }
    return {
      start: t(s0), peakT: t(p), end: t(e0), peak: f.at(p), mean: sum / Math.max(1, c),
      riseS: ((p - s0) * ACT_DT) / 1000, fallS: ((e0 - p) * ACT_DT) / 1000,
      valleyBefore: f.at(s0), valleyAfter: f.at(e0),
    };
  });
  classifyRange(reps, f.p10, params.depth);
  return reps;
}

/** Typical rep period (s) of a set from the autocorrelation of its activation, or null if no clear rhythm. */
export function repPeriod(x: Float32Array): number | null {
  const n = x.length;
  let m = 0, c = 0;
  for (let i = 0; i < n; i++) if (x[i] === x[i]) { m += x[i]; c++; }
  if (c < 4 * ACT_HZ) return null;
  m /= c;
  const d = new Float32Array(n);
  let v0 = 0;
  for (let i = 0; i < n; i++) { d[i] = x[i] === x[i] ? x[i] - m : 0; v0 += d[i] * d[i]; }
  if (!(v0 > 0)) return null;
  const lo = Math.round(0.8 * ACT_HZ), hi = Math.min(Math.round(12 * ACT_HZ), Math.floor(n / 2));
  const acf = new Float32Array(hi + 2);
  for (let lag = lo - 1; lag <= hi + 1 && lag < n; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += d[i] * d[i + lag];
    acf[lag] = sum / v0 * (n / (n - lag)); // unbiased
  }
  // first clear local maximum above 0.2: the fundamental, not a multiple
  for (let lag = lo; lag <= hi; lag++) {
    if (acf[lag] > 0.2 && acf[lag] >= acf[lag - 1] && acf[lag] >= acf[lag + 1]) {
      // refine: prefer the strongest peak within ±20 %
      let best = lag;
      for (let k = lag; k <= Math.min(hi, Math.round(lag * 1.2)); k++) if (acf[k] > acf[best]) best = k;
      return best / ACT_HZ;
    }
  }
  return null;
}

export type RepRange = "full" | "top" | "bottom" | "mid";

/**
 * Range of a rep, estimated from activation relative to the set's full reps: a full rep
 * peaks high (lockout / contracted) and relaxes low (stretched) between reps. Top-half
 * partials peak high but never relax; bottom-half partials relax but never peak.
 * For pushdowns and curls triceps/biceps activation is highest near the contracted end.
 */
export function classifyRange(reps: Rep[], base: number, relaxMax = 0.38) {
  if (!reps.length) return;
  const peaks = reps.map((r) => r.peak).sort((x, y) => x - y);
  const full = peaks[Math.floor(0.8 * (peaks.length - 1))];
  const span = Math.max(full - base, 1e-6);
  for (const r of reps) {
    const pn = (r.peak - base) / span;
    const vn = (((r.valleyBefore ?? base) + (r.valleyAfter ?? base)) / 2 - base) / span;
    r.range = pn >= 0.72 ? (vn <= relaxMax ? "full" : "top") : vn <= relaxMax ? "bottom" : "mid";
  }
}

/** Sustained plateaus: activation steady (range < 25 % of its level) above 12 % for >= 1.5 s. */
export function detectHolds(act: Activation, span: Span, setPeak: number): Hold[] {
  const { a, b } = slice(act, span);
  const x = act.v.subarray(a, b);
  const W = ACT_HZ; // 1 s window
  const holds: Hold[] = [];
  let runStart = -1, runSum = 0, runN = 0;
  const close = (endI: number) => {
    if (runStart >= 0 && (endI - runStart) * ACT_DT >= 1500) {
      const level = runSum / runN;
      holds.push({ start: act.t0 + (a + runStart) * ACT_DT, end: act.t0 + (a + endI) * ACT_DT, level, position: level >= 0.7 * setPeak ? "top" : "mid" });
    }
    runStart = -1; runSum = 0; runN = 0;
  };
  for (let i = 0; i + W <= x.length; i++) {
    let mn = Infinity, mx = -Infinity, s = 0, c = 0;
    for (let j = i; j < i + W; j++) { const v = x[j]; if (v === v) { if (v < mn) mn = v; if (v > mx) mx = v; s += v; c++; } }
    const mean = c ? s / c : NaN;
    const steady = c > W * 0.8 && mean > 12 && mx - mn < 0.25 * mean;
    if (steady) { if (runStart < 0) runStart = i; runSum += mean; runN++; }
    else if (runStart >= 0) close(i + W - 1);
  }
  close(x.length - 1);
  // merge holds closer than 0.4 s
  const merged: Hold[] = [];
  for (const h of holds) {
    const last = merged[merged.length - 1];
    if (last && h.start - last.end < 400) { last.end = h.end; last.level = (last.level + h.level) / 2; }
    else merged.push({ ...h });
  }
  return merged;
}

/* ---------------- fatigue: median frequency ---------------- */

/** Median frequency (Hz) of samples, averaged over up to 4 Hann-windowed 512-point chunks. */
export function medianFrequency(x: ArrayLike<number>, fs: number): number {
  const N = 512;
  if (x.length < N) return NaN;
  const chunks = Math.min(4, Math.floor(x.length / N));
  const step = Math.floor((x.length - N) / Math.max(1, chunks - 1 || 1));
  const psd = new Float64Array(N / 2);
  for (let c = 0; c < chunks; c++) {
    const off = chunks === 1 ? Math.floor((x.length - N) / 2) : c * step;
    const re = new Float64Array(N), im = new Float64Array(N);
    let mean = 0, cnt = 0;
    for (let i = 0; i < N; i++) { const v = x[off + i]; if (v === v) { mean += v; cnt++; } }
    mean = cnt ? mean / cnt : 0;
    for (let i = 0; i < N; i++) { const v = x[off + i]; re[i] = (v === v ? v - mean : 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))); }
    fft(re, im);
    for (let i = 0; i < N / 2; i++) psd[i] += re[i] * re[i] + im[i] * im[i];
  }
  const lo = Math.ceil((20 * N) / fs), hi = Math.min(N / 2 - 1, Math.floor((450 * N) / fs));
  let total = 0;
  for (let i = lo; i <= hi; i++) total += psd[i];
  if (!(total > 0)) return NaN;
  let acc = 0;
  for (let i = lo; i <= hi; i++) { acc += psd[i]; if (acc >= total / 2) return (i * fs) / N; }
  return NaN;
}

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const p = i + k, q = p + len / 2;
        const tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
        re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
void FFT_N;

/* ---------------- sets across sensors ---------------- */

export interface Channel {
  key: string; // sensor id
  side: "left" | "right";
  muscle: string;
  act: Activation;
  ref: Reference;
  /** optional raw filtered EMG for median frequency: sample times (ms) + values */
  raw?: { t: ArrayLike<number>; v: ArrayLike<number>; fs: number };
}

export interface SideResult {
  key: string;
  side: "left" | "right";
  muscle: string;
  reps: Rep[];
  holds: Hold[];
  peak: number; // mean rep peak %
  /** activation integral over the set, %·s (EMG "work") */
  effort: number;
  activeS: number;
  mdfStart?: number;
  mdfEnd?: number;
}

export interface DetectedSet {
  start: number;
  end: number;
  sides: SideResult[];
  reps: number; // max over sides
  flags: Flag[];
}

export interface Flag {
  kind: "good" | "warn";
  text: string;
}

/** Per-arm numbers for reps whose timing was found on the combined signal of both arms. */
function repsFromTiming(ch: Channel, timing: Rep[]): Rep[] {
  const at = (t: number) => { const i = Math.round((t - ch.act.t0) / ACT_DT); const v = ch.act.v[i]; return v === v ? v : NaN; };
  return timing.map((r) => {
    let peak = -Infinity, sum = 0, c = 0, pT = r.peakT;
    for (let t = r.start; t <= r.end; t += ACT_DT) { const v = at(t); if (v === v) { sum += v; c++; if (v > peak) { peak = v; pT = t; } } }
    return { ...r, peakT: pT, peak: peak === -Infinity ? 0 : peak, mean: c ? sum / c : 0, valleyBefore: at(r.start), valleyAfter: at(r.end) };
  });
}

function sideResult(ch: Channel, span: Span, timing?: Rep[], params?: RepParams): SideResult {
  const reps = timing ? repsFromTiming(ch, timing) : detectReps(ch.act, span, params);
  const setPeak = reps.length ? Math.max(...reps.map((r) => r.peak)) : 0;
  const holds = detectHolds(ch.act, span, setPeak);
  const { a, b } = slice(ch.act, span);
  const on = onThreshold(ch.ref);
  let effort = 0, active = 0;
  for (let i = a; i < b; i++) { const v = ch.act.v[i]; if (v === v) { effort += (v * ACT_DT) / 1000; if (v > on) active++; } }
  if (ch.raw) {
    for (const r of reps) {
      const lo = lowerBoundArr(ch.raw.t, r.start), hi = lowerBoundArr(ch.raw.t, r.end);
      const seg: number[] = [];
      for (let k = lo; k < hi; k++) seg.push(ch.raw.v[k]);
      r.mdf = medianFrequency(seg, ch.raw.fs);
    }
  }
  const mdfs = reps.map((r) => r.mdf).filter((v): v is number => v !== undefined && v === v);
  const k = Math.max(1, Math.floor(mdfs.length / 3));
  return {
    key: ch.key, side: ch.side, muscle: ch.muscle, reps, holds,
    peak: reps.length ? reps.reduce((s, r) => s + r.peak, 0) / reps.length : 0,
    effort, activeS: (active * ACT_DT) / 1000,
    mdfStart: mdfs.length >= 3 ? mean(mdfs.slice(0, k)) : undefined,
    mdfEnd: mdfs.length >= 3 ? mean(mdfs.slice(-k)) : undefined,
  };
}

function lowerBoundArr(t: ArrayLike<number>, x: number) {
  let lo = 0, hi = t.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;

/**
 * Sets from all channels: per-channel active spans, merged when they overlap (both arms
 * working together = one bilateral set) and kept separate otherwise (one arm at a time).
 */
export function detectSets(channels: Channel[], opt: DetectOptions = DEFAULT_DETECT): DetectedSet[] {
  const spans: (Span & { key: string })[] = [];
  for (const ch of channels) for (const s of activeSpans(ch.act, ch.ref, opt)) spans.push({ ...s, key: ch.key });
  spans.sort((x, y) => x.start - y.start);
  // union of overlapping spans across all sensors: both arms working together = one set; a
  // sensor whose activity bridges two of the other's spans joins them (never two overlapping sets)
  const groups: { start: number; end: number; keys: Set<string> }[] = [];
  for (const s of spans) {
    const g = groups[groups.length - 1];
    if (g && s.start < g.end) { g.end = Math.max(g.end, s.end); g.keys.add(s.key); }
    else groups.push({ start: s.start, end: s.end, keys: new Set([s.key]) });
  }
  const out: DetectedSet[] = [];
  for (const g of groups) {
    const members = channels.filter((c) => g.keys.has(c.key));
    const params = opt.repParams?.(g.start) ?? DEFAULT_REP;
    // both arms on the same muscle: find the reps once on their average (more robust, and both
    // arms agree on the count), then measure each arm on its own signal
    let timing: Rep[] | undefined;
    if (members.length === 2 && members[0].muscle === members[1].muscle && members[0].side !== members[1].side) {
      const combined = averageActivation(members[0].act, members[1].act);
      timing = detectReps(combined, g, params);
    }
    const sides = members.map((c) => sideResult(c, g, timing, params));
    const reps = Math.max(0, ...sides.map((s) => s.reps.length));
    if (reps < opt.minReps) continue;
    out.push({ start: g.start, end: g.end, sides, reps, flags: formFlags(sides) });
  }
  return out;
}

export function averageActivation(a: Activation, b: Activation): Activation {
  const t0 = Math.min(a.t0, b.t0), t1 = Math.max(a.t0 + a.v.length * ACT_DT, b.t0 + b.v.length * ACT_DT);
  const n = Math.round((t1 - t0) / ACT_DT), v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = t0 + i * ACT_DT;
    const ia = Math.round((t - a.t0) / ACT_DT), ib = Math.round((t - b.t0) / ACT_DT);
    const x = a.v[ia], y = b.v[ib];
    const okx = ia >= 0 && ia < a.v.length && x === x, oky = ib >= 0 && ib < b.v.length && y === y;
    v[i] = okx && oky ? (x + y) / 2 : okx ? x : oky ? y : NaN;
  }
  return { t0, v };
}

/* ---------------- form feedback ---------------- */

export function formFlags(sides: SideResult[]): Flag[] {
  const flags: Flag[] = [];
  for (const s of sides) {
    const name = sides.length > 1 ? `${s.side === "left" ? "Left" : "Right"}: ` : "";
    const reps = s.reps;
    if (reps.length >= 4) {
      const durs = reps.map((r) => r.riseS + r.fallS), med = quantile(durs, 0.5);
      const rushed = durs.filter((d) => d < 0.6 * med).length;
      if (rushed) flags.push({ kind: "warn", text: `${name}${rushed} rushed rep${rushed > 1 ? "s" : ""}` });
      const k = Math.min(3, Math.floor(reps.length / 2));
      const first = mean(reps.slice(0, k).map((r) => r.peak)), last = mean(reps.slice(-k).map((r) => r.peak));
      if (last < 0.75 * first) flags.push({ kind: "warn", text: `${name}activation fell ${Math.round((1 - last / first) * 100)}% by the last reps` });
      const peaks = reps.map((r) => r.peak), m = mean(peaks);
      const cv = Math.sqrt(mean(peaks.map((p) => (p - m) ** 2))) / m;
      if (cv > 0.3) flags.push({ kind: "warn", text: `${name}uneven reps (activation varies ${Math.round(cv * 100)}%)` });
      const medFall = quantile(reps.map((r) => r.fallS), 0.5);
      if (med >= 2.5 && medFall >= 1) flags.push({ kind: "good", text: `${name}controlled tempo (${med.toFixed(1)} s/rep)` });
    }
    if (s.mdfStart && s.mdfEnd && s.mdfEnd < 0.9 * s.mdfStart) flags.push({ kind: "warn", text: `${name}fatigue: median frequency −${Math.round((1 - s.mdfEnd / s.mdfStart) * 100)}%` });
    if (s.holds.length) {
      const total = s.holds.reduce((t, h) => t + (h.end - h.start) / 1000, 0);
      flags.push({ kind: "good", text: `${name}${s.holds.length} hold${s.holds.length > 1 ? "s" : ""} (${total.toFixed(1)} s)` });
    }
  }
  if (sides.length === 2) {
    const [a, b] = sides;
    const hiP = Math.max(a.peak, b.peak);
    if (hiP > 0) {
      const diff = Math.abs(a.peak - b.peak) / hiP;
      if (diff > 0.2) flags.push({ kind: "warn", text: `${(a.peak < b.peak ? a : b).side} arm ${Math.round(diff * 100)}% weaker activation` });
    }
    if (a.reps.length !== b.reps.length) flags.push({ kind: "warn", text: `rep count differs: left ${sides.find((x) => x.side === "left")?.reps.length}, right ${sides.find((x) => x.side === "right")?.reps.length}` });
  }
  return flags;
}
