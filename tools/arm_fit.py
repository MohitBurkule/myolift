#!/usr/bin/env python3
"""
Constrained 2D arm fit for rope pushdown videos, where MediaPipe often loses the elbow.

  python tools/arm_fit.py <experiment dir> [--side left|right|both]

Model per frame t (image coords, y down): shoulder S (fixed for the video), upper arm of fixed
length L1 at angle a_t (kept near its mean: the elbow stays by the torso), forearm of fixed
length L2 at elbow flexion f_t (0 = straight, bounded 0–150°).
Fitted to: MediaPipe shoulder/elbow/wrist weighted by visibility; the hand's vertical position
tied to the optical-flow hand displacement from tools/video_motion.py (motion.csv 'raw'),
hand_y = b + c * raw (fitted where the wrist is well seen); and smoothness of a_t, f_t.
Globals are estimated first, then each frame is a 2-parameter solve started from the raw
MediaPipe angle when the arm is visible, then a 5-frame median filter.
Writes <dir>/armfit.csv: t_video_s, <side>_angle, <side>_resid, <side>_ok
"""
import argparse, csv, os

import numpy as np
from scipy.optimize import least_squares

SIG_LM, SIG_HAND = 15.0, 80.0


def load(d, side):
    r = list(csv.DictReader(open(os.path.join(d, "angle.csv"))))
    f = lambda k: np.array([float(x[k]) if x.get(k) not in ("", None) else np.nan for x in r])
    t = f("t_video_s")
    obs = {nm: (f(f"{side}_{nm}_x"), f(f"{side}_{nm}_y"), np.nan_to_num(f(f"{side}_{nm}_v"))) for nm in ("sh", "el", "wr")}
    obs["raw_angle"] = f(f"{side}_2d")
    m = list(csv.DictReader(open(os.path.join(d, "motion.csv"))))
    mt = np.array([float(x["t_video_s"]) for x in m]); raw = np.array([float(x["raw"]) if x["raw"] else np.nan for x in m])
    ok = ~np.isnan(raw)
    hand = np.interp(t, mt[ok], raw[ok]) * 4.0  # motion was computed at 180 px wide, landmarks at 720
    return t, obs, hand


def fit(t, obs, hand, sign):
    """Globals first (shoulder, segment lengths, hand-tie line from frames where the wrist is well
    seen), then a 2-parameter solve per frame, then temporal smoothing with joint limits."""
    n = len(t)
    good = lambda nm: np.isfinite(obs[nm][0]) & (obs[nm][2] > 0.6)
    gs, ge, gw = good("sh"), good("el"), good("wr")
    sx, sy = np.nanmedian(obs["sh"][0][gs]) if gs.any() else np.nanmedian(obs["sh"][0]), np.nanmedian(obs["sh"][1][gs]) if gs.any() else np.nanmedian(obs["sh"][1])
    both1 = gs & ge; both2 = ge & gw
    L1 = np.nanmedian(np.hypot(obs["el"][0] - obs["sh"][0], obs["el"][1] - obs["sh"][1])[both1]) if both1.sum() > 5 else 250.0
    L2 = np.nanmedian(np.hypot(obs["wr"][0] - obs["el"][0], obs["wr"][1] - obs["el"][1])[both2]) if both2.sum() > 5 else 250.0
    if gw.sum() > 10:
        c, b = np.polyfit(hand[gw], obs["wr"][1][gw], 1)
    else:
        c, b = 1.0, sy + L1 + 0.5 * L2
    abar = np.nanmedian(np.arctan2(obs["el"][0] - sx, obs["el"][1] - sy)[ge]) if ge.sum() > 5 else 0.0
    A, F, R = np.zeros(n), np.zeros(n), np.full(n, np.nan)
    prev = (abar, 0.8)
    raw_a = obs["raw_angle"]
    for k in range(n):
        if np.isfinite(raw_a[k]) and min(obs["el"][2][k], obs["wr"][2][k]) > 0.5:
            prev = (prev[0], float(np.radians(np.clip(raw_a[k], 0, 149))))
        def res(q):
            a, fl = q
            Ex, Ey = sx + L1 * np.sin(a), sy + L1 * np.cos(a)
            Wx, Wy = Ex + L2 * np.sin(a + sign * fl), Ey + L2 * np.cos(a + sign * fl)
            out = []
            for nm, (X, Y) in (("el", (Ex, Ey)), ("wr", (Wx, Wy))):
                ox, oy, v = obs[nm][0][k], obs[nm][1][k], obs[nm][2][k]
                if np.isfinite(ox):
                    out += [v * (ox - X) / SIG_LM, v * (oy - Y) / SIG_LM]
                else:
                    out += [0.0, 0.0]
            out += [(Wy - (b + c * hand[k])) / SIG_HAND, (a - abar) / 0.35, (a - prev[0]) / 0.3, (fl - prev[1]) / 1.0]
            return np.array(out)
        r = least_squares(res, prev, bounds=([abar - 1.2, 0.0], [abar + 1.2, np.radians(150)]))
        A[k], F[k] = r.x
        prev = (A[k], F[k])
        e = res(r.x)[:4]
        w = sum(obs[nm][2][k] for nm in ("el", "wr") if np.isfinite(obs[nm][0][k]))
        R[k] = np.sqrt(np.mean((e * SIG_LM) ** 2)) if w > 0.3 else np.nan
    from scipy.signal import medfilt
    F = medfilt(F, 5)
    Ex, Ey = sx + L1 * np.sin(A), sy + L1 * np.cos(A)
    Wy = Ey + L2 * np.cos(A + sign * F)
    hand_res = np.abs(Wy - (b + c * hand))
    wsum = sum(np.where(np.isfinite(obs[nm][0]), obs[nm][2], 0) for nm in ("el", "wr"))
    cost = np.nansum(R ** 2) + np.sum((hand_res / SIG_HAND) ** 2)
    return cost, np.degrees(F), R, hand_res, wsum


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("dir"); ap.add_argument("--side", default="both")
    a = ap.parse_args()
    sides = ["left", "right"] if a.side == "both" else [a.side]
    cols, t0 = {}, None
    for side in sides:
        t, obs, hand = load(a.dir, side)
        best = min((fit(t, obs, hand, s) for s in (1, -1)), key=lambda x: x[0])
        cost, ang, per, hres, wsum = best
        ok = ((per < 2.5 * SIG_LM) | np.isnan(per)) & (hres < 2.5 * SIG_HAND) & ((wsum > 0.3) | (hres < SIG_HAND))
        cols["t_video_s"] = t
        cols[f"{side}_angle"], cols[f"{side}_resid"], cols[f"{side}_ok"] = ang, per, ok.astype(int)
        print(f"{os.path.basename(a.dir)} {side}: angle {np.nanpercentile(ang, 5):.0f}–{np.nanpercentile(ang, 95):.0f}°, ok {100 * ok.mean():.0f}% of frames, landmarks seen (w>0.3) {100 * (wsum > 0.3).mean():.0f}%")
    with open(os.path.join(a.dir, "armfit.csv"), "w", newline="") as f:
        w = csv.writer(f); w.writerow(cols.keys())
        for i in range(len(cols["t_video_s"])):
            w.writerow([("" if (isinstance(v[i], float) and np.isnan(v[i])) else round(float(v[i]), 2)) for v in cols.values()])
