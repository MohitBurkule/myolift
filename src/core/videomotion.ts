/**
 * Rep counting from a video without detecting the person (port of tools/video_motion.py).
 * Input: small grayscale frames (width ~120–160) at ~10 fps.
 *
 * rope  (pushdowns, camera near the stack): sparse pyramidal Lucas–Kanade on a grid between
 *       consecutive frames; the fastest-moving points are the hands/rope/bead. Their median
 *       vertical velocity, integrated, is the hand height (down = +), slow drift removed.
 * scale (assisted pull-up / dip machine, phone riding on the knee pad looking up): the overhead
 *       frame is fixed and the phone moves with the body. Textured points in the top of the
 *       frame are tracked; the median ratio of their pairwise distances vs a reference frame is
 *       the apparent scale ~ 1/distance to the bar. value = log(scale), up = closer to the bar.
 * Reps are the excursions to the far end of the movement (troughs of the trace), and each rep's
 * travel relative to the recording's biggest reps gives full vs partial.
 */

export type MotionMode = "rope" | "scale";

export interface GrayFrames {
  width: number;
  height: number;
  /** frame k occupies data[k*w*h, (k+1)*w*h) */
  data: Uint8Array;
  /** s since the video started */
  t: number[];
}

export interface MotionTrace {
  mode: MotionMode;
  t: number[];
  /** position (rope: hand height, down +; scale: log scale, closer +), drift removed for rope */
  value: number[];
  /** fraction of tracked points behind each value (0 = no estimate) */
  quality: number[];
}

export interface VideoRep {
  t: number; // s, trough (far end of the movement)
  start: number;
  end: number;
  travel: number;
  rel: number; // travel / typical full-rep travel
  range: "full" | "partial";
  eccS: number;
  conS: number;
}

export interface VideoMotionResult {
  mode: MotionMode;
  reps: VideoRep[];
  full: number;
  partial: number;
  /** downsampled trace for plotting */
  trace: { t: number[]; v: number[] };
  /** the full-rate trace (for per-rep timing in the session insights); missing in older results */
  traceFull?: { t: number[]; v: number[] };
  fps: number;
  frames: number;
  ms: number;
  version: 1;
}

/* ---------------- image pyramid + Lucas–Kanade ---------------- */

interface Level { w: number; h: number; I: Float32Array; gx: Float32Array; gy: Float32Array }

function level(I: Float32Array, w: number, h: number): Level {
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    gx[i] = (I[i + 1] - I[i - 1]) * 0.5;
    gy[i] = (I[i + w] - I[i - w]) * 0.5;
  }
  return { w, h, I, gx, gy };
}

function pyramid(src: Uint8Array, off: number, w: number, h: number, levels: number): Level[] {
  let I = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) I[i] = src[off + i];
  const out = [level(I, w, h)];
  for (let l = 1; l < levels; l++) {
    const w2 = w >> 1, h2 = h >> 1, J = new Float32Array(w2 * h2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      const i = 2 * y * w + 2 * x;
      J[y * w2 + x] = (I[i] + I[i + 1] + I[i + w] + I[i + w + 1]) * 0.25;
    }
    I = J; w = w2; h = h2;
    out.push(level(I, w, h));
  }
  return out;
}

function sample(I: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < 0) x = 0; else if (x > w - 1.001) x = w - 1.001;
  if (y < 0) y = 0; else if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (I[i] * (1 - fx) + I[i + 1] * fx) * (1 - fy) + (I[i + w] * (1 - fx) + I[i + w + 1] * fx) * fy;
}


/**
 * Track points (px, py) from pyramid A to B. Returns flow (dx, dy) and a status per point
 * (0 = lost: low texture or went off-frame).
 */
