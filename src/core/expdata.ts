/**
 * Pure helpers for experiment metadata: defaults for older files, the weight timeline, the notes
 * changelog (autosave + undo), a generic edit log, and turning a day of experiments into one
 * workout (events + per-experiment time shifts). No file I/O here.
 */

export interface WeightChange { t: number; kg: number } // t: s since the experiment started
export interface NotesVersion { at: number; text: string } // at: wall clock ms
export interface EditEntry { at: number; field: string; before: unknown; after: unknown }

/** Missing fields in experiment.json from older builds get safe defaults (never throws). */
export function normalizeMeta<T extends Record<string, any>>(raw: T): T & { weights: WeightChange[]; notesHistory: NotesVersion[]; edits: EditEntry[]; audio: boolean; notes: string; marks: { t: number; label: string }[] } {
  const r: any = { ...raw };
  r.notes = typeof r.notes === "string" ? r.notes : "";
  r.marks = Array.isArray(r.marks) ? r.marks : [];
  r.weights = Array.isArray(r.weights) ? r.weights.filter((w: any) => w && Number.isFinite(w.t) && Number.isFinite(w.kg)) : [];
  if (!r.weights.length && Number.isFinite(r.weight)) r.weights = [{ t: 0, kg: r.weight }];
  r.notesHistory = Array.isArray(r.notesHistory) ? r.notesHistory : [];
  r.edits = Array.isArray(r.edits) ? r.edits : [];
  r.audio = !!r.audio;
  return r;
}

/* ---------------- weight timeline ---------------- */

const sortW = (w: WeightChange[]) => [...w].sort((a, b) => a.t - b.t);

/** Set the weight at time t (replaces a change within 0.5 s of t). */
export function setWeightAt(list: WeightChange[], t: number, kg: number): WeightChange[] {
  return sortW([...list.filter((w) => Math.abs(w.t - t) > 0.5), { t: Math.max(0, t), kg }]);
}
export function removeWeightAt(list: WeightChange[], index: number): WeightChange[] {
  return sortW(list).filter((_, i) => i !== index);
}
export function weightAt(list: WeightChange[], t: number): number | null {
  let v: number | null = null;
  for (const w of sortW(list)) if (w.t <= t + 1e-9) v = w.kg;
  return v ?? (list.length ? sortW(list)[0].kg : null);
}

/* ---------------- notes changelog ---------------- */

/**
 * Record a new notes text. Edits within `mergeMs` of the last version replace it (typing), so the
 * history holds meaningful versions, not every keystroke. The previous text is always kept.
 */
export function pushNotes(history: NotesVersion[], previous: string, text: string, now: number, mergeMs = 5000): NotesVersion[] {
  if (text === previous) return history;
  const h = history.length ? [...history] : [{ at: now - mergeMs - 1, text: previous }];
  const last = h[h.length - 1];
  if (h.length > 1 && now - last.at < mergeMs) h[h.length - 1] = { at: now, text };
  else h.push({ at: now, text });
  return h.slice(-200);
}

/** Undo: the text before the current one, and the history without the current version. */
export function undoNotes(history: NotesVersion[]): { text: string; history: NotesVersion[] } | null {
  if (history.length < 2) return null;
  const h = history.slice(0, -1);
  return { text: h[h.length - 1].text, history: h };
}

/* ---------------- edit log (weights etc.) ---------------- */

export function logEdit(edits: EditEntry[], field: string, before: unknown, after: unknown, now: number): EditEntry[] {
  return [...edits, { at: now, field, before: clone(before), after: clone(after) }].slice(-500);
}
/** Undo the last edit: returns the field and the value to restore. */
export function undoEdit(edits: EditEntry[]): { field: string; value: unknown; edits: EditEntry[] } | null {
  if (!edits.length) return null;
  const e = edits[edits.length - 1];
  return { field: e.field, value: clone(e.before), edits: edits.slice(0, -1) };
}
const clone = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/* ---------------- experiments -> one workout ---------------- */

export interface ExpForImport {
  id: string;
  title: string;
  notes: string;
  startedAt: string;
  endedAt?: string;
  durationS?: number;
  originNative: number;
  exercise: { id: string; name: string } | null;
  unit: string;
  weights: WeightChange[];
  placements: { sensorId: string; sensorName?: string; muscle: string; side: "left" | "right" }[];
  calibrations: Record<string, { ref: unknown; snrDb: number }>;
}

/**
 * Lay the experiments out on one timeline (ms since the first one started). The phone's
 * elapsed-realtime clock is used when all were recorded in one boot (it can't jump), otherwise
 * the wall clock. Returns the shift for each experiment's EMG rows and the workout events.
 */
export function buildImport(exps: ExpForImport[]) {
  const list = [...exps].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const wall = (e: ExpForImport) => new Date(e.startedAt).getTime();
  const nativeOk = list.every((e) => e.originNative > 0) && list.every((e, i) => i === 0 || Math.abs((e.originNative - list[0].originNative) - (wall(e) - wall(list[0]))) < 60_000);
  const shift = new Map<string, number>();
  for (const e of list) shift.set(e.id, nativeOk ? e.originNative - list[0].originNative : wall(e) - wall(list[0]));
  const events: Record<string, unknown>[] = [];
  const first = list[0];
  if (first) {
    events.push({ t: 0, type: "placement", placements: first.placements });
    for (const p of first.placements) {
      const c = first.calibrations[`${p.sensorId}|${p.muscle}|${p.side}`];
      if (c) events.push({ t: 0, type: "calibration", sensorId: p.sensorId, muscle: p.muscle, side: p.side, ref: c.ref, snrDb: c.snrDb });
    }
  }
  for (const e of list) {
    const t0 = shift.get(e.id)!;
    if (e.exercise) events.push({ t: t0, type: "exercise", exerciseId: e.exercise.id, name: e.exercise.name });
    for (const w of sortW(e.weights)) events.push({ t: t0 + w.t * 1000, type: "weight", value: w.kg, unit: e.unit });
    events.push({ t: t0, type: "note", text: `Experiment: ${e.title}${e.notes ? ` · ${e.notes}` : ""}` });
  }
  events.sort((a, b) => (a.t as number) - (b.t as number));
  const last = list[list.length - 1];
  const endedAt = last ? new Date(wall(last) + (last.durationS ?? 0) * 1000).toISOString() : undefined;
  return { shift, events, startedAt: first?.startedAt, endedAt, nativeClock: nativeOk };
}

/** Shift the timestamps of raw EMG rows (252 bytes: float64 LE ms + 244-byte packet). Returns a new buffer. */
export function shiftRows(bytes: Uint8Array, shiftMs: number, rowBytes = 252): Uint8Array {
  const out = new Uint8Array(bytes.length - (bytes.length % rowBytes));
  out.set(bytes.subarray(0, out.length));
  const v = new DataView(out.buffer);
  for (let o = 0; o + rowBytes <= out.length; o += rowBytes) v.setFloat64(o, v.getFloat64(o, true) + shiftMs, true);
  return out;
}
