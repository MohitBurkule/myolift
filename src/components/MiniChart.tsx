import React, { useState } from "react";
import { Text, View } from "react-native";
import Svg, { Circle, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { useTheme } from "../lib/theme";

export interface MiniSeries { name: string; color?: string; points: [number, number][]; line?: boolean; dashed?: boolean }

/** Small scatter / line chart (numeric x) or grouped / stacked bars (category x). */
export function MiniChart({ series, bars, stacked, height = 150, xLabel, yLabel, zero }: {
  series: MiniSeries[]; bars?: string[]; stacked?: boolean; height?: number; xLabel?: string; yLabel?: string; zero?: boolean;
}) {
  const t = useTheme();
  const [w, setW] = useState(0);
  const palette = [t.accent, t.rec, t.ok, t.warn, "#8b5cf6", "#0ea5e9"];
  const col = (s: MiniSeries, i: number) => s.color ?? palette[i % palette.length];
  const pts = series.flatMap((s) => s.points).filter((p) => p[1] === p[1] && isFinite(p[1]));
  if (!pts.length) return <Text style={{ color: t.muted, fontSize: 12 }}>Not enough data.</Text>;
  const L = 34, R = 6, T = 6, B = 18;
  let y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
  if (stacked && bars) { y0 = 0; y1 = Math.max(...bars.map((_, k) => series.reduce((s, x) => s + (x.points[k]?.[1] ?? 0), 0))); }
  if (zero || bars) y0 = Math.min(0, y0);
  if (y1 === y0) y1 = y0 + 1;
  const pad = (y1 - y0) * 0.08; y1 += pad; if (!zero && !bars) y0 -= pad;
  const Y = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (height - T - B);
  let X: (v: number) => number;
  let x0 = 0, x1 = 1;
  if (bars) { const bw = (w - L - R) / bars.length; X = (k) => L + (k + 0.5) * bw; }
  else { x0 = Math.min(...pts.map((p) => p[0])); x1 = Math.max(...pts.map((p) => p[0])); if (x1 === x0) x1 = x0 + 1; X = (v) => L + ((v - x0) / (x1 - x0)) * (w - L - R); }
  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1));
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ gap: 4 }}>
      {w ? (
        <Svg width={w} height={height}>
          {[y0, (y0 + y1) / 2, y1].map((v, i) => (
            <React.Fragment key={i}>
              <Line x1={L} x2={w - R} y1={Y(v)} y2={Y(v)} stroke={t.line} />
              <SvgText x={L - 4} y={Y(v) + 4} fontSize={10} fill={t.muted} textAnchor="end">{fmt(v)}</SvgText>
            </React.Fragment>
          ))}
          {!bars ? [x0, (x0 + x1) / 2, x1].map((v, i) => <SvgText key={i} x={X(v)} y={height - 4} fontSize={10} fill={t.muted} textAnchor="middle">{fmt(v)}</SvgText>) : null}
          {bars ? bars.map((_, k) => {
            const bw = ((w - L - R) / bars.length) * 0.7;
            let acc = 0;
            return series.map((s, i) => {
              const v = s.points[k]?.[1] ?? 0;
              if (stacked) { const r = <Rect key={`${k}-${i}`} x={X(k) - bw / 2} y={Y(acc + v)} width={bw} height={Math.max(0.5, Y(acc) - Y(acc + v))} fill={col(s, i)} />; acc += v; return r; }
              const sw = bw / series.length;
              return <Rect key={`${k}-${i}`} x={X(k) - bw / 2 + i * sw} y={Math.min(Y(0), Y(v))} width={sw} height={Math.max(0.5, Math.abs(Y(v) - Y(0)))} fill={col(s, i)} />;
            });
          }) : series.map((s, i) => s.line
            ? <Path key={i} d={s.points.filter((p) => p[1] === p[1]).map((p, j) => `${j ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("")} stroke={col(s, i)} strokeWidth={2} strokeDasharray={s.dashed ? "5,4" : undefined} fill="none" />
            : s.points.filter((p) => p[1] === p[1]).map((p, j) => <Circle key={`${i}-${j}`} cx={X(p[0])} cy={Y(p[1])} r={2.6} fill={col(s, i)} opacity={0.85} />))}
        </Svg>
      ) : <View style={{ height }} />}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {series.map((s, i) => <Text key={i} style={{ color: col(s, i), fontSize: 11 }}>● {s.name}</Text>)}
        {xLabel || yLabel ? <Text style={{ color: t.muted, fontSize: 11 }}>{[yLabel, xLabel && `vs ${xLabel}`].filter(Boolean).join(" ")}</Text> : null}
      </View>
    </View>
  );
}