function lk(A: Level[], B: Level[], px: Float32Array, py: Float32Array, minEig: number, R = 2) {
  const n = px.length, dx = new Float32Array(n), dy = new Float32Array(n), ok = new Uint8Array(n);
  const L = A.length;
  for (let k = 0; k < n; k++) {
    let gxs = 0, gys = 0, good = true;
    for (let l = L - 1; l >= 0; l--) {
      const a = A[l], b = B[l], s = 1 << l;
      const x = px[k] / s, y = py[k] / s;
      if (x < R + 1 || y < R + 1 || x > a.w - R - 2 || y > a.h - R - 2) { good = l > 0 ? good : false; gxs *= 2; gys *= 2; continue; }
      const xi = Math.round(x), yi = Math.round(y);
      let Gxx = 0, Gxy = 0, Gyy = 0;
      for (let v = -R; v <= R; v++) for (let u = -R; u <= R; u++) {
        const i = (yi + v) * a.w + xi + u, ix = a.gx[i], iy = a.gy[i];
        Gxx += ix * ix; Gxy += ix * iy; Gyy += iy * iy;
      }
      const det = Gxx * Gyy - Gxy * Gxy;
      const tr = Gxx + Gyy, eig = (tr - Math.sqrt(Math.max(0, tr * tr - 4 * det))) / 2;
      if (l === 0 && eig / ((2 * R + 1) ** 2) < minEig) { good = false; break; }
      if (det < 1e-6) { gxs *= 2; gys *= 2; continue; }
      let ux = 0, uy = 0;
      for (let it = 0; it < 6; it++) {
        let bx = 0, by = 0;
        for (let v = -R; v <= R; v++) for (let u = -R; u <= R; u++) {
          const i = (yi + v) * a.w + xi + u;
          const d = a.I[i] - sample(b.I, b.w, b.h, xi + u + gxs + ux, yi + v + gys + uy);
          bx += d * a.gx[i]; by += d * a.gy[i];
        }
        const ex = (Gyy * bx - Gxy * by) / det, ey = (Gxx * by - Gxy * bx) / det;
        ux += ex; uy += ey;
        if (ex * ex + ey * ey < 0.001) break;
      }
      gxs += ux; gys += uy;
      if (l > 0) { gxs *= 2; gys *= 2; }
    }
    const nx = px[k] + gxs, ny = py[k] + gys;
    if (good && nx >= 0 && ny >= 0 && nx < A[0].w && ny < A[0].h && Math.abs(gxs) < A[0].w / 3 && Math.abs(gys) < A[0].h / 3) {
      dx[k] = gxs; dy[k] = gys; ok[k] = 1;
    }
  }
  return { dx, dy, ok };
}

function grid(w: number, h: number, step: number, y0 = 0, y1 = h) {
  const xs: number[] = [], ys: number[] = [];
  for (let y = Math.max(y0, step); y < y1 - step; y += step) for (let x = step; x < w - step; x += step) { xs.push(x); ys.push(y); }
  return { px: Float32Array.from(xs), py: Float32Array.from(ys) };
}

const median = (a: ArrayLike<number>) => { const s = Array.from(a).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const pct = (a: number[], q: number) => { const s = a.filter((v) => v === v).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round((q / 100) * (s.length - 1))))] : NaN; };

/* ---------------- traces ---------------- */

/** Let the UI run between batches of frames (long analyses run on the JS thread). */
const pause = () => new Promise<void>((r) => setTimeout(r, 0));

/** rope tracking settings: 7x7 windows, 4 pyramid levels, forward-backward check, track the 10% most-changed grid points */
export const ROPE = { step: 0, R: 3, levels: 4, fb: true, minEig: 2, keepPct: 10 };

