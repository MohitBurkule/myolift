"""
Fatigue fitted to range-of-motion loss (video): the most consistent within-set fatigue sign.
Rep ROM (relative to the recording's full reps) = 1 when the effort needed a < a0, else falls:
   romRel = clip(1 - s * (a - a0), 0.2, 1.1)       a = W_eff / (F0 * C) at the rep's start
Capacity from the effort-driven fast+slow fatigue model (counts.py). Rope sets only; holds sets excluded
(ROM there is deliberately short). Validation: leave-one-set-out prediction of each set's rep ROM,
against baselines (overall mean ROM; each set's own first-rep ROM carried forward).
"""
import itertools, json, collections, numpy as np
import counts as K
from counts import rope, events, groups, step, rest, W0
SKIP = ("hold_stretch", "hold_mid", "hold_lockout", "partial_bottom_half", "partial_top_half", "unilateral_ecc", "usual_mix")  # deliberate partials excluded
SETS = [g for g in groups if g[1] not in SKIP]

def rep_effort(P):
    Df = Ds = 0.0; t = 0.0; A = {}
    for g, ks in groups.items():
        for k in ks:
            s, e, W = events[k]; Df, Ds = rest(P, max(0, s - t), Df, Ds)
            A[k] = (W + W0) / (P["F0"] * max(0.05, 1 - Df - Ds))
            Df, Ds, _ = step(P, W, e - s, Df, Ds); t = e
    return A

def pred_rom(a, a0, s): return float(np.clip(1 - s * (a - a0) if a > a0 else 1.0, 0.2, 1.1))

GRID = dict(F0=[45, 55, 65, 80, 100], kf1=[0.0, 0.005, 0.01, 0.02, 0.04], kr1=[0.01, 0.03, 0.1],
            kf2=[0.0, 0.0005, 0.001, 0.002], kr2=[1/3600, 1/900])
A0S = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9]; SS = [0.5, 1, 2, 3, 5]

def err(P, a0, s, use, A):
    e = []
    for g in use:
        for k in groups[g]:
            if rope[k]["romRel"] is None: continue
            e.append(pred_rom(A[k], a0, s) - min(1.1, rope[k]["romRel"]))
    return float(np.mean(np.abs(e))) if e else 9

def fit(use):
    best = None
    for vals in itertools.product(*GRID.values()):
        P = dict(zip(GRID.keys(), vals)); A = rep_effort(P)
        for a0 in A0S:
            for s in SS:
                m = err(P, a0, s, use, A)
                if best is None or m < best[0]: best = (m, P, a0, s)
    return best

if __name__ == "__main__":
    OUT = K.F.OUT
    m, P, a0, s = fit(SETS); A = rep_effort(P)
    print("ALL", P, "a0", a0, "s", s, "MAE romRel", round(m, 3))
    base_mean = float(np.mean([min(1.1, rope[k]["romRel"]) for g in SETS for k in groups[g] if rope[k]["romRel"] is not None]))
    rows = []
    for g in SETS:
        mm, P2, a02, s2 = fit([h for h in SETS if h != g]); A2 = rep_effort(P2)
        obs = [min(1.1, rope[k]["romRel"]) for k in groups[g] if rope[k]["romRel"] is not None]
        pr = [pred_rom(A2[k], a02, s2) for k in groups[g] if rope[k]["romRel"] is not None]
        mae = float(np.mean(np.abs(np.array(pr) - obs))); b1 = float(np.mean(np.abs(np.array(obs) - base_mean)))
        b2 = float(np.mean(np.abs(np.array(obs) - obs[0])))
        rows.append({"set": f"{g[0]} {g[1]} {g[2]}", "n": len(obs), "model": round(mae, 3), "mean_baseline": round(b1, 3), "first_rep_baseline": round(b2, 3), "P": P2, "a0": a02, "s": s2})
        print(rows[-1]["set"], "n", len(obs), "model", round(mae, 3), "mean", round(b1, 3), "first-rep", round(b2, 3))
    tot = lambda key: float(np.average([r[key] for r in rows], weights=[r["n"] for r in rows]))
    print("LOSO weighted MAE: model", round(tot("model"), 3), "mean baseline", round(tot("mean_baseline"), 3), "first-rep baseline", round(tot("first_rep_baseline"), 3))
    json.dump({"all": {"P": P, "a0": a0, "s": s, "mae": m}, "loso": rows,
               "effort_per_rep": {f"{rope[k]['exp']}#{rope[k]['i']}": round(A[k], 3) for k in A}}, open(f"{OUT}/romfit.json", "w"), indent=1)
