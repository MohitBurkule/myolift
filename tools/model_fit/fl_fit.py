"""
Force–length and force–velocity of the triceps from SAM 3D Body elbow angles + EMG (26 Sep rope sets).

Quasi-static per-frame model (fresh sets only, before the fatiguing blocks):
    EMG(t) = E0 + k * [ tau_load / (f_L(theta) * f_V(omega)) ]^b
    tau_load = W g L sin(theta + phi) - m_fa g c sin(theta)        (N·m, cable ~vertical, upper arm ~vertical)
    f_L = exp(-((theta - theta_opt) / width)^2)                    (normalised, 1 at the optimum)
    f_V: concentric (extension, omega < 0 in flexion units) = (1 - v/vmax) / (1 + v/(a vmax)),
         eccentric = 1 + (ecc_max - 1) * (1 - exp(-v / v_e))       (Hill + plateau)
theta = elbow flexion (0 = straight), omega = d theta / dt (deg/s); EMG = envelope µV (series 10 Hz),
aligned with the per-recording video offset and an electromechanical delay fitted as one parameter.
Leave-one-recording-out validation. Writes modelfit/fl_fit.json + fl_fit.png.
"""
import csv, json, os, sys

import numpy as np
from scipy.optimize import least_squares
from scipy.signal import savgol_filter

A = "/tmp/claude-1000/-home-mohit/3b339da3-a486-4d8d-8451-d60feabcc24b/scratchpad/analysis26"
OUT = f"{A}/modelfit"
G, L, M_FA, C_FA = 9.81, 0.30, 1.6, 0.16

# fresh rope recordings with a single weight (drop set / one-arm / heavy fatiguing blocks excluded from the fit)
FIT = {"17-15-06": 36, "17-17-01": 18, "17-19-23": 18, "17-21-13": 18, "17-23-45": 4.5, "17-25-47": 18, "17-27-10": 18, "17-28-39": 18, "17-30-41": 45, "17-32-55": 23}


def load_rec(k, w):
    ap = f"{A}/sam3d/{k}_angles.csv"
    if not os.path.exists(ap):
        return None
    rows = list(csv.DictReader(open(ap)))
    tv = np.array([float(r["t_video_s"]) for r in rows]); th = np.array([float(r["right"]) if r.get("right") else np.nan for r in rows])
    ok = ~np.isnan(th)
    tv, th = tv[ok], th[ok]
    th = savgol_filter(th, 7, 2)
    om = np.gradient(th, tv)
    R = json.load(open(f"{A}/results.json"))
    x = next(e for e in R["experiments"] if e["time"].replace(":", "-") == k)
    off = x["sync"]["usedOffsetS"]
    s = json.load(open(f"{A}/series_{k}.json"))
    te = np.array(s["t"])
    emg = {sd: np.array([v if v is not None else np.nan for v in s[f"pct_{sd}"]]) * x["mvc"][sd] / 100 for sd in ("left", "right")}
    rec = {"k": k, "w": w, "t": tv + off, "th": th, "om": om, "te": te, "emg": emg, "mask": {}}
    for sd in ("left", "right"):
        # frames used: working the rope (EMG well above rest) and away from lockout (the joint stop can
        # carry the load there and the EMG is a voluntary squeeze); fixed so the residual count is constant
        e = np.interp(rec["t"] + 0.1, te, emg[sd]); rest = np.nanpercentile(emg[sd], 5)
        rec["mask"][sd] = ~np.isnan(e) & (e > max(4 * rest, 15)) & (th > 15)
    return rec


def unpack(p):
    return dict(zip(["logE0", "logk", "b", "phi", "th_opt", "width", "a", "vmax", "ecc", "ve", "delay"], p))


def predict(P, rec, side_scale):
    q = unpack(P)
    th, om, w = rec["th"], rec["om"], rec["w"]
    tau = w * G * L * np.sin(np.radians(th + q["phi"])) - M_FA * G * C_FA * np.sin(np.radians(th))
    tau = np.maximum(tau, 0.5)
    fl = np.exp(-((th - q["th_opt"]) / q["width"]) ** 2)
    v = -om  # extension speed (deg/s), >0 concentric
    fv = np.where(v >= 0, (1 - v / q["vmax"]) / (1 + v / (q["a"] * q["vmax"])),
                  1 + (q["ecc"] - 1) * (1 - np.exp(v / q["ve"])))
    fv = np.clip(fv, 0.05, None)
    drive = tau / (fl * fv)
    return np.exp(q["logE0"]) * side_scale[0] + np.exp(q["logk"]) * side_scale[1] * drive ** q["b"]


def residuals(P, recs, side):
    out = []
    q = unpack(P)
    for r in recs:
        e = np.interp(r["t"] + q["delay"], r["te"], r["emg"][side])
        pred = predict(P, r, (1, 1))
        # only while working the rope (EMG well above rest) and away from lockout, where the joint
        # stop can carry the load and the EMG is a voluntary squeeze
        m = r["mask"][side] & ~np.isnan(e) & (e > 0)
        e = np.where(m, e, 1.0)
        m = r["mask"][side]
        out.append(np.log(pred[m]) - np.log(e[m]))
    return np.concatenate(out)


