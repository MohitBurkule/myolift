import numpy as np, collections
from fit import fit, resid, rope, events, obs_rows, failures, LB, UB, X0
from model import unpack, capacity_timeline
s, rows, fails = fit()
P = unpack(s.x); caps = capacity_timeline(events, P)
print({k: round(float(v), 4) for k, v in P.items()})
r = resid(s.x, rows, [])
print("rms log", round(float(np.sqrt(np.mean(r**2))), 3), "n", len(r))
by = collections.defaultdict(list)
for (k, q), a, b in zip(rows, r[0::2], r[1::2]): by[(q["exp"], q["q"], q["w"])].append((a + b) / 2)
for k, v in sorted(by.items()): print(k, "n", len(v), "mean log resid", round(float(np.mean(v)), 2))
# no-fatigue comparison: kf at lower bound, fixed
lb = list(LB); ub = list(UB); lb[6] = np.log(1e-6); ub[6] = np.log(1.1e-6)
from scipy.optimize import least_squares
x = s.x.copy(); x[6] = np.log(1.05e-6)
s2 = least_squares(resid, x, bounds=(lb, ub), args=(rows, fails), loss="soft_l1", f_scale=0.3)
r2 = resid(s2.x, rows, [])
print("no fatigue: rms log", round(float(np.sqrt(np.mean(r2**2))), 3), {k: round(float(v), 3) for k, v in unpack(s2.x).items()})
print("capacity at key times:", [(rope[k]["exp"], rope[k]["w"], round(caps[k][0], 3)) for k in range(0, len(rope), 12)])
for k, kind in fails:
    q = rope[k]; print("fail", kind, q["exp"], q["w"], "a0", round((q["w"] + P["W0"]) / (P["F0"] * caps[k][0]), 2))
