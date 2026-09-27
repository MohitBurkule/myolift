#!/usr/bin/env python3
"""
Video <-> EMG sync from the reps themselves (no sync flex needed).

  python tools/sync_reps.py <experiments dir> <out.json> [--fps 30]

For rope pushdown recordings without long holds: every rep's lockout (the bottom of the hand
path, from dense optical flow at 30 fps) is matched to the EMG peak of that rep (per side), and
the lag  = t_emg_peak - t_lockout  (lockout put on the EMG clock with the recorded video offset)
is collected. The EMG peak is expected to lead lockout slightly (electromechanical delay), so the
absolute lag is not zero; what matters is that it is the same everywhere. Convention: the
session-wide median lag M is taken as "true", and each recording's corrected offset is
  offset_corrected = offset_recorded + (median_lag_recording - M)
A linear fit of lag vs. time inside each recording checks for clock drift.
"""
import json, os, sys

import numpy as np
from scipy.signal import find_peaks, savgol_filter

sys.path.insert(0, os.path.dirname(__file__))
import experiment_analyse as ea  # noqa: E402
from video_motion import rope_mode  # noqa: E402

ROPE_NO_HOLD = ("partial_bottom_half", "partial_top_half", "min_load_controlled", "slow_full", "heavy_normal",
                "usual_mix", "unilateral_ecc", "dropset")


def lockouts(rows):
    t = np.array([r[0] for r in rows]); raw = np.array([r[4] for r in rows])
    fps = 1 / np.median(np.diff(t))
    d = raw - savgol_filter(raw, int(8 * fps) | 1, 1)  # remove slow drift, keep reps
    ds = savgol_filter(d, int(0.3 * fps) | 1, 2)
    rng = np.percentile(ds, 95) - np.percentile(ds, 5)
    pk, pr = find_peaks(ds, prominence=0.25 * rng, distance=int(1.2 * fps))  # down = positive -> lockout = maximum
    # refine to sub-frame with a parabola
    out = []
    for p in pk:
        if 0 < p < len(ds) - 1:
            a, b, c = ds[p - 1], ds[p], ds[p + 1]
            den = a - 2 * b + c
            out.append(t[p] + (0.5 * (a - c) / den if den else 0) / fps)
    return np.array(out), t, ds


def emg_peaks(grid, env):
    e = savgol_filter(env, 11, 2)
    rng = np.percentile(e, 95) - np.percentile(e, 5)
    pk, _ = find_peaks(e, prominence=0.2 * rng, distance=int(1.0 * ea.FS_ENV))
    return grid[pk]


def main():
    root, out_path = sys.argv[1], sys.argv[2]
    fps = float(sys.argv[sys.argv.index("--fps") + 1]) if "--fps" in sys.argv else 30.0
    labels = json.load(open(os.path.join(os.path.dirname(out_path), "labels.json")))
    res = {"convention": "lag = t_emg_peak - t_lockout (EMG clock); corrected offset makes each recording's median lag equal the session median", "recordings": {}}
    all_lags = []
    for d in sorted(os.listdir(root)):
        key = d[11:19]
        lab = labels.get(d) or labels.get(key) or {}
        if lab.get("ex") != "rope" or lab.get("q") not in ROPE_NO_HOLD:
            continue
        p = os.path.join(root, d)
        meta = json.load(open(os.path.join(p, "experiment.json")))
        off = (meta.get("video") or {}).get("offsetS", 0.0)
        cache = os.path.join(os.path.dirname(out_path), "flowcache", f"{d}_{int(fps)}.npy")
        if os.path.exists(cache):
            rows = [tuple(r) for r in np.load(cache)]
        else:
            rows = rope_mode(os.path.join(p, "video.mp4"), fps)
            os.makedirs(os.path.dirname(cache), exist_ok=True)
            np.save(cache, np.array(rows, dtype=float))
        lo, _, _ = lockouts(rows)
        lo_emg = lo + off
        sides = {}
        pl = {x["sensorId"].replace(":", ""): x["side"] for x in meta.get("placements") or []}
        for f in sorted(os.listdir(p)):
            if f.endswith(".bin"):
                g, e = ea.envelope(*ea.decode_bin(os.path.join(p, f)))
                sides[pl.get(f[:-4], f[:-4])] = emg_peaks(g, e)
        lags, times = [], []
        for side, pk in sides.items():
            for tl in lo_emg:
                if not len(pk):
                    continue
                j = int(np.argmin(np.abs(pk - tl)))
                if abs(pk[j] - tl) <= 1.0:
                    lags.append(pk[j] - tl); times.append(tl)
        lags, times = np.array(lags), np.array(times)
        r = {"lockouts": int(len(lo)), "matched": int(len(lags)), "offsetRecorded": off}
        if len(lags) >= 4:
            q1, med, q3 = np.percentile(lags, [25, 50, 75])
            slope = float(np.polyfit(times, lags, 1)[0]) if np.ptp(times) > 10 else None
            r.update({"lagMedian": round(float(med), 3), "lagIQR": [round(float(q1), 3), round(float(q3), 3)],
                      "driftSPerMin": None if slope is None else round(slope * 60, 4), "lags": [round(float(x), 3) for x in lags]})
            all_lags += list(lags)
        res["recordings"][key] = r
        print(key, lab.get("q"), {k: v for k, v in r.items() if k != "lags"})
    M = float(np.median(all_lags))
    q1, q3 = np.percentile(all_lags, [25, 75])
    res["session"] = {"lagMedian": round(M, 3), "lagIQR": [round(float(q1), 3), round(float(q3), 3)], "n": len(all_lags)}
    for k, r in res["recordings"].items():
        if "lagMedian" in r:
            dev = r["lagMedian"] - M
            r["deviation"] = round(dev, 3)
            r["offsetCorrected"] = round(r["offsetRecorded"] + dev, 3)
            r["outlier"] = bool(abs(dev) > max(0.1, 1.5 * (q3 - q1)))
    json.dump(res, open(out_path, "w"), indent=1)
    print("session", res["session"])


if __name__ == "__main__":
    main()
