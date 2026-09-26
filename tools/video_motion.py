#!/usr/bin/env python3
"""
Body motion from an experiment video without detecting the person.

  python tools/video_motion.py <experiment dir> --mode scale|rope [--fps 10]

scale (pull-ups / dips on the assisted machine, phone riding on the knee pad looking up):
  the overhead frame is fixed and the phone moves with the body, so the apparent scale of the
  frame vs. a reference frame (ORB features + RANSAC similarity) ~ 1/distance to the bar.
  value = log(scale): higher = closer to the bar.
rope (pushdowns, front camera near the stack):
  dense optical flow; the fastest-moving pixels are the hands/rope/bead. Their median vertical
  velocity integrated = vertical displacement of the hands (down = positive), drift removed.
  Also writes motion energy (timing only, works even when the rope leaves the frame).
Writes <dir>/motion.csv: t_video_s, value (drift removed), energy, quality, raw (not drift removed)
"""
import argparse, csv, os

import cv2
import numpy as np


def frames(path, fps, width):
    cap = cv2.VideoCapture(path)
    step_ms, next_ms = 1000.0 / fps, 0.0
    while True:
        ok, f = cap.read()
        if not ok:
            break
        t = cap.get(cv2.CAP_PROP_POS_MSEC)
        if t + 1e-6 < next_ms:
            continue
        next_ms = t + step_ms
        h = int(f.shape[0] * width / f.shape[1])
        yield t / 1000.0, cv2.cvtColor(cv2.resize(f, (width, h)), cv2.COLOR_BGR2GRAY)


def scale_mode(path, fps):
    orb = cv2.ORB_create(1500)
    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    ref = None
    out = []
    for t, g in frames(path, fps, 360):
        top = g[: int(g.shape[0] * 0.45)]  # the machine frame is in the top part; body at the bottom
        kp, des = orb.detectAndCompute(top, None)
        if ref is None:
            if des is not None and len(kp) > 200 and t > 1.0:
                ref = (kp, des)
            out.append((t, np.nan, 0.0)); continue
        if des is None or len(kp) < 30:
            out.append((t, np.nan, 0.0)); continue
        m = bf.match(ref[1], des)
        if len(m) < 25:
            out.append((t, np.nan, 0.0)); continue
        src = np.float32([ref[0][x.queryIdx].pt for x in m]); dst = np.float32([kp[x.trainIdx].pt for x in m])
        A, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0)
        if A is None:
            out.append((t, np.nan, 0.0)); continue
        s = float(np.hypot(A[0, 0], A[1, 0]))
        q = float(inl.sum()) / len(m)
        out.append((t, np.log(s), q))
    return [(t, v, np.nan, q, v) for t, v, q in out]


def rope_mode(path, fps):
    prev, out = None, []
    for t, g in frames(path, fps, 180):
        if prev is None:
            prev = g; out.append((t, 0.0, 0.0, 0.0)); continue
        flow = cv2.calcOpticalFlowFarneback(prev, g, None, 0.5, 3, 15, 3, 5, 1.2, 0)
        prev = g
        mag = np.hypot(flow[..., 0], flow[..., 1])
        thr = np.percentile(mag, 95)
        sel = mag >= max(thr, 0.5)
        vy = float(np.median(flow[..., 1][sel])) if sel.sum() > 20 else 0.0
        out.append((t, vy, float(mag.mean()), float(sel.mean())))
    t = np.array([o[0] for o in out]); vy = np.array([o[1] for o in out])
    disp = np.cumsum(vy)
    # remove slow drift (camera wobble): subtract a 6 s running median
    w = max(3, int(6 * fps)) | 1
    pad = np.pad(disp, w // 2, mode="edge")
    base = np.array([np.median(pad[i:i + w]) for i in range(len(disp))])
    raw = disp.copy()
    disp = disp - base
    return [(t[i], disp[i], out[i][2], out[i][3], raw[i]) for i in range(len(out))]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("dir"); ap.add_argument("--mode", required=True, choices=["scale", "rope"]); ap.add_argument("--fps", type=float, default=10)
    a = ap.parse_args()
    rows = (scale_mode if a.mode == "scale" else rope_mode)(os.path.join(a.dir, "video.mp4"), a.fps)
    with open(os.path.join(a.dir, "motion.csv"), "w", newline="") as f:
        w = csv.writer(f); w.writerow(["t_video_s", "value", "energy", "quality", "raw"])
        for r in rows:
            w.writerow([round(r[0], 3)] + ["" if (isinstance(v, float) and np.isnan(v)) else round(float(v), 5) for v in r[1:]])
    ok = sum(1 for r in rows if not (isinstance(r[1], float) and np.isnan(r[1])))
    print(f"{a.dir}: {len(rows)} samples, {ok} valid ({a.mode})")
