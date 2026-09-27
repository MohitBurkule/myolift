#!/usr/bin/env python3
"""
Evaluate SAM 3D Body elbow angles: smoothing, rep segmentation by angle, full/partial labels,
bone-length stability, and agreement with the rope optical-flow trace.

  python tools/sam3d_eval.py <angles.csv> [--dir <experiment dir>] [--side right]

Rep = lockout (angle minimum) to lockout. Range classes from the rep's top (max flexion) and
bottom (min flexion): full = reaches both ends of this recording's range, bottom-half = never
reaches the top, top-half = never reaches lockout.
"""
import argparse, csv, json, os

import numpy as np
from scipy.signal import find_peaks, savgol_filter


def load(p):
    rows = list(csv.DictReader(open(p)))
    f = lambda k: np.array([float(r[k]) if r.get(k) not in (None, "") else np.nan for r in rows])
    return rows, f


def bone_cv(f, side):
    P = {j: np.stack([f(f"{side}_{j}_{c}") for c in "XYZ"], 1) for j in ("sh", "el", "wr")}
    up = np.linalg.norm(P["sh"] - P["el"], axis=1); fo = np.linalg.norm(P["el"] - P["wr"], axis=1)
    return float(np.nanstd(up) / np.nanmean(up)), float(np.nanstd(fo) / np.nanmean(fo))


def reps(t, a, fps):
    ok = ~np.isnan(a)
    a = np.interp(t, t[ok], a[ok])
    w = max(5, int(round(fps * 0.8)) | 1)
    s = savgol_filter(a, w, 2) if len(a) > w else a
    lo, hi = np.nanpercentile(s, 5), np.nanpercentile(s, 95)
    rng = max(hi - lo, 1e-6)
    # lockouts = minima; tops = maxima; prominence relative to the recording's range
    mins, _ = find_peaks(-s, prominence=max(0.12 * rng, 8), distance=max(1, int(fps * 0.8)))
    # one rep per lockout (angle minimum); its top = the highest angle since the previous lockout
    out, prev = [], 0
    for i in mins:
        top = float(np.max(s[prev:i + 1])) if i > prev else float(s[i])
        out.append({"t": float(t[i]), "top": top, "bottom": float(s[i])})
        prev = i
    full_top = lo + 0.8 * rng; full_bot = lo + 0.25 * rng
    for r in out:
        reach_top, reach_bot = r["top"] >= full_top, r["bottom"] <= full_bot
        r["range"] = "full" if reach_top and reach_bot else ("bottom_half" if reach_bot else ("top_half" if reach_top else "mid"))
        r["rom"] = r["top"] - r["bottom"]
    return s, out, lo, hi


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--dir")
    ap.add_argument("--side", default="right")
    ap.add_argument("--json")
    a = ap.parse_args()
    rows, f = load(a.csv)
    t = f("t_video_s"); ang = f(a.side); conf = f(f"{a.side}_conf")
    fps = 1.0 / np.median(np.diff(t))
    s, rr, lo, hi = reps(t, ang, fps)
    # keep only lockouts where the muscle is actually working (drops setup / walk-away movements)
    k = os.path.basename(a.csv)[:8]
    A = os.path.dirname(os.path.dirname(os.path.abspath(a.csv)))
    sp = os.path.join(A, f"series_{k}.json")
    if os.path.exists(sp):
        S = json.load(open(sp)); te = np.array(S["t"])
        R = json.load(open(os.path.join(A, "results.json")))
        off = next(e for e in R["experiments"] if e["time"].replace(":", "-") == k)["sync"]["usedOffsetS"]
        emg = np.nan_to_num(np.array([v if v is not None else np.nan for v in S[f"pct_{a.side}"]]))
        rest = np.percentile(emg, 5)
        active = lambda tt: np.max(emg[(te > tt + off - 1.5) & (te < tt + off + 1.5)], initial=0) > max(4 * rest, 10)
        dropped = [r for r in rr if not active(r["t"])]
        rr = [r for r in rr if active(r["t"])]
    else:
        dropped = []
    cvu, cvf = bone_cv(f, a.side)
    res = {"frames": len(t), "fps": round(fps, 2), "range_deg": [round(lo, 1), round(hi, 1)], "bone_cv": [round(cvu, 3), round(cvf, 3)],
           "conf_mean": round(float(np.nanmean(conf)), 2), "reps": len(rr), "dropped_inactive": len(dropped),
           "counts": {k: sum(r["range"] == k for r in rr) for k in ("full", "bottom_half", "top_half", "mid")},
           "rep_list": [{k: round(v, 2) if isinstance(v, float) else v for k, v in r.items()} for r in rr]}
    other = "left" if a.side == "right" else "right"
    res["lr_corr"] = round(float(np.corrcoef(np.nan_to_num(ang), np.nan_to_num(f(other)))[0, 1]), 2)
    if a.dir and os.path.exists(os.path.join(a.dir, "motion.csv")):
        m = list(csv.DictReader(open(os.path.join(a.dir, "motion.csv"))))
        tm = np.array([float(x["t_video_s"]) for x in m]); vm = np.array([float(x["value"]) if x["value"] else np.nan for x in m])
        ok = ~np.isnan(vm)
        mv = np.interp(t, tm[ok], vm[ok])
        res["flow_corr"] = round(float(np.corrcoef(s, mv)[0, 1]), 2)  # sign: flow down = +, angle down at lockout
    print(json.dumps({k: v for k, v in res.items() if k != "rep_list"}))
    if a.json:
        json.dump(res, open(a.json, "w"), indent=1)


if __name__ == "__main__":
    main()
