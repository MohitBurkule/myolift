import numpy as np, json
from reps import load
from scipy.optimize import least_squares
E, R = load()
rope = [q for q in R if q["ex"] == "rope" and q["full"] and q["con_uV_left"]]
# first 2 full reps per recording (drop set: first 2 full reps per segment)
by = {}
for q in rope:
    k = (q["exp"], q["w"]); by.setdefault(k, []).append(q)
rows = []
for k, v in by.items():
    for q in v[:2]: rows.append(q)
for q in rows: print(q["exp"], q["q"][:14].ljust(14), q["w"], round(q["t"]), "conS", q["conS"], "L", round(q["con_uV_left"]), "R", round(q["con_uV_right"]))
