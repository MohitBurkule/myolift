#!/usr/bin/env python3
"""Per-rep effort vs movement for the rope recordings of one session (see analysis26/effort)."""
import json, os, sys, glob
from datetime import datetime
import numpy as np
from scipy.signal import find_peaks, savgol_filter
sys.path.insert(0, os.path.dirname(__file__))
import experiment_analyse as ea

SP = "/tmp/claude-1000/-home-mohit/3b339da3-a486-4d8d-8451-d60feabcc24b/scratchpad/analysis26"
EXP = os.path.expanduser("~/myolift-data/exp1/experiments")
labels = json.load(open(f"{SP}/labels.json"))
curve = json.load(open(f"{SP}/modelfit/emg_vs_load.json"))
OUT = f"{SP}/effort"


def kg_eq(emg, side):
    c = curve[side]
    return max(0.0, ((max(emg - c["E0"], 0)) / c["k"]) ** (1 / c["b"]) - 3)


def mdf(x, fs):
    if len(x) < 256: return np.nan
    f = np.fft.rfftfreq(len(x), 1 / fs); p = np.abs(np.fft.rfft(x - x.mean())) ** 2
    m = (f > 20) & (f < 450); c = np.cumsum(p[m]); return float(f[m][np.searchsorted(c, c[-1] / 2)])


def load_emg(d, meta):
    pl = {p["sensorId"].replace(":", ""): p["side"] for p in meta["placements"]}
    out = {}
    from scipy.signal import butter, sosfiltfilt, iirnotch, filtfilt
    for b in glob.glob(d + "/*.bin"):
        ts, x, bad, fs = ea.decode_bin(b)
        sos = butter(4, 20, "highpass", fs=fs, output="sos"); y = sosfiltfilt(sos, np.where(bad, 0, x))
        bn, an = iirnotch(50, 30, fs); y = filtfilt(bn, an, y)
        w = int(0.1 * fs); env = np.sqrt(np.convolve(y * y, np.ones(w) / w, "same"))
        out[pl.get(os.path.basename(b)[:-4], "?")] = (ts, y, env, fs)
    return out


