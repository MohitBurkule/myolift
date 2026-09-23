/**
 * Placement check: a few seconds of standard movements after putting the sensors on give a
 * "fingerprint" of where the sensor sits. Compared with a reference fingerprint (a careful,
 * measured placement) it tells: same spot, probably higher / more outer / more inner, moved
 * or rotated, or poor skin contact. Labelled examples of deliberate offsets (e.g. "2 cm
 * higher") teach it what each mistake looks like on this person's arm.
 */

export type StepId = "rest" | "mvc" | "push" | "abduct" | "raise" | "identify";

export interface Step {
  id: StepId;
  title: string;
  text: string;
  seconds: number;
}

/** Movements per muscle. Each isolates one source: the muscle itself, a neighbouring head, or a neighbouring muscle. */
export function protocol(muscle: string, quick = false): Step[] {
  const rest: Step = { id: "rest", title: "Relax", text: "Let the arm(s) hang completely relaxed", seconds: 4 };
  const steps: Record<string, Step[]> = {
    triceps: [
      rest,
      { id: "mvc", title: "Squeeze", text: "Lock out as hard as you can: best pushing the rope or bar down against a heavy weight and holding at the bottom (or straighten the arms and tense the triceps)", seconds: 4 },
      // long head crosses the shoulder: shoulder extension fires it, the lateral head much less
      { id: "push", title: "Push back", text: "Arm straight, push it backwards as hard as you can (against a bench, wall or your other hand)", seconds: 4 },
      // only the deltoid should work here; a lot of signal means the sensor is too high
      { id: "abduct", title: "Arm out", text: "Lift the arm(s) out to the side to shoulder height and hold, elbow soft", seconds: 4 },
    ],
    biceps: [
      rest,
      { id: "mvc", title: "Squeeze", text: "Curl as hard as you can against something that doesn't move (a heavy weight or the bar holder) at 90°, or flex the biceps hard", seconds: 4 },
      // long head of biceps assists shoulder flexion
      { id: "raise", title: "Front raise", text: "Arm straight, raise it forward to shoulder height and hold", seconds: 4 },
      { id: "abduct", title: "Arm out", text: "Lift the arm(s) out to the side to shoulder height and hold", seconds: 4 },
    ],
  };
  const more: Record<string, Step[]> = {
    shoulders: [
      rest,
      { id: "mvc", title: "Push up", text: "Arm out to the side at shoulder height, push it up hard against your other hand or a fixed bar", seconds: 4 },
      // front vs side: anterior deltoid fires on the front raise, the lateral head much less
      { id: "raise", title: "Front raise", text: "Arm straight in front at shoulder height, hold", seconds: 4 },
      // pushing the arm back works the rear deltoid and the triceps long head
      { id: "push", title: "Push back", text: "Arm straight, push it backwards hard", seconds: 4 },
    ],
    forearms: [
      rest,
      { id: "mvc", title: "Grip", text: "Make a fist and squeeze as hard as you can", seconds: 4 },
      { id: "raise", title: "Wrist up", text: "Arm relaxed, bend the wrist back (knuckles up) and hold hard", seconds: 4 },
    ],
    chest: [
      rest,
      { id: "mvc", title: "Press", text: "Press your palms together in front of your chest as hard as you can", seconds: 4 },
      { id: "abduct", title: "Arm out", text: "Lift the arm out to the side and hold (shoulder, not chest)", seconds: 4 },
    ],
    lats: [
      rest,
      { id: "mvc", title: "Pull down", text: "Arm raised, pull the elbow down hard against a fixed bar or your other hand", seconds: 4 },
      { id: "abduct", title: "Arm out", text: "Lift the arm out to the side and hold (shoulder, not back)", seconds: 4 },
    ],
    quadriceps: [
      rest,
      { id: "mvc", title: "Straighten", text: "Seated, straighten the knee hard and tense the thigh", seconds: 4 },
      { id: "raise", title: "Hamstring", text: "Seated, press the heel back into the chair or floor hard", seconds: 4 },
    ],
    hamstrings: [
      rest,
      { id: "mvc", title: "Curl", text: "Seated, press the heel back into the chair or floor as hard as you can", seconds: 4 },
      { id: "raise", title: "Quad", text: "Seated, straighten the knee and tense the thigh", seconds: 4 },
    ],
    calves: [
      rest,
      { id: "mvc", title: "Toes", text: "Standing, rise onto your toes and hold hard", seconds: 4 },
    ],
  };
  const list = steps[muscle] ?? more[muscle] ?? [rest, { id: "mvc", title: "Squeeze", text: `Tense the ${muscle} as hard as you can`, seconds: 4 }];
  return quick ? list.slice(0, 2) : list;
}

export interface Fingerprint {
  /** resting envelope µV and its spread: skin contact / noise */
  restRms: number;
  /** share of resting power in the mains band (50/60 Hz and harmonics): high = poor contact */
  hum: number;
  /** envelope µV at maximum squeeze */
  mvcRms: number;
  /** median frequency during the squeeze (Hz): shifts when the sensor moves relative to the muscle */
  mdf: number;
  /** response to the other movements, relative to the squeeze (0..~1.5) */
  ratios: Partial<Record<StepId, number>>;
}

