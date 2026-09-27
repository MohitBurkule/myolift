"""
Two-component fatigue (fast metabolic + slow), capacity C = 1 - Df - Ds.
  working at load W:  dDf/dt = kf1 * a ,  dDs/dt = kf2 * a      with a = min(1, u / C), u = W_eff / F0 (relative effort, XF-style)
  resting:            dDf/dt = -kr1 * Df, dDs/dt = -kr2 * Ds
Activation a = W_eff / (F0 * C); EMG = E_side + G_side * a**b; a rep fails when a > 1.
"""
import numpy as np
PN = ["logGl", "logGr", "b", "logEl", "logEr", "logF0", "logkf1", "logkr1", "logkf2", "logkr2"]
W0 = 3.0
def unpack(p):
    e = np.exp
    return dict(Gl=e(p[0]), Gr=e(p[1]), b=p[2], El=e(p[3]), Er=e(p[4]), W0=W0, F0=e(p[5]),
                kf1=e(p[6]), kr1=e(p[7]), kf2=e(p[8]), kr2=e(p[9]))
def capacity_timeline(events, P):
    Df = Ds = 0.0; t = 0.0; out = []
    for (s, e, W) in events:
        if s > t:
            Df *= np.exp(-P["kr1"] * (s - t)); Ds *= np.exp(-P["kr2"] * (s - t))
        c0 = max(0.02, 1 - Df - Ds)
        u = (W + P["W0"]) / P["F0"]
        # fatigue driven by relative effort a = u / C (Xia & Frey-Law style); 0.25 s steps
        n = max(1, int((e - s) / 0.5)); dt = (e - s) / n
        for _ in range(n):
            a = min(1.0, u / max(0.05, 1 - Df - Ds))
            Df += P["kf1"] * a * dt
            Ds += P["kf2"] * a * dt
        out.append((c0, max(0.02, 1 - Df - Ds)))
        t = e
    return out
