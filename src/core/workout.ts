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
 * Reps by hysteresis on the set's own range: a rep is a rise above `hi` followed by a fall below `lo`.
 * Holds stay above `hi` and so count once, which is what we want for slow controlled reps.
 */
export function detectReps(act: Activation, span: Span): Rep[] {
  const { a, b } = slice(act, span);
  const x = movingAverage(act.v.subarray(a, b) as Float32Array, 12); // 240 ms
  const vals: number[] = [];
  for (let i = 0; i < x.length; i++) if (x[i] === x[i]) vals.push(x[i]);
  if (vals.length < ACT_HZ) return [];
  const p10 = quantile(vals, 0.1), p95 = quantile(vals, 0.95), range = p95 - p10;
  if (range < 3) return [];
  const hi = p10 + 0.5 * range, lo = p10 + 0.28 * range;
  const reps: Rep[] = [];
  let state: "low" | "high" = "low";
  let onset = 0, peakI = 0, peak = -Infinity;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (v !== v) continue;
    if (state === "low") {
      if (v < lo || i === 0) onset = i;
      if (v > hi) { state = "high"; peak = v; peakI = i; }
    } else {
      if (v > peak) { peak = v; peakI = i; }
      if (v < lo) {
        const end = i;
        if ((end - onset) * ACT_DT >= 500) {
          let s = 0, c = 0;
          for (let j = onset; j <= end; j++) if (x[j] === x[j]) { s += x[j]; c++; }
          const t = (j: number) => act.t0 + (a + j) * ACT_DT;
          reps.push({ start: t(onset), peakT: t(peakI), end: t(end), peak, mean: s / c, riseS: ((peakI - onset) * ACT_DT) / 1000, fallS: ((end - peakI) * ACT_DT) / 1000 });
        }
        state = "low"; onset = i;
      }
    }
  }
  // a set that ends while still contracted (e.g. final hold): count the last rep
  if (state === "high" && (x.length - onset) * ACT_DT >= 500) {
    const t = (j: number) => act.t0 + (a + j) * ACT_DT;
    reps.push({ start: t(onset), peakT: t(peakI), end: t(x.length - 1), peak, mean: peak, riseS: ((peakI - onset) * ACT_DT) / 1000, fallS: ((x.length - 1 - peakI) * ACT_DT) / 1000 });
  }
  return reps;
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

function sideResult(ch: Channel, span: Span): SideResult {
  const reps = detectReps(ch.act, span);
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
  const groups: { start: number; end: number; keys: Set<string> }[] = [];
  for (const s of spans) {
    const g = groups[groups.length - 1];
    const overlap = g ? Math.min(g.end, s.end) - Math.max(g.start, s.start) : -1;
    const shorter = g ? Math.min(g.end - g.start, s.end - s.start) : 1;
    if (g && overlap > 0.4 * shorter && !g.keys.has(s.key)) { g.start = Math.min(g.start, s.start); g.end = Math.max(g.end, s.end); g.keys.add(s.key); }
    else groups.push({ start: s.start, end: s.end, keys: new Set([s.key]) });
  }
  const out: DetectedSet[] = [];
  for (const g of groups) {
    const sides = channels.filter((c) => g.keys.has(c.key)).map((c) => sideResult(c, g));
    const reps = Math.max(0, ...sides.map((s) => s.reps.length));
    if (reps < opt.minReps) continue;
    out.push({ start: g.start, end: g.end, sides, reps, flags: formFlags(sides) });
  }
  return out;
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
