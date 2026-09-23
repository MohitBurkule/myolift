/**
 * Streaming analysis of a recorded sensor file (rows of float64 ms + 244-byte packet) that
 * never holds the whole recording's samples in memory:
 *  pass 1: envelope -> 20 ms bins (µV)  [~180 k numbers per hour]
 *  pass 2: filtered EMG only inside given windows (for per-rep median frequency)
 */
import { Chain, type FilterSettings } from "./dsp";
import { PER_PACKET, ROW_BYTES, UV_PER_LSB } from "./protocol";
import { ACT_DT } from "./workout";

export interface ClockFit {
  n: number;
  seqs: Float64Array;
  slope: number; // ms per packet
  offset: number; // ms
  fs: number;
}

export function fitClock(bytes: Uint8Array): ClockFit {
  const n = Math.floor(bytes.length / ROW_BYTES);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, n * ROW_BYTES);
  const seqs = new Float64Array(n), hosts = new Float64Array(n);
  let prev = -1, wraps = 0;
  for (let r = 0; r < n; r++) {
    const o = r * ROW_BYTES;
    const s = dv.getUint8(o + 9) | (dv.getUint8(o + 10) << 8) | (dv.getUint8(o + 11) << 16);
    if (prev >= 0 && s < prev && prev - s > 0x800000) wraps++;
    prev = s;
    seqs[r] = s + wraps * 0x1000000;
    hosts[r] = dv.getFloat64(o, true);
  }
  let slope = PER_PACKET / 0.976;
  if (n > 50) {
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += seqs[i]; my += hosts[i]; }
    mx /= n; my /= n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (seqs[i] - mx) * (hosts[i] - my); sxx += (seqs[i] - mx) ** 2; }
    const f = sxx ? sxy / sxx : slope;
    if (f > PER_PACKET * 0.9 && f < PER_PACKET * 1.1) slope = f;
  }
  let offset = Infinity;
  for (let i = 0; i < n; i++) offset = Math.min(offset, hosts[i] - slope * seqs[i]);
  return { n, seqs, slope, offset, fs: (1000 * PER_PACKET) / slope };
}

/** Walk samples in order, calling fn(t_ms, uv) (uv NaN for missing / battery packets); resets the chain at gaps. */
function walk(bytes: Uint8Array, fit: ClockFit, chain: Chain, fn: (t: number, uv: number, filtered: number, env: number) => void, fromRow = 0, toRow = fit.n) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, fit.n * ROW_BYTES);
  const step = fit.slope / PER_PACKET;
  for (let r = fromRow; r < toRow; r++) {
    const o = r * ROW_BYTES + 8;
    if (r > fromRow && fit.seqs[r] !== fit.seqs[r - 1] + 1) chain.reset();
    const tLast = fit.offset + fit.slope * fit.seqs[r];
    let empty = true;
    for (let i = 0; i < PER_PACKET; i++) if (dv.getUint16(o + 6 + i * 2, true) !== 8192) { empty = false; break; }
    for (let i = 0; i < PER_PACKET; i++) {
      const t = tLast - (PER_PACKET - 1 - i) * step;
      if (empty) { fn(t, NaN, NaN, NaN); continue; }
      const x = (dv.getUint16(o + 6 + i * 2, true) - 8192) * UV_PER_LSB;
      chain.step(x);
      fn(t, x, chain.filtered, chain.envelope);
    }
    if (empty) chain.reset();
  }
}

/** Pass 1: envelope in 20 ms bins (µV), bin 0 at t = 0 (recording start). */
export function envelopeBins(bytes: Uint8Array, fit: ClockFit, filters: FilterSettings): Float32Array {
  const end = fit.n ? fit.offset + fit.slope * fit.seqs[fit.n - 1] : 0;
  const bins = Math.max(0, Math.ceil(end / ACT_DT) + 1);
  const sum = new Float64Array(bins), cnt = new Uint32Array(bins);
  walk(bytes, fit, new Chain(filters, fit.fs), (t, _x, _f, e) => {
    if (e !== e || t < 0) return;
    const b = Math.floor(t / ACT_DT);
    if (b < bins) { sum[b] += e; cnt[b]++; }
  });
  const out = new Float32Array(bins);
  for (let b = 0; b < bins; b++) out[b] = cnt[b] ? sum[b] / cnt[b] : NaN;
  return out;
}

/** Pass 2: filtered EMG between t0 and t1 (ms), starting the filter 1 s early to settle. */
export function filteredWindow(bytes: Uint8Array, fit: ClockFit, filters: FilterSettings, t0: number, t1: number) {
  const rowAt = (t: number) => Math.max(0, Math.min(fit.n, Math.floor((t - fit.offset) / fit.slope - fit.seqs[0])));
  const from = Math.max(0, rowAt(t0 - 1000) - 1), to = Math.min(fit.n, rowAt(t1) + 2);
  const ts: number[] = [], vs: number[] = [];
  walk(bytes, fit, new Chain(filters, fit.fs), (t, _x, f) => { if (t >= t0 && t <= t1) { ts.push(t); vs.push(f); } }, from, to);
  return { t: Float64Array.from(ts), v: Float32Array.from(vs), fs: fit.fs };
}
