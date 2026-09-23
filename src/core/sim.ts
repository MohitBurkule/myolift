/**
 * Simulated workout EMG for tests and the demo: per-arm raw signal (µV at `fs`) built from a
 * rep-by-rep activation profile. Lifting ramps activation up, optional hold at the top,
 * lowering at ~half activation, short pause. Fatigue lowers the frequency content (slower
 * noise) and, optionally, the activation over a set.
 */
import { BATTERY_V_PER_LSB, PACKET_BYTES, PER_PACKET, UV_PER_LSB } from "./protocol";

export interface SimRep { liftS: number; holdS?: number; lowerS: number; pauseS?: number; level: number }
export interface SimSet { startS: number; reps: SimRep[]; arms: ("left" | "right")[]; fatigue?: number }

export interface SimArm { side: "left" | "right"; gain: number }

export function repeat(n: number, rep: SimRep, fade = 0): SimRep[] {
  return Array.from({ length: n }, (_, i) => ({ ...rep, level: rep.level * (1 - (fade * i) / Math.max(1, n - 1)) }));
}

/** Activation (0..1 of MVC) at time t (s) for one arm. */
function activationAt(sets: SimSet[], side: "left" | "right", t: number): { a: number; fatigue: number } {
  for (const s of sets) {
    if (!s.arms.includes(side) || t < s.startS) continue;
    let tt = s.startS;
    for (let i = 0; i < s.reps.length; i++) {
      const r = s.reps[i], hold = r.holdS ?? 0, pause = r.pauseS ?? 0.4;
      const fat = (s.fatigue ?? 0) * (i / Math.max(1, s.reps.length - 1));
      const t1 = tt + r.liftS, t2 = t1 + hold, t3 = t2 + r.lowerS, t4 = t3 + pause;
      if (t < tt) break;
      if (t < t1) return { a: r.level * (0.15 + 0.85 * ((t - tt) / r.liftS)), fatigue: fat };
      if (t < t2) return { a: r.level * 0.95, fatigue: fat };
      if (t < t3) return { a: r.level * (0.55 - 0.4 * ((t - t2) / r.lowerS)), fatigue: fat };
      if (t < t4) return { a: r.level * 0.05, fatigue: fat };
      tt = t4;
    }
  }
  return { a: 0, fatigue: 0 };
}

/**
 * Raw µV for one arm, `seconds` long. MVC ≈ `mvcUv` RMS; resting noise ≈ 3 µV RMS.
 * Deterministic for a given seed.
 */
export function simulateArm(sets: SimSet[], arm: SimArm, seconds: number, fs = 975, mvcUv = 150, seed = 1): Float32Array {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const gauss = () => { let v = 0; for (let k = 0; k < 4; k++) v += rnd(); return (v - 2) * 1.73; };
  const n = Math.round(seconds * fs);
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const { a, fatigue } = activationAt(sets, arm.side, t);
    // fatigue shifts power to lower frequencies: stronger low-pass on the EMG noise
    // (fresh muscle: mostly high-passed noise; fatigued: blends toward low-passed noise,
    // giving the ~20-30 % median-frequency drop seen in fatiguing contractions)
    const g = gauss();
    lp = 0.6 * lp + 0.4 * g;
    const emg = ((1 - 0.6 * fatigue) * (g - lp) + 0.6 * fatigue * lp * 1.6) * a * mvcUv * arm.gain * 1.6;
    out[i] = emg + gauss() * 3 + 25 * Math.sin(2 * Math.PI * 0.2 * t);
  }
  return out;
}

/**
 * Streaming demo arm for the app: endless workout (sets of ~10 reps, rest between) as
 * 244-byte MYOblue packets. `hint` lets the calibration flow drive it (rest / max squeeze).
 */

export class DemoArm {
  hint: "rest" | "mvc" | null = null;
  private seq = 0;
  private i = 0;
  private lp = 0;
  private s: number;
  static readonly FS = 976;
  static readonly INTERVAL = (PER_PACKET * 1000) / DemoArm.FS;
  constructor(readonly module: number, private gain = 1, seed = 7) { this.s = seed; }
  private rnd() { return ((this.s = (this.s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
  private gauss() { let v = 0; for (let k = 0; k < 4; k++) v += this.rnd(); return (v - 2) * 1.73; }
  /** activation 0..1 for the endless routine: 45 s cycle = 10 reps of 2.8 s, then rest */
  private level(t: number): { a: number; fat: number } {
    if (this.hint === "rest") return { a: 0, fat: 0 };
    if (this.hint === "mvc") return { a: 1, fat: 0 };
    const cyc = t % 60, start = 8;
    const rep = Math.floor((cyc - start) / 2.8);
    if (cyc < start || rep >= 10) return { a: 0, fat: 0 };
    const p = (cyc - start) - rep * 2.8, lvl = 0.65 * (1 - 0.025 * rep), fat = rep / 9;
    if (p < 1) return { a: lvl * (0.15 + 0.85 * p), fat };
    if (p < 2.4) return { a: lvl * (0.55 - 0.4 * ((p - 1) / 1.4)), fat };
    return { a: lvl * 0.05, fat };
  }
  next(): Uint8Array {
    const buf = new Uint8Array(PACKET_BYTES), dv = new DataView(buf.buffer);
    buf[0] = this.module; buf[1] = this.seq & 255; buf[2] = (this.seq >> 8) & 255; buf[3] = (this.seq >> 16) & 255;
    dv.setUint16(4, Math.round(3.0 / BATTERY_V_PER_LSB), true);
    for (let k = 0; k < PER_PACKET; k++, this.i++) {
      const t = this.i / DemoArm.FS;
      const { a, fat } = this.level(t);
      const g = this.gauss();
      this.lp = 0.6 * this.lp + 0.4 * g;
      const emg = ((1 - 0.5 * fat) * (g - this.lp) + 0.5 * fat * this.lp * 1.6) * a * 150 * this.gain * 1.6;
      const uv = emg + this.gauss() * 3 + 20 * Math.sin(2 * Math.PI * 0.2 * t);
      dv.setUint16(6 + k * 2, Math.max(0, Math.min(16383, Math.round(8192 + uv / UV_PER_LSB))), true);
    }
    this.seq = (this.seq + 1) & 0xffffff;
    return buf;
  }
}
