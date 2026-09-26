/**
 * Is what I did useful for growth? Detected techniques in a session → a verdict from the research,
 * always shown with the user's own numbers that triggered it.
 */
import type { SessionInsights, SetRow } from "./insights";

export type Verdict = "helpful" | "neutral" | "less_effective" | "unknown";
export interface Research { verdict: Verdict; title: string; summary: string; strength: string; source: string }

export const RESEARCH: Record<string, Research> = {
  one_arm_eccentric: {
    verdict: "neutral", title: "Lowering with one arm",
    summary: "A 2026 meta-analysis of 49 studies found extra eccentric load gives no more growth than normal reps; upper-body eccentrics may have a small edge. Fine as a way to make sets harder, not a growth multiplier. Expect more soreness.",
    strength: "moderate", source: "AEL vs constant load meta-analysis, Sports Med 2026; Eccentric vs concentric meta-analysis, JSCR 2024",
  },
  drop_set: {
    verdict: "helpful", title: "Drop set",
    summary: "Same growth as normal sets in about half to a third of the time, as long as each drop goes near failure.",
    strength: "moderate", source: "Sødal et al. 2023; Coleman et al. 2022",
  },
  slow_tempo: {
    verdict: "less_effective", title: "Very slow reps (over 10 s)",
    summary: "Reps from 0.5 to 8 s grow muscle about equally; slower than ~10 s grows less. Slow reps add time, not stimulus.",
    strength: "moderate", source: "Schoenfeld et al. 2015 meta-analysis",
  },
  normal_tempo: {
    verdict: "helpful", title: "Your usual tempo",
    summary: "Reps of about 2–8 s are in the range that works.",
    strength: "moderate", source: "Schoenfeld et al. 2015 meta-analysis",
  },
  partial_short: {
    verdict: "less_effective", title: "Partials near lockout (arms straight end)",
    summary: "Partials at the short end (arms straight) grow less than full reps or partials at the stretch.",
    strength: "low–moderate", source: "Wolf et al. 2023 meta-analysis; Pedrosa et al. 2022",
  },
  partial_long: {
    verdict: "helpful", title: "Partials at the stretch (elbows bent end)",
    summary: "Partials at the stretched end grow about as much as, or slightly more than, full reps. Good for extending a set past full-rep failure.",
    strength: "low–moderate", source: "Wolf et al. 2023; Kassiano/PeerJ 2025 trained lifters",
  },
  hold_stretch: {
    verdict: "helpful", title: "Holds at the stretch",
    summary: "Holds at long muscle length grow more than holds at short length; add weight rather than time.",
    strength: "low", source: "Oranchuk et al. 2019 isometric review",
  },
  hold_lockout: {
    verdict: "less_effective", title: "Holds at lockout",
    summary: "Short-length holds are the weakest isometric stimulus; with the arms locked the joint takes much of the load.",
    strength: "low", source: "Oranchuk et al. 2019 isometric review",
  },
  near_failure: {
    verdict: "helpful", title: "Sets close to failure",
    summary: "Sets close to failure grow slightly more; count them as hard sets.",
    strength: "moderate", source: "Refalo et al. 2023",
  },
  short_rest: {
    verdict: "less_effective", title: "Short rests (under 60 s)",
    summary: "Rests over ~60–90 s give slightly more growth, probably by preserving reps.",
    strength: "low–moderate", source: "Singer et al. 2024 Bayesian meta-analysis",
  },
  long_rest: {
    verdict: "neutral", title: "Long rests (over 90 s)",
    summary: "No clear extra benefit beyond ~90 s.",
    strength: "low–moderate", source: "Singer et al. 2024 Bayesian meta-analysis",
  },
  late_session: {
    verdict: "neutral", title: "Sets late in the session",
    summary: "Exercise order doesn't change growth much overall, but later sets give fewer reps; put the most important sets first.",
    strength: "moderate", source: "Nunes et al. 2021 exercise-order meta-analysis",
  },
  pushdown_only: {
    verdict: "neutral", title: "Only pushdowns for triceps",
    summary: "Overhead extensions grew the triceps ~40% more than pushdowns in 12 weeks (long head stretched). Add one overhead exercise.",
    strength: "moderate (single RCT)", source: "Maeo et al. 2023",
  },
  dips: {
    verdict: "neutral", title: "Dips",
    summary: "High triceps EMG, but EMG level isn't a validated growth predictor; treat dips as a good compound option, not proven better.",
    strength: "low", source: "Vigotsky et al. 2022",
  },
};

