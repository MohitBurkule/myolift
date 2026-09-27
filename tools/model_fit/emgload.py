"""EMG vs load from fresh concentric reps (before 17:32, rope, full). EMG = E + k * (W + W0)^b per side."""
import json, numpy as np
from scipy.optimize import curve_fit
from reps import load
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
OUT = "/tmp/claude-1000/-home-mohit/3b339da3-a486-4d8d-8451-d60feabcc24b/scratchpad/analysis26/modelfit"
E, R = load()
fresh = [q for q in R if q["ex"] == "rope" and q["full"] and q["t"] < 1100 and q["con_uV_left"]]
W0 = 3.0
f = lambda W, E0, k, b: E0 + k * (W + W0) ** b
res = {}
fig, ax = plt.subplots(1, 2, figsize=(10, 4))
for j, side in enumerate(("left", "right")):
    W = np.array([q["w"] for q in fresh], float); y = np.array([q[f"con_uV_{side}"] for q in fresh])
    p, cov = curve_fit(f, W, y, p0=[80, 2, 1.2], bounds=([0, 1e-3, 0.3], [400, 500, 4]), maxfev=20000)
    # leave-one-load-out
    loo = []
    for w in sorted(set(W)):
        m = W != w
        try:
            pp, _ = curve_fit(f, W[m], y[m], p0=p, bounds=([0, 1e-3, 0.3], [400, 500, 4]), maxfev=20000)
            loo.append((float(w), float(np.mean(y[~m])), float(f(w, *pp))))
        except Exception as e: loo.append((float(w), float(np.mean(y[~m])), None))
    # bootstrap
    rng = np.random.default_rng(0); bs = []
    for _ in range(300):
        i = rng.integers(0, len(W), len(W))
        try: bs.append(curve_fit(f, W[i], y[i], p0=p, bounds=([0, 1e-3, 0.3], [400, 500, 4]), maxfev=5000)[0])
        except Exception: pass
    bs = np.array(bs); ci = np.percentile(bs, [5, 95], axis=0)
    # equivalent load of the calibration squeeze
    mvc = fresh[0]["con_uV_left"] if False else None
    res[side] = {"E0": p[0], "k": p[1], "b": p[2], "ci90": {"E0": ci[:, 0].tolist(), "k": ci[:, 1].tolist(), "b": ci[:, 2].tolist()},
                 "loo": loo, "r2": float(1 - np.sum((y - f(W, *p)) ** 2) / np.sum((y - y.mean()) ** 2)), "n": int(len(y))}
    ax[j].scatter(W, y, s=18, label="fresh reps"); ww = np.linspace(0, 50, 100); ax[j].plot(ww, f(ww, *p), label=f"E0+k(W+3)^b, b={p[2]:.2f}")
    for w, o, pr in loo:
        if pr: ax[j].plot([w, w], [o, pr], "r-", lw=1)
    ax[j].set_title(f"{side} triceps: concentric EMG vs load"); ax[j].set_xlabel("stack kg"); ax[j].set_ylabel("µV"); ax[j].legend(fontsize=8)
plt.tight_layout(); plt.savefig(f"{OUT}/emg_vs_load.png", dpi=110)
json.dump(res, open(f"{OUT}/emg_vs_load.json", "w"), indent=1)
for s, v in res.items():
    print(s, "E0 %.0f k %.2f b %.2f  r2 %.2f  n %d" % (v["E0"], v["k"], v["b"], v["r2"], v["n"]), "ci b", [round(x, 2) for x in v["ci90"]["b"]])
    print("   LOO load: obs vs pred", [(w, round(o), round(p) if p else None) for w, o, p in v["loo"]])
