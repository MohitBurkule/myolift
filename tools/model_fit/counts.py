"""
Fatigue/capacity fitted to what the user actually achieved (reps per set, failures), not to EMG amplitude.
State: fast + slow fatigue pools, effort-driven (XF style). Capacity C = 1 - Df - Ds.
For every rope set: replay the real session up to its start, then
  - failure sets (drop-set segments, the 45 kg max-reps set): predicted reps until a > 1 vs observed full reps
  - other sets: constraint that every performed rep had a <= 1 (they didn't fail)
"""
import itertools, json, collections, numpy as np
import fit as F
rope, events = F.rope, F.events
W0 = 3.0
groups = collections.OrderedDict()
for k, q in enumerate(rope): groups.setdefault((q["exp"], q["q"], q["w"]), []).append(k)
FAILSETS = [g for g in groups if g[1] in ("dropset", "heavy_normal")]
OBS = {g: sum(int(rope[k]["full"]) for k in groups[g]) for g in FAILSETS}

def step(P, W, dur, Df, Ds, dt=0.5):
    u = (W + W0) / P["F0"]; n = max(1, int(dur / dt)); d = dur / n; amax = 0.0
    for _ in range(n):
        C = max(0.05, 1 - Df - Ds); a = u / C; amax = max(amax, a)
        a = min(a, 1.0); Df += P["kf1"] * a * d; Ds += P["kf2"] * a * d
    return Df, Ds, amax

def rest(P, dur, Df, Ds):
    return Df * np.exp(-P["kr1"] * dur), Ds * np.exp(-P["kr2"] * dur)

def simulate(P, targets=FAILSETS):
    """Returns predicted reps for target sets, and the max effort reached in non-failure sets."""
    Df = Ds = 0.0; t = 0.0; pred = {}; worst = {}
    for g, ks in groups.items():
        if g in targets:
            s0 = events[ks[0]][0]; Df, Ds = rest(P, max(0, s0 - t), Df, Ds)
            span = float(np.median([events[k][1] - events[k][0] for k in ks if rope[k]["full"]] or [5.0]))
            n = 0; D2 = (Df, Ds)
            while n < 40:
                C = 1 - D2[0] - D2[1]
                if (g[2] + W0) / (P["F0"] * C) > 1: break
                a, b, _ = step(P, g[2], span, D2[0], D2[1]); D2 = (a, b); n += 1
            pred[g] = n
        for k in ks:   # real timeline continues with what was actually done
            s, e, W = events[k]; Df, Ds = rest(P, max(0, s - t), Df, Ds)
            Df, Ds, am = step(P, W, e - s, Df, Ds); t = e
            if g not in FAILSETS and rope[k]["full"]: worst[g] = max(worst.get(g, 0), am)
    return pred, worst

def loss(P, use):
    pred, worst = simulate(P)
    l = sum((pred[g] - OBS[g]) ** 2 for g in use)
    l += sum(20 * max(0, a - 1.0) ** 2 * 100 for a in worst.values())   # non-failure sets must stay possible
    return l, pred

GRID = dict(F0=[45, 50, 55, 60, 65, 70, 80, 95], kf1=[0.0, 0.005, 0.01, 0.02, 0.04], kr1=[0.01, 0.02, 0.05, 0.1],
            kf2=[0.0, 0.0005, 0.001, 0.002, 0.004], kr2=[1/3600, 1/1200, 1/600])

def fit(use):
    best = None
    for vals in itertools.product(*GRID.values()):
        P = dict(zip(GRID.keys(), vals))
        l, pred = loss(P, use)
        if best is None or l < best[0]: best = (l, P, pred)
    return best

if __name__ == "__main__":
    import sys
    OUT = F.OUT; res = {}
    allsets = FAILSETS
    l, P, pred = fit(allsets); print("ALL", P, "loss", l, {g[2]: (pred[g], OBS[g]) for g in allsets})
    res["all"] = {"P": P, "pred": {f"{g[1]} {g[2]}": pred[g] for g in allsets}, "obs": {f"{g[1]} {g[2]}": OBS[g] for g in allsets}}
    for hold in (["dropset"], ["heavy_normal"]):
        use = [g for g in allsets if g[1] not in hold]
        l, P2, _ = fit(use); pred2, _ = simulate(P2)
        held = [g for g in allsets if g[1] in hold]
        print("LOO", hold, P2, {g[2]: (pred2[g], OBS[g]) for g in held})
        res[f"loo_{hold[0]}"] = {"P": P2, "pred": {f"{g[2]}": pred2[g] for g in held}, "obs": {f"{g[2]}": OBS[g] for g in held}}
    # leave-one-segment-out within the drop set
    errs = []
    for g in allsets:
        l, P3, _ = fit([h for h in allsets if h != g]); p3, _ = simulate(P3); errs.append((g[2], p3[g], OBS[g]))
    print("leave-one-set-out", errs, "MAE", np.mean([abs(a - b) for _, a, b in errs]))
    res["loso"] = errs
    json.dump(res, open(f"{OUT}/counts_fit.json", "w"), indent=1, default=str)