reps, sets = [], []
t_session0 = None
for d in sorted(glob.glob(EXP + "/*")):
    k = os.path.basename(d); L = labels.get(k, {})
    if L.get("ex") != "rope": continue
    meta = json.load(open(d + "/experiment.json"))
    t0 = datetime.fromisoformat(meta["startedAt"].replace("Z", "+00:00")).timestamp()
    t_session0 = t_session0 or t0
    mo = np.genfromtxt(d + "/motion.csv", delimiter=",", names=True)
    tv, pos = mo["t_video_s"], mo["value"]
    if len(pos) < 30: continue
    off = (meta.get("video") or {}).get("offsetS", 0) + 0.13
    te = tv + off  # EMG clock
    fsm = 1 / np.median(np.diff(tv))
    p = savgol_filter(pos, 7 if len(pos) > 7 else 3, 2)
    rng = np.percentile(p, 98) - np.percentile(p, 2)
    lock, _ = find_peaks(p, prominence=0.18 * rng, distance=int(2.0 * fsm))  # lockout = max down
    tops, _ = find_peaks(-p, prominence=0.08 * rng, distance=int(1.0 * fsm))
    emg = load_emg(d, meta)
    q = L["q"]; W = L["weight"]
    set_rows = []
    for li in lock:
        before = tops[tops < li]; after = tops[tops > li]
        if not len(before) or not len(after): continue
        a, c = before[-1], after[0]
        dn = p[li] - p[a]; up = p[li] - p[c]
        if dn <= 0: continue
        vel = np.gradient(p, tv)
        # hold at lockout: time within 5% of rep travel from the lockout value
        near = np.where(np.abs(p[a:c + 1] - p[li]) < 0.05 * max(dn, 1e-6))[0]
        hold = (near.max() - near.min()) / fsm if len(near) else 0
        con = (li - a) / fsm; ecc = (c - li) / fsm
        r = {"rec": k[11:19], "q": q, "w": W, "t_clock": (t0 - t_session0 + te[li]) / 60, "t_rec": float(te[li]),
             "con_s": con, "ecc_s": ecc, "hold_s": hold, "rom_px": float(dn),
             "vcon": float(vel[a:li + 1].mean()), "vcon_pk": float(vel[a:li + 1].max()), "vecc": float(-vel[li:c + 1].mean())}
        for side, (ts, y, env, fs) in emg.items():
            s0, s1, s2 = np.searchsorted(ts, [te[a], te[li], te[c]])
            if s2 - s0 < 50: continue
            ic = float(env[s0:s1].sum() / fs); ie = float(env[s1:s2].sum() / fs)
            r[f"{side}_icon"], r[f"{side}_iecc"] = ic, ie
            r[f"{side}_mcon"] = float(env[s0:s1].mean()) if s1 > s0 else np.nan
            r[f"{side}_mecc"] = float(env[s1:s2].mean())
            r[f"{side}_kg"] = kg_eq(r[f"{side}_mcon"], side)
            r[f"{side}_mdf"] = mdf(y[s0:s2], fs)
        if "left_icon" not in r or "right_icon" not in r: continue
        # a real rep: the triceps worked (both sides well above rest) and the hands travelled
        rest = {sd: np.percentile(v[2], 5) for sd, v in emg.items()}
        if r["left_mcon"] < max(25, 5 * rest["left"]) or r["right_mcon"] < max(15, 5 * rest["right"]): continue
        set_rows.append(r)
    if not set_rows: continue
    full = np.array([r["rom_px"] for r in set_rows]); ref = np.median(np.sort(full)[-max(3, len(full) // 3):])
    set_rows = [r for r in set_rows if r["rom_px"] >= 0.2 * ref]
    # drop set: split into segments by gaps > 8 s
    seg = 0; prev = None
    dw = L.get("dropWeights")
    for r in set_rows:
        if prev is not None and r["t_rec"] - prev > 12: seg += 1
        prev = r["t_rec"]; r["seg"] = seg
        if dw: r["w"] = dw[min(seg, len(dw) - 1)]
        r["rel_rom"] = r["rom_px"] / ref
        r["rom_s"] = r["rel_rom"] / max(r["con_s"], 0.1)
        E = r["left_icon"] + r["right_icon"] + r["left_iecc"] + r["right_iecc"]
        r["emg_int"] = E
        r["nme"] = r["w"] * r["rel_rom"] / E * 1000  # kg·ROM per mV·s
        r["kg_eq"] = (r["left_kg"] + r["right_kg"]) / 2
        r["effort_move"] = r["kg_eq"] / max(r["w"] * r["rom_s"], 1e-6)
        r["left_share"] = (r["left_icon"] + r["left_iecc"]) / E
        r["set"] = f'{r["rec"]}' + (f'.{seg}' if dw else "")
    reps += set_rows

# per set
by = {}
for r in reps: by.setdefault(r["set"], []).append(r)
setinfo = []
recs_sorted = sorted({r["rec"] for r in reps})
for s, rr in by.items():
    rr.sort(key=lambda r: r["t_rec"])
    n = len(rr); k2 = max(1, n // 3)
    f, l = rr[:k2], rr[-k2:]
    m = lambda xs, key: float(np.nanmean([x[key] for x in xs]))
    setinfo.append({"set": s, "q": rr[0]["q"], "w": rr[0]["w"], "n": n, "t_clock": rr[0]["t_clock"], "t_end": rr[-1]["t_clock"],
                    "nme_change": (m(l, "nme") / m(f, "nme") - 1) * 100 if n >= 3 else None,
                    "emg_rise": (m(l, "left_mcon") + m(l, "right_mcon")) / (m(f, "left_mcon") + m(f, "right_mcon")) * 100 - 100 if n >= 3 else None,
                    "rom_loss": (1 - m(l, "rel_rom") / m(f, "rel_rom")) * 100 if n >= 3 else None,
                    "first_nme": rr[0]["nme"], "tut_con": sum(x["con_s"] for x in rr), "tut_ecc": sum(x["ecc_s"] for x in rr), "tut_hold": sum(x["hold_s"] for x in rr),
                    "speed": m(rr, "rom_s"), "rom": m(rr, "rel_rom"), "kg": m(rr, "kg_eq")})
setinfo.sort(key=lambda s: s["t_clock"])
for i, s in enumerate(setinfo):
    s["rest_before_s"] = (s["t_clock"] - setinfo[i - 1]["t_end"]) * 60 if i else None
json.dump({"reps": reps, "sets": setinfo}, open(f"{OUT}/reps.json", "w"), default=float)
print(len(reps), "reps,", len(setinfo), "sets")
