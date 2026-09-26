#!/usr/bin/env python3
"""
Analyse a day of MyoLift experiments (EMG + video motion from tools/video_motion.py).

  python tools/session_analyse.py <experiments dir> <out dir> [labels.json]

Per experiment: %MVC envelopes (both arms), sync lag between video motion and EMG, reps from
video motion (timing, range, concentric/eccentric seconds), per-rep EMG, holds, median
frequency. Across the session: timeline with rest gaps, fatigue indicators. Writes
results.json + series_<id>.json (downsampled, chart-ready).
"""
import glob, json, os, sys
from datetime import datetime

import numpy as np
from scipy.signal import butter, find_peaks, iirnotch, sosfiltfilt, filtfilt, welch

sys.path.insert(0, os.path.dirname(__file__))
import experiment_analyse as ea  # noqa: E402

FS = ea.FS_ENV


def iso(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def load_motion(d):
    p = os.path.join(d, "motion.csv")
    if not os.path.exists(p):
        return None
    import csv
    r = list(csv.DictReader(open(p)))
    f = lambda k: np.array([float(x[k]) if x[k] != "" else np.nan for x in r])
    return f("t_video_s"), f("value"), f("quality")


def cal_for(meta, sid, side):
    best = None
    for k, v in (meta.get("calibrations") or {}).items():
        a, mus, sd = k.split("|")
        if a == sid and sd == side and (best is None or v["at"] > best["at"]):
            best = v
    return best


def emg(d, meta):
    """left/right: (grid, env µV, %MVC, raw filtered, raw t, fs)."""
    out = {}
    for p in meta["placements"]:
        b = os.path.join(d, p["sensorId"].replace(":", "") + ".bin")
        if not os.path.exists(b):
            continue
        ts, x, bad, fs = ea.decode_bin(b)
        sos = butter(4, 20, "highpass", fs=fs, output="sos")
        y = sosfiltfilt(sos, np.where(bad, 0, x)); bn, an = iirnotch(50, 30, fs); y = filtfilt(bn, an, y)
        g, e = ea.envelope(ts, x, bad, fs)
        c = cal_for(meta, p["sensorId"], p["side"])
        mvc = c["ref"]["mvcRms"] if c else np.percentile(e, 99)
        out[p["side"]] = {"t": g, "env": e, "pct": 100 * e / mvc, "mvc": mvc, "raw": y, "rt": ts, "fs": fs}
    return out


def on_grid(E):
    t0 = max(v["t"][0] for v in E.values()); t1 = min(v["t"][-1] for v in E.values())
    g = np.arange(t0, t1, 1 / FS)
    return g, {k: np.interp(g, v["t"], v["pct"]) for k, v in E.items()}


def mdf(seg, fs):
    if len(seg) < fs * 0.5:
        return np.nan
    f, p = welch(seg, fs=fs, nperseg=min(len(seg), 512))
    c = np.cumsum(p)
    return float(f[np.searchsorted(c, c[-1] / 2)])


def tremor_ratio(seg, fs):
    """8–12 Hz share of the (10 ms rectified) envelope spectrum between 2 and 20 Hz."""
    if len(seg) < fs:
        return np.nan
    w = max(1, int(0.01 * fs))
    env = np.convolve(np.abs(seg), np.ones(w) / w, mode="same")[:: w]
    f, p = welch(env - env.mean(), fs=fs / w, nperseg=min(len(env), 256))
    band = (f >= 8) & (f <= 12); tot = (f >= 2) & (f <= 20)
    return float(p[band].sum() / max(p[tot].sum(), 1e-12))


def sync_lag(g, act, tv, val, offset, lo=-0.3, hi=1.5):
    """Video lag that maximises corr(activity, motion position) with the physically expected sign
    (+: rope lockout = hands down = high position = high EMG; machines: the same trace orientation),
    searched only over a plausible camera start latency [lo, hi] s so the rep period can't alias it."""
    ok = ~np.isnan(val)
    if ok.sum() < 30:
        return offset, 0.0, 0.0, 1
    best = (0.0, -9.0)
    for L in np.arange(lo, hi + 1e-9, 0.02):
        m = np.interp(g, tv[ok] + offset + L, val[ok], left=np.nan, right=np.nan)
        k = ~np.isnan(m)
        if k.sum() < 100:
            continue
        r = np.corrcoef(m[k], act[k])[0, 1]
        if r > best[1]:
            best = (L, r)
    return offset + best[0], best[0], best[1], 1


def motion_reps(g, pos, active, prom_frac=0.35):
    """Reps as excursions to the far end of the movement (troughs of the position trace):
    rope = hands up at the stretch, assisted pull-up = hanging low, dip = bottom of the dip.
    Eccentric = the way into the trough, concentric = the way back to the plateau."""
    x = np.where(np.isnan(pos), np.nanmedian(pos), pos)
    x = np.convolve(x, np.ones(5) / 5, mode="same")
    act = active | (np.convolve(active.astype(float), np.ones(int(2 * FS)), mode="same") > 0)
    rng = (np.nanpercentile(x[act], 97) - np.nanpercentile(x[act], 3)) if act.any() else np.ptp(x)
    tr, _ = find_peaks(-x, prominence=prom_frac * rng, distance=int(0.8 * FS))
    tr = [t for t in tr if act[t]]
    reps = []
    w = int(3 * FS)
    for t in tr:
        a0, b0 = max(0, t - w), min(len(x), t + w)
        top = np.max(x[a0:t + 1]); top2 = np.max(x[t:b0])
        plat = min(top, top2)
        lvl = x[t] + 0.8 * (plat - x[t])
        a = t
        while a > a0 and x[a] < lvl:
            a -= 1
        b = t
        while b < b0 - 1 and x[b] < lvl:
            b += 1
        reps.append({"a": int(a), "p": int(t), "b": int(b), "rom": float(max(top, top2) - x[t]), "eccS": (t - a) / FS, "conS": (b - t) / FS})
    return reps, rng


def holds(g, pos, active, min_s=2.5):
    """Still periods (small motion speed) while the muscle is active."""
    x = np.where(np.isnan(pos), np.nanmedian(pos), pos)
    sp = np.abs(np.gradient(np.convolve(x, np.ones(9) / 9, mode="same"))) * FS
    thr = np.nanpercentile(sp[active], 35) if active.any() else 0
    still = (sp <= thr) & active
    out, i = [], 0
    while i < len(still):
        if still[i]:
            j = i
            while j < len(still) and still[j]:
                j += 1
            if (j - i) / FS >= min_s:
                out.append((i, j))
            i = j
        else:
            i += 1
    return out


def main(root, outdir, labels_path=None):
    os.makedirs(outdir, exist_ok=True)
    labels = json.load(open(labels_path)) if labels_path else {}
    res = {"experiments": [], "session": {}}
    prev_end = None
    for d in sorted(glob.glob(os.path.join(root, "*"))):
        meta = json.load(open(os.path.join(d, "experiment.json")))
        lab = labels.get(meta["id"], {})
        E = emg(d, meta)
        g, P = on_grid(E)
        both = sum(P.values()) / len(P)
        rest = np.percentile(both, 10)
        active = both > max(rest * 3, 8)
        start, end = iso(meta["startedAt"]), iso(meta["endedAt"])
        gap = (start - prev_end).total_seconds() if prev_end else None
        prev_end = end
        r = {"id": meta["id"], "time": meta["startedAt"][11:19], "title": meta["title"], "notes": meta["notes"],
             "label": lab, "weightRecorded": meta.get("weight"), "weight": lab.get("weight", meta.get("weight")),
             "durationS": meta.get("durationS"), "restBeforeS": gap, "mvc": {k: v["mvc"] for k, v in E.items()},
             "activeS": float(active.sum() / FS),
             "p95pct": {k: float(np.percentile(v[active], 95)) if active.any() else 0 for k, v in P.items()},
             "meanActivePct": {k: float(v[active].mean()) if active.any() else 0 for k, v in P.items()},
             "lr_ratio_active": float(np.mean(P["left"][active]) / max(np.mean(P["right"][active]), 1e-9)) if active.any() and "left" in P and "right" in P else None}
        # median frequency across the active part: first vs last third
        mf = {}
        for side, v in E.items():
            act_t = g[active]
            if len(act_t) < FS * 3:
                continue
            segs = np.array_split(act_t, 3)
            vals = []
            for s in segs:
                i0, i1 = np.searchsorted(v["rt"], [s[0], s[-1]])
                vals.append(mdf(v["raw"][i0:i1], v["fs"]))
            mf[side] = vals
        r["mdfThirds"] = mf
        mo = load_motion(d)
        mode = lab.get("mode", "rope")
        series = {"t": g[::5].round(2).tolist(), **{f"pct_{k}": v[::5].round(1).tolist() for k, v in P.items()}}
        if mo is not None:
            tv, val, q = mo
            off0 = (meta.get("video") or {}).get("offsetS", 0.0)
            # the video file is shorter than the native start->stop span by the camera's start latency
            # (+ a little at the end): put t0 in the middle of that window (±half of it)
            import subprocess
            vdur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", os.path.join(d, "video.mp4")], capture_output=True, text=True).stdout)
            vid = meta["video"]
            span = (vid["stopNative"] - vid["startNative"]) / 1000 if vid.get("stopNative") else vdur
            slack = max(0.0, span - vdur)
            off = off0 + slack / 2
            _, _, rr, _ = sync_lag(g, both, tv, val, off, 0, 0.001)
            r["sync"] = {"recordedOffsetS": round(off0, 3), "videoS": vdur, "startStopS": round(span, 3), "usedOffsetS": round(off, 3), "uncertaintyS": round(slack / 2, 3), "emgMotionCorr": round(rr, 2)}
            pos = np.interp(g, tv[~np.isnan(val)] + off, val[~np.isnan(val)], left=np.nan, right=np.nan)
            if mode == "scale":
                pos = pos  # log scale: up = closer to the bar
            series["motion"] = np.nan_to_num(pos[::5], nan=0).round(3).tolist()
            if mode == "scale":
                # machines: a rep = rise to the top (peak of log scale); the hanging bottom is jittery
                sm = np.convolve(np.where(np.isnan(pos), np.nanmedian(pos), pos), np.ones(int(FS)) / FS, mode="same")
                reps, rng = motion_reps(g, -sm, active, prom_frac=lab.get("promFrac", 0.3))
            else:
                reps, rng = motion_reps(g, pos, active, prom_frac=lab.get("promFrac", 0.12))
            for rep in reps:
                a, p, b = rep["a"], rep["p"], rep["b"]
                for side, v in P.items():
                    rep[f"peak_{side}"] = float(v[a:b + 1].max()); rep[f"ecc_{side}"] = float(v[a:p + 1].mean()); rep[f"con_{side}"] = float(v[p:b + 1].mean())
                rep["t"] = float(g[p])
                rep["romRel"] = None
            if reps:
                ref = np.median(sorted([x["rom"] for x in reps])[-max(1, len(reps) // 3):])
                for rep in reps:
                    rep["romRel"] = rep["rom"] / ref if ref > 0 else None
            r["videoReps"] = reps
            r["videoRepCount"] = len(reps)
            hs = holds(g, pos, active)
            hl = []
            for i, j in hs:
                seg_t = (g[i], g[j - 1])
                h = {"t0": float(seg_t[0]), "t1": float(seg_t[1]), "durS": (j - i) / FS, "posRel": float(np.nanmean(pos[i:j]) - np.nanmin(pos[active])) / max(rng, 1e-9)}
                for side, v in E.items():
                    i0, i1 = np.searchsorted(v["rt"], seg_t)
                    seg = v["raw"][i0:i1]
                    half = len(seg) // 2
                    h[f"pct_{side}"] = float(P[side][i:j].mean())
                    h[f"slope_{side}"] = float(np.polyfit(np.arange(j - i) / FS, P[side][i:j], 1)[0])  # %MVC per s
                    h[f"cv_{side}"] = float(P[side][i:j].std() / max(P[side][i:j].mean(), 1e-9))
                    h[f"mdf0_{side}"] = mdf(seg[:half], v["fs"]); h[f"mdf1_{side}"] = mdf(seg[half:], v["fs"])
                    h[f"tremor_{side}"] = tremor_ratio(seg, v["fs"])
                hl.append(h)
            r["holds"] = hl
        res["experiments"].append(r)
        json.dump(series, open(os.path.join(outdir, f"series_{meta['id'][11:19]}.json"), "w"))
        print(r["time"], r["title"][:24].ljust(24), "rest", gap, "sync", r.get("sync"), "videoReps", r.get("videoRepCount"), "holds", len(r.get("holds", [])))
    json.dump(res, open(os.path.join(outdir, "results_py.json"), "w"), indent=1, default=float)


if __name__ == "__main__":
    main(*sys.argv[1:])