export interface StepCapture {
  env: number[]; // envelope µV
  raw: number[]; // raw µV (for hum / frequency)
}

const mean = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN);
const pct = (v: number[], q: number) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] : NaN; };

/** Power spectrum (Hann, 1024-point chunks, averaged). */
export function powerSpectrum(x: number[], n = 1024): Float64Array {
  const psd = new Float64Array(n / 2);
  const chunks = Math.floor(x.length / n);
  for (let c = 0; c < chunks; c++) {
    const re = new Float64Array(n), im = new Float64Array(n);
    let m = 0;
    for (let i = 0; i < n; i++) m += x[c * n + i];
    m /= n;
    for (let i = 0; i < n; i++) re[i] = (x[c * n + i] - m) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    fft(re, im);
    for (let i = 0; i < n / 2; i++) psd[i] += re[i] * re[i] + im[i] * im[i];
  }
  return psd;
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

/** Share of 10-450 Hz power within ±2 Hz of the mains frequency and its harmonics. */
export function humShare(raw: number[], fs: number, mains = 50): number {
  const n = 1024, psd = powerSpectrum(raw, n);
  const bin = (f: number) => Math.round((f * n) / fs);
  let total = 0, hum = 0;
  for (let i = bin(10); i <= Math.min(n / 2 - 1, bin(450)); i++) total += psd[i];
  for (let h = 1; h * mains < 450; h++) for (let i = bin(h * mains - 2); i <= bin(h * mains + 2); i++) hum += psd[i] ?? 0;
  return total > 0 ? hum / total : 0;
}

export function medianFreq(raw: number[], fs: number): number {
  const n = 1024, psd = powerSpectrum(raw, n);
  const lo = Math.round((20 * n) / fs), hi = Math.min(n / 2 - 1, Math.round((450 * n) / fs));
  let total = 0;
  for (let i = lo; i <= hi; i++) total += psd[i];
  let acc = 0;
  for (let i = lo; i <= hi; i++) { acc += psd[i]; if (acc >= total / 2) return (i * fs) / n; }
  return NaN;
}

/** Build the fingerprint from the captured steps (first 0.7 s of each step dropped: reaction time). */
export function fingerprint(caps: Partial<Record<StepId, StepCapture>>, fs: number, mains = 50): Fingerprint | null {
  const trim = (c?: StepCapture) => c && { env: c.env.slice(Math.round(0.7 * fs)), raw: c.raw.slice(Math.round(0.7 * fs)) };
  const rest = trim(caps.rest), mvc = trim(caps.mvc);
  if (!rest || !mvc || rest.env.length < fs || mvc.env.length < fs) return null;
  const mvcRms = pct(mvc.env, 0.9);
  const ratios: Fingerprint["ratios"] = {};
  for (const id of ["push", "abduct", "raise"] as StepId[]) {
    const c = trim(caps[id]);
    if (c && c.env.length >= fs) ratios[id] = pct(c.env, 0.9) / mvcRms;
  }
  return { restRms: mean(rest.env), hum: humShare(rest.raw, fs, mains), mvcRms, mdf: medianFreq(mvc.raw, fs), ratios };
}

/* ---------------- comparison ---------------- */

export interface Verdict {
  status: "match" | "differs" | "contact" | "no-reference";
  /** 0..100: how close to the reference */
  similarity: number | null;
  messages: string[];
  /** closest labelled example (when a library of offsets exists) */
  closest?: { label: string; distance: number };
}

export interface Labelled { label: string; fp: Fingerprint }

/** Normalised feature vector: logs for amplitudes (contact changes them multiplicatively). */
function features(f: Fingerprint): number[] {
  return [
    Math.log(Math.max(f.mvcRms, 1e-3)) * 1.0,
    Math.log(Math.max(f.restRms, 1e-3)) * 0.6,
    (f.mdf || 0) / 40,
    f.hum * 4,
    (f.ratios.push ?? 0) * 4,
    (f.ratios.abduct ?? 0) * 5,
    (f.ratios.raise ?? 0) * 4,
  ];
}

export function distance(a: Fingerprint, b: Fingerprint): number {
  const x = features(a), y = features(b);
  return Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]) ** 2, 0));
}

