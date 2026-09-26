import React, { useState } from "react";
import { Text, View } from "react-native";
import Svg, { Circle, Line, Path } from "react-native-svg";
import type { VideoMotionResult } from "../core/videomotion";
import { useTheme } from "../lib/theme";

/**
 * The motion trace from the video (rope: hand height; machine: closeness to the bar) with a dot at
 * each rep's far end: filled = full, hollow = partial. `from`/`to` crop to a time window (s).
 */
export function MotionChart({ r, from, to, height = 120 }: { r: Pick<VideoMotionResult, "trace" | "reps" | "mode">; from?: number; to?: number; height?: number }) {
  const t = useTheme();
  const [w, setW] = useState(0);
  const idx = r.trace.t.map((x, i) => i).filter((i) => (from === undefined || r.trace.t[i] >= from) && (to === undefined || r.trace.t[i] <= to));
  if (idx.length < 2) return null;
  const ts = idx.map((i) => r.trace.t[i]), vs = idx.map((i) => r.trace.v[i]);
  const t0 = ts[0], t1 = ts[ts.length - 1];
  const sorted = vs.slice().sort((a, b) => a - b), lo = sorted[Math.floor(sorted.length * 0.02)], hi = sorted[Math.ceil(sorted.length * 0.98) - 1];
  const pad = 6, X = (x: number) => pad + ((x - t0) / (t1 - t0 || 1)) * (w - 2 * pad);
  // rope: down = positive, draw down as down; machine: closer to the bar = up
  const Y = (v: number) => { const f = (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo || 1); return r.mode === "rope" ? pad + f * (height - 2 * pad) : height - pad - f * (height - 2 * pad); };
  const d = ts.map((x, i) => `${i ? "L" : "M"}${X(x).toFixed(1)},${Y(vs[i]).toFixed(1)}`).join("");
  const at = (x: number) => { let k = 0; while (k < ts.length - 1 && ts[k] < x) k++; return vs[k]; };
  const reps = r.reps.filter((p) => p.t >= t0 && p.t <= t1);
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ gap: 4 }}>
      {w ? (
        <Svg width={w} height={height}>
          <Line x1={pad} x2={w - pad} y1={height - 1} y2={height - 1} stroke={t.line} />
          <Path d={d} stroke={t.accent} strokeWidth={1.6} fill="none" />
          {reps.map((p, i) => <Circle key={i} cx={X(p.t)} cy={Y(at(p.t))} r={4} stroke={t.ink} strokeWidth={1.5} fill={p.range === "full" ? t.ink : t.panel} />)}
        </Svg>
      ) : <View style={{ height }} />}
      <Text style={{ color: t.muted, fontSize: 12 }}>
        {r.mode === "rope" ? "Hand height from the video (down = pushed down)." : "Closeness to the overhead frame (up = closer)."} ● full rep ○ partial
      </Text>
    </View>
  );
}
