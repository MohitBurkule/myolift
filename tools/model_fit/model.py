"""
Session triceps model (both arms together, rope pushdown), fitted without the MVC squeeze.

State: C(t) = fraction of fresh force capacity left (1 = fresh).
  working  (inside a rep, load W): dC/dt = -kf * W_eff / F0          (fatigue ~ force produced; linear in time)
  resting                          : dC/dt =  kr * (1 - C)           (exponential recovery)
Activation needed for a rep at load W:  a = W_eff / (F0 * C),  W_eff = W + W0
EMG (per side):  EMG = E_side + G_side * a ** b   (E = steady co-contraction/posture EMG)       (G_side = EMG at true maximal activation = model-derived "MVC")
Failure: a rep is not completable (turns into a partial) when a > 1.
Parameters: G_left, G_right, b, W0, F0, kf, kr.
"""
import numpy as np

PN = ["logGl", "logGr", "b", "logEl", "logEr", "logF0", "logkf", "logkr"]
W0 = 3.0  # forearms + rope, kg (fixed: not identifiable separately from the baseline)

def unpack(p):
    return dict(Gl=np.exp(p[0]), Gr=np.exp(p[1]), b=p[2], El=np.exp(p[3]), Er=np.exp(p[4]), W0=W0,
                F0=np.exp(p[5]), kf=np.exp(p[6]), kr=np.exp(p[7]))

def capacity_timeline(events, P):
    """events: time-ordered list of (start, end, W). Returns C at each event start and end."""
    C, t, out = 1.0, 0.0, []
    for (s, e, W) in events:
        if s > t:
            C = 1 - (1 - C) * np.exp(-P["kr"] * (s - t))
        c0 = C
        C = max(0.02, C - P["kf"] * (W + P["W0"]) / P["F0"] * (e - s))
        out.append((c0, C))
        t = e
    return out