export async function ropeTrace(f: GrayFrames, onProgress?: (p: number) => void): Promise<MotionTrace> {
  const { width: w, height: h } = f, N = f.t.length, sz = w * h;
  const step = ROPE.step || Math.max(4, Math.round(w / 30));
  const g = grid(w, h, step);
  const vy: number[] = [0], q: number[] = [0];
  const minMag = 0.5 * (w / 180);
  let prev = pyramid(f.data, 0, w, h, ROPE.levels);
  for (let k = 1; k < N; k++) {
    const cur = pyramid(f.data, k * sz, w, h, ROPE.levels);
    // only points where the image changed can be among the fastest movers: track those
    const A = prev[0].I, B = cur[0].I, diff = new Float32Array(g.px.length);
    for (let i = 0; i < g.px.length; i++) {
      const x = g.px[i], y = g.py[i];
      let d = 0;
      for (let v = -2; v <= 2; v += 2) for (let u = -2; u <= 2; u += 2) { const j = (y + v) * w + x + u; d += Math.abs(A[j] - B[j]); }
      diff[i] = d / 9;
    }
    const dthr = Math.max(3, pct(Array.from(diff), 100 - ROPE.keepPct));
    const idx: number[] = [];
    for (let i = 0; i < diff.length; i++) if (diff[i] >= dthr) idx.push(i);
    const px = Float32Array.from(idx.map((i) => g.px[i])), py = Float32Array.from(idx.map((i) => g.py[i]));
    const r = lk(prev, cur, px, py, ROPE.minEig, ROPE.R);
    if (ROPE.fb && px.length) {
      const nx = new Float32Array(px.length), ny = new Float32Array(px.length);
      for (let i = 0; i < nx.length; i++) { nx[i] = px[i] + r.dx[i]; ny[i] = py[i] + r.dy[i]; }
      const b = lk(cur, prev, nx, ny, 0, ROPE.R);
      for (let i = 0; i < nx.length; i++) if (r.ok[i] && (!b.ok[i] || Math.hypot(r.dx[i] + b.dx[i], r.dy[i] + b.dy[i]) > 1)) r.ok[i] = 0;
    }
    // the top 5% of all grid points by speed (static points count as zero)
    const mags: number[] = [];
    for (let i = 0; i < px.length; i++) if (r.ok[i]) mags.push(Math.hypot(r.dx[i], r.dy[i]));
    mags.sort((x, y) => y - x);
    const nTop = Math.max(3, Math.round(g.px.length * 0.05));
    const thr = Math.max(mags.length ? mags[Math.min(mags.length - 1, nTop - 1)] : Infinity, minMag);
    const sel: number[] = [];
    for (let i = 0; i < px.length; i++) if (r.ok[i] && Math.hypot(r.dx[i], r.dy[i]) >= thr) sel.push(r.dy[i]);
    vy.push(sel.length >= 3 ? median(sel) : 0);
    q.push(sel.length / g.px.length);
    prev = cur;
    if (k % 10 === 0) { onProgress?.(k / N); await pause(); }
  }
  const raw: number[] = [];
  let s = 0;
  for (const v of vy) { s += v; raw.push(s); }
  // remove slow drift (camera wobble): running median over ~6 s
  const fps = N > 1 ? (N - 1) / (f.t[N - 1] - f.t[0] || 1) : 10;
  const win = Math.max(3, Math.round(6 * fps)) | 1, half = win >> 1;
  const value = raw.map((_, i) => raw[i] - median(raw.slice(Math.max(0, i - half), Math.min(N, i + half + 1))));
  return { mode: "rope", t: f.t.slice(), value, quality: q };
}

