import json, sys, numpy as np
from scipy.optimize import least_squares
from reps import load
from model import PN, unpack, capacity_timeline
OUT = "/tmp/claude-1000/-home-mohit/3b339da3-a486-4d8d-8451-d60feabcc24b/scratchpad/analysis26/modelfit"
E, R = load()
rope = [q for q in R if q["ex"] == "rope"]
rope.sort(key=lambda q: q["t"])
# work events: every rope rep (full or partial, incl. holds), duration = its span
events = [(q["t"], q["end"], q["w"]) for q in rope]

def obs_rows(exclude=()):
    rows = []
    for k, q in enumerate(rope):
        if not q["full"] or q["q"] in exclude or q["q"] in ("unilateral_ecc",): continue
        if q["con_uV_left"] and q["con_uV_right"]: rows.append((k, q))
    return rows

def failures(exclude=()):
    """(rep index, kind): 'last' = last full rep before a failure partial (a<=1), 'fail' = the partial (a>1)."""
    out = []
    groups = {}
    for k, q in enumerate(rope):
        if q["q"] in ("dropset", "heavy_normal") and q["q"] not in exclude:
            groups.setdefault((q["exp"], q["w"]), []).append(k)
    for g, ks in groups.items():
        fulls = [k for k in ks if rope[k]["full"]]
        if not fulls: continue
        out.append((fulls[-1], "last"))
        after = [k for k in ks if k > fulls[-1] and not rope[k]["full"]]
        if after: out.append((after[0], "fail"))
        elif rope[ks[0]]["q"] == "heavy_normal": out.append((fulls[-1], "atmax"))  # "max possible reps"
    return out

def resid(p, rows, fails, wf=3.0):
    P = unpack(p); caps = capacity_timeline(events, P)
    r = []
    for k, q in rows:
        a = (q["w"] + P["W0"]) / (P["F0"] * caps[k][0])
        for side, G, E0 in (("left", P["Gl"], P["El"]), ("right", P["Gr"], P["Er"])):
            r.append(np.log(q[f"con_uV_{side}"]) - np.log(E0 + G * min(a, 1.5) ** P["b"]))
    for k, kind in fails:
        q = rope[k]; a_end = (q["w"] + P["W0"]) / (P["F0"] * caps[k][1]); a0 = (q["w"] + P["W0"]) / (P["F0"] * caps[k][0])
        if kind == "last": r.append(wf * max(0, a0 - 1.0))          # the last full rep was still possible
        if kind == "fail": r.append(wf * max(0, 0.95 - a0))         # the failed rep needed ~all capacity
        if kind == "atmax": r.append(wf * (a_end - 1.0))            # max-reps set ends at capacity
    return np.array(r)

X0 = np.array([np.log(700), np.log(400), 1.5, np.log(80), np.log(50), np.log(60), np.log(0.004), np.log(0.01)])
LB = [np.log(100), np.log(50), 0.5, np.log(1), np.log(1), np.log(25), np.log(1e-6), np.log(1e-4)]
UB = [np.log(5000), np.log(5000), 4.0, np.log(400), np.log(400), np.log(250), np.log(0.2), np.log(1.0)]

def fit(exclude=(), x0=X0, rows=None, fails=None):
    rows = obs_rows(exclude) if rows is None else rows
    fails = failures(exclude) if fails is None else fails
    best = None
    for kfs in (0.001, 0.004, 0.015):
        for F0 in (50, 70, 100):
            x = x0.copy(); x[6] = np.log(kfs); x[5] = np.log(F0)
            s = least_squares(resid, x, bounds=(LB, UB), args=(rows, fails), loss="soft_l1", f_scale=0.3)
            if best is None or s.cost < best.cost: best = s
    return best, rows, fails

if __name__ == "__main__":
    s, rows, fails = fit()
    P = unpack(s.x)
    res = resid(s.x, rows, [])
    print({k: round(float(v), 4) for k, v in P.items()}, "n", len(rows), "rms log", round(float(np.sqrt(np.mean(res**2))), 3))
    json.dump({"x": s.x.tolist(), "P": {k: float(v) for k, v in P.items()}}, open(f"{OUT}/fit_all.json", "w"))