P0 = [np.log(60), np.log(8), 1.2, 15, 70, 60, 0.3, 600, 1.4, 60, 0.1]
LB = [np.log(1), np.log(0.01), 0.3, -30, 0, 20, 0.05, 150, 1.0, 5, -0.3]
UB = [np.log(400), np.log(500), 3, 60, 140, 300, 2, 3000, 2.2, 400, 0.4]
NAMES = list(unpack(P0).keys())


def fit(recs, side, x0=P0):
    return least_squares(residuals, x0, bounds=(LB, UB), args=(recs, side), loss="soft_l1", f_scale=0.3, max_nfev=4000)


def main():
    recs = [r for r in (load_rec(k, w) for k, w in FIT.items()) if r]
    print("recordings with angles:", [r["k"] for r in recs])
    res = {}
    for side in ("right", "left"):
        f = fit(recs, side)
        P = f.x
        rms = float(np.sqrt(np.mean(residuals(P, recs, side) ** 2)))
        # null: EMG depends on load only (no angle / velocity terms): fix width huge, ecc=1, vmax huge
        def res_null(p):
            full = np.array(P, float); full[[0, 1, 2, 3, 11 - 11]] = full[[0, 1, 2, 3, 0]]
            q = np.array(P, float); q[0], q[1], q[2] = p; q[5] = 300; q[8] = 1.0; q[7] = 3000; q[3] = 0
            return residuals(q, recs, side)
        fn = least_squares(res_null, P[:3], bounds=(LB[:3], UB[:3]), loss="soft_l1", f_scale=0.3)
        rms_null = float(np.sqrt(np.mean(fn.fun ** 2)))
        # leave-one-recording-out
        loo = {}
        for i, r in enumerate(recs):
            tr = recs[:i] + recs[i + 1:]
            fi = fit(tr, side, P)
            e_full = float(np.sqrt(np.mean(residuals(fi.x, [r], side) ** 2)))
            qn = np.array(fi.x, float)
            loo[r["k"]] = {"rms_log": round(e_full, 3), "w": r["w"]}
        # crude uncertainty from the Jacobian
        try:
            J = f.jac; cov = np.linalg.pinv(J.T @ J) * np.mean(f.fun ** 2)
            sd = np.sqrt(np.clip(np.diag(cov), 0, None))
        except Exception:
            sd = np.full(len(P), np.nan)
        res[side] = {"params": {n: [round(float(v), 3), round(float(s), 3)] for n, v, s in zip(NAMES, P, sd)},
                     "rms_log": round(rms, 3), "rms_log_load_only": round(rms_null, 3), "loo": loo,
                     "n": int(sum(len(r["t"]) for r in recs))}
        print(side, json.dumps({k: v for k, v in res[side].items() if k != "loo"}))
        print("  LOO rms(log):", {k: v["rms_log"] for k, v in loo.items()})
    os.makedirs(OUT, exist_ok=True)
    json.dump(res, open(f"{OUT}/fl_fit.json", "w"), indent=1)
    try:
        import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
        fig, ax = plt.subplots(1, 3, figsize=(14, 4))
        for side, c in (("right", "tab:orange"), ("left", "tab:blue")):
            q = {k: v[0] for k, v in res[side]["params"].items()}
            th = np.linspace(0, 130, 200)
            ax[0].plot(th, np.exp(-((th - q["th_opt"]) / q["width"]) ** 2), c=c, label=side)
            v = np.linspace(-300, 400, 300)
            fv = np.where(v >= 0, (1 - v / q["vmax"]) / (1 + v / (q["a"] * q["vmax"])), 1 + (q["ecc"] - 1) * (1 - np.exp(v / q["ve"])))
            ax[1].plot(v, fv, c=c, label=side)
        ax[0].set(title="force–length (fitted)", xlabel="elbow flexion °", ylabel="relative force"); ax[0].legend()
        ax[1].set(title="force–velocity (fitted)", xlabel="extension speed °/s (<0 eccentric)", ylabel="relative force"); ax[1].axvline(0, c="k", lw=.5)
        r = next(r for r in recs if r["k"] == "17-32-55") if any(r["k"] == "17-32-55" for r in recs) else recs[0]
        P = [res["right"]["params"][n][0] for n in NAMES]
        e = np.interp(r["t"] + P[-1], r["te"], r["emg"]["right"])
        ax[2].plot(r["t"], e, lw=.8, label="EMG right (µV)"); ax[2].plot(r["t"], predict(P, r, (1, 1)), lw=.8, label="model")
        ax[2].set(title=f"{r['k']} ({r['w']} kg)", xlabel="s"); ax[2].legend()
        plt.tight_layout(); plt.savefig(f"{OUT}/fl_fit.png", dpi=110)
    except Exception as ex:
        print("plot failed", ex)


if __name__ == "__main__":
    main()
