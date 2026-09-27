import json, numpy as np, collections
from scipy.optimize import least_squares
import fit as F
from model2 import unpack, capacity_timeline
OUT = F.OUT
rope, events = F.rope, F.events

def resid(p, rows, fails, wf=10.0):
    P = unpack(p); caps = capacity_timeline(events, P); r = []
    for k, q in rows:
        a = (q["w"] + P["W0"]) / (P["F0"] * caps[k][0])
        for side, G, E0 in (("left", P["Gl"], P["El"]), ("right", P["Gr"], P["Er"])):
            r.append(np.log(q[f"con_uV_{side}"]) - np.log(E0 + G * min(a, 1.5) ** P["b"]))
    for k, kind in fails:
        q = rope[k]; a0 = (q["w"] + P["W0"]) / (P["F0"] * caps[k][0]); a1 = (q["w"] + P["W0"]) / (P["F0"] * caps[k][1])
        if kind == "last": r.append(wf * max(0, a0 - 1.0))
        if kind == "fail": r.append(wf * max(0, 0.97 - a0))
        if kind == "atmax": r.append(wf * (a1 - 1.0))
    return np.array(r)

X0 = np.array([np.log(400), np.log(220), 1.2, np.log(60), np.log(40), np.log(70), np.log(0.02), np.log(0.03), np.log(0.002), np.log(0.001)])
LB = [np.log(100), np.log(50), 0.5, np.log(1), np.log(1), np.log(25), np.log(1e-4), np.log(0.005), np.log(1e-6), np.log(1/600)]
UB = [np.log(5000), np.log(5000), 4.0, np.log(400), np.log(400), np.log(250), np.log(0.5), np.log(0.2), np.log(0.05), np.log(0.01)]

def fit(exclude=(), rows=None, fails=None, starts=None):
    rows = F.obs_rows(exclude) if rows is None else rows
    fails = F.failures(exclude) if fails is None else fails
    best = None
    for kf1 in (0.004, 0.015, 0.04):
        for kr1 in (0.01, 0.03, 0.08):
            for F0 in (55, 75):
                x = X0.copy(); x[6] = np.log(kf1); x[7] = np.log(kr1); x[5] = np.log(F0); x[9] = np.log(0.002)
                s = least_squares(resid, x, bounds=(LB, UB), args=(rows, fails), loss="soft_l1", f_scale=0.3, max_nfev=400)
                if best is None or s.cost < best.cost: best = s
    return best, rows, fails

def work(P, W, dur, Df, Ds):
    u = (W + P["W0"]) / P["F0"]; n = max(1, int(dur / 0.5)); dt = dur / n
    for _ in range(n):
        a = min(1.0, u / max(0.05, 1 - Df - Ds)); Df += P["kf1"] * a * dt; Ds += P["kf2"] * a * dt
    return Df, Ds

def predict_reps(P, group_q, group_w=None):
    """Replay the session; inside the chosen group(s) keep repeating reps (observed mean span) until a > 1."""
    out = {}
    Df = Ds = 0.0; t = 0.0
    groups = collections.OrderedDict()
    for k, q in enumerate(rope):
        groups.setdefault((q["exp"], q["q"], q["w"]), []).append(k)
    for g, ks in groups.items():
        target = g[1] == group_q and (group_w is None or g[2] == group_w)
        if not target:
            for k in ks:
                s, e, W = events[k]
                Df *= np.exp(-P["kr1"] * max(0, s - t)); Ds *= np.exp(-P["kr2"] * max(0, s - t))
                Df, Ds = work(P, W, e - s, Df, Ds); t = e
            continue
        s0 = events[ks[0]][0]; span = float(np.median([events[k][1] - events[k][0] for k in ks]))
        Df *= np.exp(-P["kr1"] * max(0, s0 - t)); Ds *= np.exp(-P["kr2"] * max(0, s0 - t)); t = s0
        W = g[2]; u = (W + P["W0"]) / P["F0"]; n = 0
        while n < 60:
            C = 1 - Df - Ds
            if (W + P["W0"]) / (P["F0"] * C) > 1: break
            n += 1; Df, Ds = work(P, W, span, Df, Ds); t += span
        out[g] = n
        # continue with the real timeline afterwards
        t = events[ks[-1]][1]
    return out

def observed_full(group_q):
    c = collections.OrderedDict()
    for q in rope:
        if q["q"] == group_q:
            c.setdefault((q["exp"], q["q"], q["w"]), 0); c[(q["exp"], q["q"], q["w"])] += int(q["full"])
    return c

if __name__ == "__main__":
    s, rows, fails = fit(); P = unpack(s.x)
    r = resid(s.x, rows, []); print("ALL", {k: round(float(v), 4) for k, v in P.items()}, "rms", round(float(np.sqrt(np.mean(r**2))), 3))
    caps = capacity_timeline(events, P)
    for k, kind in fails:
        q = rope[k]; print("  ", kind, q["w"], "a0", round((q["w"] + 3) / (P["F0"] * caps[k][0]), 2))
    res = {"all": {"P": {k: float(v) for k, v in P.items()}, "rms_log": float(np.sqrt(np.mean(r**2)))}}
    # LOO 1: without the drop set -> predict its per-segment reps
    s1, _, _ = fit(exclude=("dropset",)); P1 = unpack(s1.x)
    pred = {g[2]: n for g, n in predict_reps(P1, "dropset").items()}; obs = {g[2]: n for g, n in observed_full("dropset").items()}
    print("LOO dropset", {k: round(float(v), 4) for k, v in P1.items()}); print("   pred", pred, "obs", obs)
    # LOO 2: without the 45 kg set -> predict its reps
    s2, _, _ = fit(exclude=("heavy_normal",)); P2 = unpack(s2.x)
    pred2 = predict_reps(P2, "heavy_normal"); print("LOO 45kg pred", list(pred2.values()), "obs", list(observed_full("heavy_normal").values()))
    res["loo_dropset"] = {"P": {k: float(v) for k, v in P1.items()}, "pred": pred, "obs": obs}
    res["loo_45"] = {"P": {k: float(v) for k, v in P2.items()}, "pred": list(pred2.values()), "obs": list(observed_full("heavy_normal").values())}
    json.dump(res, open(f"{OUT}/fit2.json", "w"), indent=1)
