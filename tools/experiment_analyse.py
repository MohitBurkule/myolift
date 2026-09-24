#!/usr/bin/env python3
"""
Line up an experiment's EMG and video, check the sync, and learn elbow angle from EMG.

  python tools/experiment_analyse.py <experiment dir> [more dirs...] [--fit]

Per experiment (run tools/elbow_angle.py first so angle.csv exists):
  1. decodes every <sensor>.bin into a 100 ms RMS envelope (20 Hz high-pass, 50 Hz notch) at 50 Hz
  2. sync check: the recorded video offset vs. the lag that best lines up EMG activity with arm
     movement (cross-correlation of envelope change and angular speed, searched within ±1.5 s).
     Reports both; warns when they differ by more than 150 ms. Also finds the sync flex
     (the first strong burst in the first 6 s).
  3. writes aligned.csv: t_s, env_<sensor>..., angle_left, angle_right (angle resampled onto the EMG time base)
With --fit, pools all given experiments and fits a ridge regression from EMG features (envelope,
its slope, a rolling min/max, time since the last low) to elbow angle, per side, with a
leave-one-experiment-out error, so we can tell whether EMG alone can stand in for the camera.
"""
import csv, json, math, os, struct, sys

import numpy as np

ROW = 252
FS_ENV = 50.0


def decode_bin(path):
    raw = open(path, "rb").read()
    n = len(raw) // ROW
    t, seq, samples = np.empty(n), np.empty(n), []
    for i in range(n):
        r = raw[i * ROW:(i + 1) * ROW]
        t[i] = struct.unpack_from("<d", r, 0)[0]
        seq[i] = r[9] | (r[10] << 8) | (r[11] << 16)
        s = np.frombuffer(r, dtype="<u2", count=119, offset=14).astype(float)
        samples.append(s)
    if not n:
        return None
    x = np.concatenate(samples)
    x = (x - 8192) * 0.30518
    # battery packets are all 8192 -> exactly 0: mark as gaps
    bad = np.repeat(np.array([np.all(s == 8192) for s in samples]), 119)
    # sample times: fit arrival time vs sequence number (sensor clock)
    a, b = np.polyfit(seq, t, 1)
    ts = (a * (np.repeat(seq, 119) + np.tile(np.arange(119) / 119.0, n)) + b) / 1000.0
    fs = 119 / (a / 1000.0)
    return ts, x, bad, fs


def envelope(ts, x, bad, fs):
    from scipy.signal import butter, iirnotch, sosfiltfilt, filtfilt
    sos = butter(4, 20, "highpass", fs=fs, output="sos")
    y = sosfiltfilt(sos, np.where(bad, 0, x))
    bn, an = iirnotch(50, 30, fs)
    y = filtfilt(bn, an, y)
    w = max(1, int(0.1 * fs))
    e = np.sqrt(np.convolve(y * y, np.ones(w) / w, mode="same"))
    grid = np.arange(ts[0], ts[-1], 1 / FS_ENV)
    return grid, np.interp(grid, ts, e)


def load_angle(d):
    p = os.path.join(d, "angle.csv")
    if not os.path.exists(p):
        return None
    rows = list(csv.DictReader(open(p)))
    f = lambda k: np.array([float(r[k]) if r[k] not in ("", None) else np.nan for r in rows])
    return {"tv": f("t_video_s"), "left": f("left_2d"), "right": f("right_2d"), "lvis": f("left_vis"), "rvis": f("right_vis")}


def best_lag(t, env, tv, ang, offset, span=1.5):
    """Lag (s) to add to video time so |d angle/dt| best matches |d env/dt|."""
    ok = ~np.isnan(ang)
    if ok.sum() < 30:
        return None, 0.0
    a = np.interp(tv, tv[ok], ang[ok])
    sp = np.abs(np.gradient(a, tv))
    de = np.abs(np.gradient(env, t))
    lags = np.arange(-span, span + 1e-9, 0.02)
    scores = []
    for L in lags:
        s = np.interp(t, tv + offset + L, sp, left=np.nan, right=np.nan)
        m = ~np.isnan(s)
        scores.append(np.corrcoef(s[m], de[m])[0, 1] if m.sum() > 50 else -1)
    k = int(np.nanargmax(scores))
    return offset + lags[k], float(scores[k])


def features(env):
    e = env / (np.percentile(env, 95) + 1e-9)
    slope = np.gradient(e) * FS_ENV
    win = int(2 * FS_ENV)
    pad = np.pad(e, (win, 0), mode="edge")
    mn = np.array([pad[i:i + win].min() for i in range(len(e))])
    mx = np.array([pad[i:i + win].max() for i in range(len(e))])
    since_low, c = np.zeros(len(e)), 0
    for i in range(len(e)):
        c = 0 if e[i] <= mn[i] * 1.05 else c + 1
        since_low[i] = c / FS_ENV
    return np.column_stack([e, slope, mn, mx, (e - mn) / (mx - mn + 1e-9), np.minimum(since_low, 10), np.ones(len(e))])