export function compare(now: Fingerprint, ref: Fingerprint | null, library: Labelled[] = []): Verdict {
  if (!ref) return { status: "no-reference", similarity: null, messages: ["No reference yet: save this one as your reference if the sensor is where you want it."] };
  const msgs: string[] = [];
  let contact = false, differs = false;
  // skin contact first: noise and mains hum rise, the muscle signal doesn't explain it
  if (now.restRms > 2 * ref.restRms && now.restRms > 5) { contact = true; msgs.push(`Resting noise ${(now.restRms / ref.restRms).toFixed(1)}× higher than your reference: poor skin contact. Press the sensor on or tighten the strap.`); }
  if (now.hum > ref.hum + 0.25) { contact = true; msgs.push("Strong mains hum: poor skin contact (dry skin or loose strap)."); }
  const da = now.ratios.abduct, ra = ref.ratios.abduct;
  if (da !== undefined && ra !== undefined && da > ra + 0.12 && da > ra * 1.5) { differs = true; msgs.push("More shoulder (deltoid) signal when lifting the arm out: the sensor is probably higher than usual."); }
  if (da !== undefined && ra !== undefined && da < ra - 0.1 && ra > 0.15) msgs.push("Less shoulder signal than usual: probably a little lower than your reference.");
  const dp = now.ratios.push, rp = ref.ratios.push;
  if (dp !== undefined && rp !== undefined && rp > 0.1) {
    if (dp < rp * 0.65) { differs = true; msgs.push("Weaker response to pushing the arm back (long head): probably more to the outside of the arm."); }
    else if (dp > rp * 1.5) { differs = true; msgs.push("Stronger response to pushing the arm back (long head): probably more to the inside / back of the arm."); }
  }
  const dr = now.ratios.raise, rr = ref.ratios.raise;
  if (dr !== undefined && rr !== undefined && rr > 0.1 && (dr < rr * 0.65 || dr > rr * 1.5)) { differs = true; msgs.push("Different response to the front raise: probably moved across the biceps (inner/outer)."); }
  const amp = now.mvcRms / ref.mvcRms, df = now.mdf / ref.mdf;
  if (!contact && (amp < 0.6 || amp > 1.7 || Math.abs(df - 1) > 0.15)) {
    differs = true;
    msgs.push(`Signal size ${amp.toFixed(1)}× and frequency ${df > 1 ? "+" : "−"}${Math.round(Math.abs(df - 1) * 100)}% vs your reference: probably moved along the arm or rotated.`);
  }
  const d = distance(now, ref);
  const similarity = Math.round(100 * Math.exp(-d / 1.5));
  let closest: Verdict["closest"];
  if (library.length) {
    const all = [{ label: "reference", fp: ref }, ...library].map((l) => ({ label: l.label, distance: distance(now, l.fp) })).sort((a, b) => a.distance - b.distance);
    closest = all[0];
    if (closest.label !== "reference") msgs.push(`Closest to your recorded example "${closest.label}".`);
  }
  const status: Verdict["status"] = contact ? "contact" : differs || (closest && closest.label !== "reference") ? "differs" : "match";
  if (status === "match") msgs.unshift("Same spot as your reference ✓");
  return { status, similarity, messages: msgs, closest };
}

export const OFFSET_LABELS = ["2 cm higher", "2 cm lower", "more outer", "more inner", "rotated", "loose strap"];

/** First step when a muscle has a sensor on each arm: work only the left arm, so the app can tell the two identical sensors apart. */
export function identifyStep(muscle: string): Step {
  const how: Record<string, string> = {
    triceps: "straighten it and tense the triceps hard",
    biceps: "bend it and flex the biceps hard",
    forearms: "make a tight fist",
  };
  return { id: "identify", title: "Left arm", text: `Only your LEFT arm: ${how[muscle] ?? "tense the muscle hard"}. Keep the right arm relaxed.`, seconds: 4 };
}

export interface ArmPlacement { sensorId: string; muscle: string; side: "left" | "right" }
export interface ArmCheck { sensorId: string; muscle: string; side: "left" | "right"; changed: boolean }

/** Muscles with exactly two sensors: the ones to identify. */
export function armPairs<P extends ArmPlacement>(ps: P[]): P[][] {
  const by = new Map<string, P[]>();
  for (const p of ps) by.set(p.muscle, [...(by.get(p.muscle) ?? []), p]);
  return [...by.values()].filter((g) => g.length === 2);
}

/**
 * Which sensor is on the left arm: the one that fired while only the left arm worked
 * (median envelope at least 1.8x the other). Returns null for a pair it can't tell apart.
 */
export function assignArms<P extends ArmPlacement>(ps: P[], env: Map<string, number[]>, fs: number): { placements: P[]; checks: ArmCheck[]; unsure: string[] } {
  const level = (id: string) => { const e = (env.get(id) ?? []).slice(Math.round(fs)).filter((v) => v === v).sort((a, b) => a - b); return e.length ? e[e.length >> 1] : 0; };
  const out = new Map(ps.map((p) => [p.sensorId, p]));
  const checks: ArmCheck[] = [], unsure: string[] = [];
  for (const [a, b] of armPairs(ps)) {
    const la = level(a.sensorId), lb = level(b.sensorId);
    if (Math.max(la, lb) < 1.8 * Math.max(Math.min(la, lb), 1e-9)) { unsure.push(a.muscle); continue; }
    const [left, right] = la > lb ? [a, b] : [b, a];
    for (const [p, side] of [[left, "left"], [right, "right"]] as const) {
      out.set(p.sensorId, { ...p, side });
      checks.push({ sensorId: p.sensorId, muscle: p.muscle, side, changed: p.side !== side });
    }
  }
  return { placements: ps.map((p) => out.get(p.sensorId)!), checks, unsure };
}
