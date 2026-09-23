/**
 * Learn rep-detection settings per exercise from the user's corrections: every corrected set
 * (its activation + the true number of full reps) is a label; a small grid search finds the
 * prominence and full-rep rule that reproduce all labels best. Different exercises give very
 * different EMG shapes (a rope pushdown peaks at lockout, a pushdown machine relaxes there),
 * so each exercise keeps its own settings.
 */
import { averageActivation, DEFAULT_DIP, DEFAULT_REP, detectReps, type Channel, type RepParams, type Span } from "./workout";

export interface RepLabel { channels: Channel[]; span: Span; full: number }

/** Full reps the detector finds in a set with these settings (both arms combined when both worked). */
export function countFull(channels: Channel[], span: Span, p: RepParams): number {
  if (!channels.length) return 0;
  const reps = channels.length === 2 && channels[0].muscle === channels[1].muscle && channels[0].side !== channels[1].side
    ? detectReps(averageActivation(channels[0].act, channels[1].act), span, p)
    : channels.map((c) => detectReps(c.act, span, p)).sort((a, b) => b.length - a.length)[0];
  return reps.filter((r) => (r.range ?? "full") === "full").length;
}

export interface Tuned { params: RepParams; error: number; n: number }

export function tuneRepParams(labels: RepLabel[], mode: "peak" | "dip"): Tuned {
  const base = mode === "dip" ? DEFAULT_DIP : DEFAULT_REP;
  if (!labels.length) return { params: base, error: 0, n: 0 };
  let best: Tuned | null = null, bestTie = Infinity;
  for (let promFrac = 0.14; promFrac <= 0.62; promFrac += 0.04) {
    for (let depth = 0.15; depth <= 0.7; depth += 0.05) {
      const p: RepParams = { mode, promFrac: +promFrac.toFixed(2), depth: +depth.toFixed(2) };
      let err = 0;
      for (const l of labels) err += Math.abs(countFull(l.channels, l.span, p) - l.full);
      // tie-break: stay close to the defaults
      const tie = Math.abs(p.promFrac - base.promFrac) + Math.abs(p.depth - base.depth);
      if (!best || err < best.error || (err === best.error && tie < bestTie)) { best = { params: p, error: err, n: labels.length }; bestTie = tie; }
    }
  }
  return best!;
}