export async function scaleTrace(f: GrayFrames, onProgress?: (p: number) => void): Promise<MotionTrace> {
  const { width: w, height: h } = f, N = f.t.length, sz = w * h;
  const top = Math.round(h * 0.45);
  const step = Math.max(3, Math.round(w / 40));
  const value: number[] = [], quality: number[] = [];
  let refX = new Float32Array(0), refY = new Float32Array(0), curX = new Float32Array(0), curY = new Float32Array(0);
  let alive = new Uint8Array(0), n0 = 0, logOffset = 0, prev: Level[] | null = null;
  // fixed random pairs among the tracked points
  let pairs: [number, number][] = [];
  const seed = (pyr: Level[]) => {
    const g = grid(w, h, step, 0, top);
    // keep textured points only (checked by tracking the frame onto itself)
    const r = lk(pyr, pyr, g.px, g.py, 6);
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < g.px.length; i++) if (r.ok[i]) { xs.push(g.px[i]); ys.push(g.py[i]); }
    refX = Float32Array.from(xs); refY = Float32Array.from(ys); curX = refX.slice(); curY = refY.slice();
    alive = new Uint8Array(xs.length).fill(1); n0 = xs.length;
    pairs = [];
    let st = 12345;
    const rnd = () => ((st = (st * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let i = 0; i < Math.min(600, n0 * 4); i++) {
      const a = Math.floor(rnd() * n0), b = Math.floor(rnd() * n0);
      if (a !== b && Math.hypot(refX[a] - refX[b], refY[a] - refY[b]) > w / 6) pairs.push([a, b]);
    }
  };
  const logScale = () => {
    const r: number[] = [];
    for (const [a, b] of pairs) {
      if (!alive[a] || !alive[b]) continue;
      const d0 = Math.hypot(refX[a] - refX[b], refY[a] - refY[b]), d1 = Math.hypot(curX[a] - curX[b], curY[a] - curY[b]);
      if (d0 > 0 && d1 > 0) r.push(Math.log(d1 / d0));
    }
    return r.length >= 20 ? median(r) : NaN;
  };
  for (let k = 0; k < N; k++) {
    const cur = pyramid(f.data, k * sz, w, h, 3);
    if (!prev || n0 < 15) {
      seed(cur);
      value.push(n0 >= 15 ? logOffset : NaN); quality.push(n0 >= 15 ? 1 : 0);
      prev = cur; continue;
    }
    const fwd = lk(prev, cur, curX, curY, 1);
    // forward-backward check
    const nx = new Float32Array(curX.length), ny = new Float32Array(curY.length);
    for (let i = 0; i < curX.length; i++) { nx[i] = curX[i] + fwd.dx[i]; ny[i] = curY[i] + fwd.dy[i]; }
    const back = lk(cur, prev, nx, ny, 1);
    let live = 0;
    for (let i = 0; i < curX.length; i++) {
      if (!alive[i]) continue;
      const err = Math.hypot(nx[i] + back.dx[i] - curX[i], ny[i] + back.dy[i] - curY[i]);
      if (!fwd.ok[i] || !back.ok[i] || err > 1) { alive[i] = 0; continue; }
      curX[i] = nx[i]; curY[i] = ny[i]; live++;
    }
    const ls = logScale();
    if (ls === ls) { value.push(logOffset + ls); quality.push(live / n0); } else { value.push(NaN); quality.push(0); }
    // too many points lost: re-reference here, carrying the scale over
    if (live < Math.max(15, n0 * 0.4)) { if (ls === ls) logOffset += ls; seed(cur); }
    prev = cur;
    if (k % 10 === 0) { onProgress?.(k / N); await pause(); }
  }
  return { mode: "scale", t: f.t.slice(), value, quality };
}

/* ---------------- reps ---------------- */

/** Local maxima with scipy-style prominence and a minimum distance (bigger peaks win). */
export function peaks(x: number[], minProm: number, minDist: number): number[] {
  const n = x.length, cand: { i: number; p: number }[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (!(x[i] > x[i - 1] && x[i] >= x[i + 1])) continue;
    let lmin = x[i], j = i - 1;
    while (j >= 0 && x[j] <= x[i]) { if (x[j] < lmin) lmin = x[j]; j--; }
    let rmin = x[i]; j = i + 1;
    while (j < n && x[j] <= x[i]) { if (x[j] < rmin) rmin = x[j]; j++; }
    const p = x[i] - Math.max(lmin, rmin);
    if (p >= minProm) cand.push({ i, p });
  }
  cand.sort((a, b) => x[b.i] - x[a.i]);
  const keep: number[] = [];
  for (const c of cand) if (keep.every((k) => Math.abs(k - c.i) >= minDist)) keep.push(c.i);
  return keep.sort((a, b) => a - b);
}

const smooth = (x: number[], w: number) => {
  if (w <= 1) return x.slice();
  const h = w >> 1, out: number[] = [];
  for (let i = 0; i < x.length; i++) { let s = 0, c = 0; for (let j = i - h; j <= i + h; j++) if (j >= 0 && j < x.length) { s += x[j]; c++; } out.push(s / c); }
  return out;
};

/**
 * Reps from a trace. `active` (optional, same length) limits reps to when the muscle is working
 * (from EMG), with 1 s of slack either side.
 */
export function motionReps(tr: MotionTrace, active?: boolean[], promFrac = tr.mode === "rope" ? 0.12 : 0.3, fullAt = 0.7): VideoRep[] {
  const n = tr.t.length;
  if (n < 5) return [];
  const fps = (n - 1) / (tr.t[n - 1] - tr.t[0] || 1);
  const med = median(tr.value.filter((v) => v === v));
  let x = tr.value.map((v) => (v === v ? v : med));
  // machines: a rep is the rise to the bar (peak of log scale), so look at troughs of -x
  x = tr.mode === "scale" ? smooth(x, Math.max(1, Math.round(fps))).map((v) => -v) : smooth(x, Math.max(1, Math.round(fps * 0.1)));
  let act = active && active.length === n ? active.slice() : new Array(n).fill(true);
  if (active) {
    const pad = Math.round(fps);
    act = act.map((_, i) => { for (let j = Math.max(0, i - pad); j <= Math.min(n - 1, i + pad); j++) if (active[j]) return true; return false; });
  }
  const xa = x.filter((_, i) => act[i]);
  const rng = xa.length ? pct(xa, 97) - pct(xa, 3) : 0;
  if (!(rng > 0)) return [];
  const tr0 = peaks(x.map((v) => -v), promFrac * rng, Math.round(0.8 * fps)).filter((i) => act[i]);
  const w = Math.round(3 * fps), reps: VideoRep[] = [];
  for (const p of tr0) {
    const a0 = Math.max(0, p - w), b0 = Math.min(n, p + w);
    let top = -Infinity, top2 = -Infinity;
    for (let j = a0; j <= p; j++) top = Math.max(top, x[j]);
    for (let j = p; j < b0; j++) top2 = Math.max(top2, x[j]);
    const plat = Math.min(top, top2), lvl = x[p] + 0.8 * (plat - x[p]);
    let a = p; while (a > a0 && x[a] < lvl) a--;
    let b = p; while (b < b0 - 1 && x[b] < lvl) b++;
    reps.push({ t: tr.t[p], start: tr.t[a], end: tr.t[b], travel: Math.max(top, top2) - x[p], rel: 0, range: "full", eccS: (p - a) / fps, conS: (b - p) / fps });
  }
  if (reps.length) {
    const s = reps.map((r) => r.travel).sort((a, b) => a - b);
    const ref = median(s.slice(-Math.max(1, Math.floor(reps.length / 3))));
    for (const r of reps) { r.rel = ref > 0 ? r.travel / ref : 1; r.range = r.rel >= fullAt ? "full" : "partial"; }
  }
  return reps;
}

/** Activity mask on the trace's time base from a 50 Hz EMG envelope sum (µV); t0 = video start in EMG s. */
export function activeFromEnvelope(env: ArrayLike<number>, binHz: number, t: number[], videoOffsetS: number): boolean[] {
  const v = Array.from(env).filter((x) => x === x);
  if (!v.length) return t.map(() => true);
  const thr = Math.max(3 * pct(v, 10), 0.06 * pct(v, 98));
  return t.map((tv) => { const k = Math.round((tv + videoOffsetS) * binHz); const x = env[k]; return x === x && x > thr; });
}

export async function analyseMotion(f: GrayFrames, mode: MotionMode, active?: (t: number[]) => boolean[], onProgress?: (p: number) => void): Promise<VideoMotionResult> {
  const t0 = Date.now();
  const tr = mode === "rope" ? await ropeTrace(f, onProgress) : await scaleTrace(f, onProgress);
  const reps = motionReps(tr, active?.(tr.t));
  const every = Math.max(1, Math.round(tr.t.length / 400));
  const trace = { t: [] as number[], v: [] as number[] };
  for (let i = 0; i < tr.t.length; i += every) { trace.t.push(Math.round(tr.t[i] * 100) / 100); const v = tr.value[i]; trace.v.push(v === v ? Math.round(v * 1000) / 1000 : 0); }
  const traceFull = { t: tr.t.map((x) => Math.round(x * 1000) / 1000), v: tr.value.map((v) => (v === v ? Math.round(v * 1000) / 1000 : 0)) };
  const n = f.t.length;
  return {
    mode, reps, traceFull, full: reps.filter((r) => r.range === "full").length, partial: reps.filter((r) => r.range === "partial").length,
    trace, fps: n > 1 ? (n - 1) / (f.t[n - 1] - f.t[0] || 1) : 0, frames: n, ms: Date.now() - t0, version: 1,
  };
}

/** Which mode an exercise uses: assisted pull-up / dip machines ride the phone on the pad. */
export function motionModeFor(exerciseId?: string | null, name?: string | null): MotionMode | null {
  const s = `${exerciseId ?? ""} ${name ?? ""}`.toLowerCase();
  if (/pull.?up|chin.?up|dip/.test(s)) return "scale";
  if (/push.?down|pressdown|triceps.*(rope|cable)|rope/.test(s)) return "rope";
  return null;
}
