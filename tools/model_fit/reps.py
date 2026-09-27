"""Per-rep table for the 26 Sep session from analysis26/results.json (+ notes-derived weights)."""
import json, os, datetime as dt
A = "/tmp/claude-1000/-home-mohit/3b339da3-a486-4d8d-8451-d60feabcc24b/scratchpad/analysis26"
EXP = os.path.expanduser("~/myolift-data/exp1/experiments")

# drop set: weight per segment, boundaries at the rest gaps (s since recording start)
DROP = [(0, 36), (40, 32), (70, 27), (120, 23), (190, 18), (223, 14)]

def load():
    r = json.load(open(f"{A}/results.json"))
    ids = sorted(os.listdir(EXP))
    t0 = None
    reps, exps = [], []
    for x, eid in zip(r["experiments"], ids):
        meta = json.load(open(f"{EXP}/{eid}/experiment.json"))
        st = dt.datetime.fromisoformat(meta["startedAt"].replace("Z", "+00:00")).timestamp()
        t0 = st if t0 is None else t0
        lab = x["label"]; w = lab.get("weight", x["weight"])
        e = {"id": eid, "time": x["time"], "q": lab["q"], "ex": lab["ex"], "w": w, "start": st - t0,
             "dur": x["durationS"], "mvc": x["mvc"], "mdf": x.get("mdfThirds")}
        exps.append(e)
        for i, q in enumerate(x["detector"]["repList"]):
            ww = w
            if lab["q"] == "dropset":
                ww = [wt for (s, wt) in DROP if q["start"] >= s][-1]
            full = q.get("videoRange") == "full" if q.get("videoRange") else q["range"] == "full"
            rep = {"exp": x["time"], "q": lab["q"], "ex": lab["ex"], "w": ww, "i": i, "t": st - t0 + q["start"],
                   "tin": q["start"], "end": st - t0 + q["end"], "conS": q.get("conS"), "eccS": q.get("eccS"), "rom": q.get("romVideo"),
                   "romRel": q.get("romRel"), "full": full}
            for s in ("left", "right"):
                m = x["mvc"][s]
                for k in ("con", "ecc"):
                    v = q.get(f"{k}Pct_{s}")
                    rep[f"{k}_uV_{s}"] = v * m / 100 if v is not None else None
                v = q.get(f"peak_{s}")
                rep[f"peak_uV_{s}"] = v * m / 100 if v is not None else None
            reps.append(rep)
    return exps, reps

if __name__ == "__main__":
    e, r = load()
    for x in e: print(x["time"], x["q"], x["w"], round(x["start"]), round(x["dur"]))
    import collections
    print(len(r), collections.Counter((q["q"], q["full"]) for q in r))
    for q in r[:3]: print(q)