export interface TechniqueCard extends Research { key: string; yours: string; sets: string[] }

export interface SessionContext {
  /** per recording id: free text that says what was done (preset, exercise, notes) */
  labels: Record<string, string>;
  /** per set id: holds (from the set model) */
  holds?: Record<string, { where: "stretch" | "mid" | "lockout"; s: number }[]>;
}

const f1 = (v: number | null | undefined, d = 1) => (v === null || v === undefined || v !== v ? "–" : v.toFixed(d));
const has = (text: string, re: RegExp) => re.test(text.toLowerCase());

export function detectTechniques(ins: SessionInsights, ctx: SessionContext): TechniqueCard[] {
  const out: TechniqueCard[] = [];
  const text = (s: SetRow) => `${s.label} ${s.exercise} ${ctx.labels[s.rec] ?? ""}`.toLowerCase();
  const add = (key: string, yours: string, sets: SetRow[] = []) => out.push({ key, ...RESEARCH[key], yours, sets: [...new Set(sets.map((s) => s.set))] });
  const S = ins.sets, m = ins.metrics;
  const allText = [...Object.values(ctx.labels), ...S.map((s) => `${s.label} ${s.exercise}`)].join(" ").toLowerCase();

  // one-arm eccentric: labelled, or one arm's share of the lowering clearly above the session's usual
  const oneArm = S.filter((s) => has(text(s), /unilateral|one.?arm|one.?hand|single.?arm/) || (s.eccLR !== null && (s.eccLR >= 1.4 || s.eccLR <= 0.71) && s.conLR !== null && s.conLR > 0.8 && s.conLR < 1.25));
  if (oneArm.length) {
    const e = oneArm.map((s) => s.eccLR).filter((v): v is number => v !== null);
    const med = e.length ? e.sort((a, b) => a - b)[e.length >> 1] : null;
    const shown = med !== null && (med >= 1.25 || med <= 0.8);
    const arm = med !== null && med < 1 ? "right" : "left", x = med === null ? NaN : med < 1 ? 1 / med : med;
    add("one_arm_eccentric", med === null ? "No two-sensor EMG for these sets." : shown
      ? `During the lowering, your ${arm} arm's share of the EMG was ${f1(x, 1)}× its usual share this session, so it did take more of the load.`
      : `During the lowering, the left/right EMG split was ${f1(med, 2)}× your usual (1.0 = usual): your EMG didn't show one arm taking much more of the load this time.`, oneArm);
  }
  for (const d of m.dropSets) {
    const a = d.effortPerKg[0], b = d.effortPerKg[d.effortPerKg.length - 1];
    add("drop_set", `${d.weights.join(" → ")} kg, reps ${d.reps.join(", ")}. Effort per kg went ${f1(a, 2)} → ${f1(b, 2)}: ${b > 1.3 * a ? "your effort stayed near its maximum as the weight fell, which is what makes the drops count." : "effort didn't stay high; push each drop closer to failure."}`,
      S.filter((s) => s.rec === d.rec));
  }
  const slow = S.filter((s) => s.repS > 10);
  if (slow.length) add("slow_tempo", `Rep time ${slow.map((s) => `${f1(s.repS)} s`).join(", ")} (push ${f1(slow[0].tutCon / slow[0].n)} s, lower ${f1(slow[0].tutEcc / slow[0].n)} s).`, slow);
  if (m.conS !== null && m.eccS !== null) {
    const rep = m.conS + m.eccS;
    if (rep >= 2 && rep <= 8) add("normal_tempo", `Median rep: ${f1(m.conS)} s up, ${f1(m.eccS)} s down. Lowering EMG is ${f1(m.eccConRatio, 2)}× the push.`);
  }
  const pShort = S.filter((s) => s.partialsLockout >= 3 || has(text(s), /partial_bottom_half|reps_partial_top\b|bottom half/));
  const nP = (ss: SetRow[], key: "partialsLockout" | "partialsStretch", re: RegExp) => ss.reduce((n, s) => n + (has(text(s), re) ? Math.max(s[key], s.n - s.full) : s[key]), 0);
  if (pShort.length) add("partial_short", `${nP(pShort, "partialsLockout", /partial_bottom_half|reps_partial_top\b|bottom half/)} reps stopped near lockout without going up to the stretch.`, pShort);
  const pLong = S.filter((s) => s.partialsStretch >= 3 || has(text(s), /partial_top_half|reps_partial_bottom\b|top half/));
  if (pLong.length) add("partial_long", `${nP(pLong, "partialsStretch", /partial_top_half|reps_partial_bottom\b|top half/)} reps stayed at the stretched end.`, pLong);
  const hold = (where: "stretch" | "lockout", re: RegExp) => S.filter((s) => has(text(s), re) || (ctx.holds?.[s.set] ?? []).some((h) => h.where === where && h.s >= 2));
  const hs = hold("stretch", /hold_stretch|hold at (the )?stretch/);
  if (hs.length) add("hold_stretch", `Held at the stretch at ${[...new Set(hs.map((s) => s.w))].join(", ")} kg; effort per kg ${hs.map((s) => f1(s.effortPerKg, 2)).join(", ")}.`, hs);
  const hl = hold("lockout", /hold_lockout|hold at (the )?lockout|hold at top/);
  if (hl.length) add("hold_lockout", `Held at lockout at ${[...new Set(hl.map((s) => s.w))].join(", ")} kg; effort per kg ${hl.map((s) => f1(s.effortPerKg, 2)).join(", ")}${hs.length ? ` (stretch holds: ${hs.map((s) => f1(s.effortPerKg, 2)).join(", ")})` : ""}.`, hl);
  const fail = S.filter((s) => (s.rir !== null && s.rir <= 1.5) || s.endedInPartials);
  if (fail.length) add("near_failure", `${fail.length} set${fail.length > 1 ? "s" : ""} ended at or near failure (${fail.filter((s) => s.rir !== null && s.rir <= 1.5).length} rated 0–1 reps left, ${fail.filter((s) => s.endedInPartials).length} ended in half reps).`, fail);
  // rests between sets (not the quick weight changes inside a drop set)
  const rests = S.filter((s, i) => i > 0 && !(s.rec === S[i - 1].rec && s.w < S[i - 1].w)).map((s) => s.restBeforeS).filter((v): v is number => v !== null && v > 5 && v < 1200);
  if (rests.length >= 3) {
    const med = rests.sort((a, b) => a - b)[rests.length >> 1];
    if (med < 60) add("short_rest", `Median rest ${Math.round(med)} s between sets.`);
    else if (med > 90) add("long_rest", `Median rest ${Math.round(med)} s between sets${m.restRecoveryR !== null ? `; longer rests didn't lower the effort per kg of the next set's first reps (r = ${f1(m.restRecoveryR, 2)})` : ""}.`);
  }
  if (m.effortPerKgChangePct !== null && m.effortPerKgChangePct > 10) {
    const late = S.filter((s) => s.tMin > ins.durationMin * 0.6);
    add("late_session", `The same weights cost ${Math.round(m.effortPerKgChangePct)}% more effort per kg by the end (${f1(m.effortPerKgFirst, 2)} → ${f1(m.effortPerKgLast, 2)}); efficiency fell ${f1(Math.abs(m.nmeChangePer10Min ?? NaN))}% per 10 min.`, late);
  }
  const tri = S.filter((s) => has(text(s), /tricep|push.?down|rope|press.?down|extension|dip|kickback/));
  if (tri.length && !has(allText, /overhead|french|skull|extension/) ) add("pushdown_only", `${tri.length} triceps sets, all with the arms at your sides.`, tri);
  const dips = S.filter((s) => has(text(s), /\bdip/));
  if (dips.length) add("dips", `${dips.length} dip set${dips.length > 1 ? "s" : ""}; effort per kg isn't comparable to the rope because the machine assists.`, dips);
  return out;
}