def analyse(d):
    meta = json.load(open(os.path.join(d, "experiment.json")))
    sensors = json.load(open(os.path.join(d, "sensors.json"))) if os.path.exists(os.path.join(d, "sensors.json")) else {}
    envs = {}
    for f in sorted(os.listdir(d)):
        if f.endswith(".bin"):
            r = decode_bin(os.path.join(d, f))
            if r:
                envs[f[:-4]] = envelope(*r)
    if not envs:
        print(f"{d}: no EMG"); return None
    t = max(v[0][0] for v in envs.values()), min(v[0][-1] for v in envs.values())
    grid = np.arange(t[0], t[1], 1 / FS_ENV)
    E = {k: np.interp(grid, g, e) for k, (g, e) in envs.items()}
    total = sum(E.values())
    # sync flex: first strong burst in the first 6 s
    first = grid < grid[0] + 6
    flex_t = float(grid[first][np.argmax(total[first])]) if first.any() else None
    out = {"id": meta.get("id"), "title": meta.get("title"), "sync_flex_s": flex_t, "sensors": list(E)}
    ang = load_angle(d)
    offset = (meta.get("video") or {}).get("offsetS", 0.0)
    if ang is not None:
        side_env = {}
        placements = {p["sensorId"]: p for p in (meta.get("placements") or [])}
        for k, e in E.items():
            p = next((p for sid, p in placements.items() if sid.replace(":", "_") in k or k in sid), None)
            side_env[(p or {}).get("side", k)] = e
        lagged = {}
        for side in ("left", "right"):
            e = side_env.get(side, total)
            L, score = best_lag(grid, e, ang["tv"], ang[side], offset)
            lagged[side] = (L, score)
        good = [v for v in lagged.values() if v[0] is not None and v[1] > 0.2]
        est = float(np.median([v[0] for v in good])) if good else None
        out["video_offset_recorded_s"] = offset
        out["video_offset_estimated_s"] = est
        out["sync_ok"] = est is None or abs(est - offset) <= 0.15
        use = est if (est is not None and abs(est - offset) > 0.15) else offset
        out["video_offset_used_s"] = use
        cols = {"t_s": grid}
        for k, e in E.items():
            cols[f"env_{k}"] = e
        for side in ("left", "right"):
            a = ang[side]; ok = ~np.isnan(a)
            cols[f"angle_{side}"] = np.interp(grid, ang["tv"][ok] + use, a[ok], left=np.nan, right=np.nan) if ok.sum() > 2 else np.full(len(grid), np.nan)
        with open(os.path.join(d, "aligned.csv"), "w", newline="") as f:
            w = csv.writer(f); w.writerow(cols.keys())
            for i in range(len(grid)):
                w.writerow([round(float(v[i]), 4) if not math.isnan(v[i]) else "" for v in cols.values()])
        out["_cols"] = cols
        out["_side_env"] = side_env
    return out


def fit(results):
    for side in ("left", "right"):
        data = []
        for r in results:
            if not r or "_cols" not in r or side not in r["_side_env"]:
                continue
            X = features(r["_side_env"][side]); y = r["_cols"][f"angle_{side}"]; m = ~np.isnan(y)
            if m.sum() > 100:
                data.append((r["id"], X[m], y[m]))
        if len(data) < 2:
            print(f"{side}: need angle + EMG from at least 2 experiments to fit"); continue
        errs = []
        for i in range(len(data)):
            Xtr = np.vstack([d[1] for j, d in enumerate(data) if j != i]); ytr = np.concatenate([d[2] for j, d in enumerate(data) if j != i])
            w = np.linalg.solve(Xtr.T @ Xtr + 1.0 * np.eye(Xtr.shape[1]), Xtr.T @ ytr)
            pred = data[i][1] @ w
            errs.append(float(np.sqrt(np.mean((pred - data[i][2]) ** 2))))
        print(f"{side}: EMG -> elbow angle, leave-one-experiment-out RMSE {np.mean(errs):.1f}° (per experiment: {', '.join(f'{e:.0f}' for e in errs)})")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    res = []
    for d in args:
        r = analyse(d)
        res.append(r)
        if r:
            show = {k: v for k, v in r.items() if not k.startswith("_")}
            print(json.dumps(show))
            if r.get("sync_ok") is False:
                print(f"  ! video offset looks off: recorded {r['video_offset_recorded_s']:.2f} s, EMG/motion says {r['video_offset_estimated_s']:.2f} s (using the estimate)")
    if "--fit" in sys.argv:
        fit(res)
