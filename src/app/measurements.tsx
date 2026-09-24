import React, { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import Svg, { Circle, Line, Polyline, Text as SvgText } from "react-native-svg";
import { Body, Button, Card, Label } from "../components/ui";
import { addMeasurement, daysSinceLast, deleteMeasurement, useMeasurements, type Measurement } from "../lib/measurements";
import { useSettings } from "../lib/settings";
import { useTheme } from "../lib/theme";

const num = (s: string) => { const v = parseFloat(s.replace(",", ".")); return Number.isFinite(v) ? v : undefined; };

/** Body measurements: the only real check of whether training (and the app's numbers) track growth. */
export default function MeasurementsScreen() {
  const t = useTheme();
  const list = useMeasurements();
  const s = useSettings();
  const [f, setF] = useState<Record<string, string>>({ exercise: s.exercise?.name ?? "" });
  const [confirm, setConfirm] = useState<string | null>(null);
  const days = daysSinceLast();
  const set = (k: string) => (v: string) => setF({ ...f, [k]: v });
  const input = (k: string, label: string, numeric = true) => (
    <View style={{ flex: 1, minWidth: 130, gap: 4 }}>
      <Text style={{ color: t.muted, fontSize: 12 }}>{label}</Text>
      <TextInput value={f[k] ?? ""} onChangeText={set(k)} keyboardType={numeric ? "decimal-pad" : "default"} accessibilityLabel={label}
        style={{ borderWidth: 1, borderColor: t.line, borderRadius: 10, paddingHorizontal: 10, minHeight: 42, color: t.ink, backgroundColor: t.panel }} />
    </View>
  );
  const save = () => {
    const w = num(f.testWeight ?? ""), r = num(f.testReps ?? "");
    addMeasurement({
      at: new Date().toISOString(),
      leftRelaxed: num(f.lr ?? ""), rightRelaxed: num(f.rr ?? ""), leftFlexed: num(f.lf ?? ""), rightFlexed: num(f.rf ?? ""),
      leftForearm: num(f.lfa ?? ""), rightForearm: num(f.rfa ?? ""), bodyweight: num(f.bw ?? ""),
      test: w !== undefined && r !== undefined ? { exercise: f.exercise || "", weight: w, reps: r } : undefined,
      notes: f.notes?.trim() || undefined,
    });
    setF({ exercise: f.exercise });
  };
  const any = ["lr", "rr", "lf", "rf", "lfa", "rfa", "bw", "testReps", "notes"].some((k) => (f[k] ?? "").trim());
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      {days === null ? <Body muted>No measurements yet. Measure every 2 weeks: morning, same spot (widest part of the upper arm), same tape.</Body>
        : days > 14 ? <Card style={{ padding: 12, borderColor: t.warn }}><Text style={{ color: t.warn, fontWeight: "700" }}>Last measured {days} days ago. Time for a new one.</Text></Card>
        : <Body muted>Last measured {days === 0 ? "today" : `${days} day${days > 1 ? "s" : ""} ago`}. Next one in {14 - days} days.</Body>}
      {list.length >= 2 ? <Chart list={list} /> : null}

      <Label>New entry</Label>
      <Card style={{ padding: 12, gap: 10 }}>
        <Text style={{ color: t.ink, fontWeight: "600" }}>Upper arm (cm)</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{input("lr", "Left relaxed")}{input("rr", "Right relaxed")}</View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{input("lf", "Left flexed")}{input("rf", "Right flexed")}</View>
        <Text style={{ color: t.ink, fontWeight: "600" }}>Optional</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{input("lfa", "Left forearm (cm)")}{input("rfa", "Right forearm (cm)")}</View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{input("bw", "Bodyweight (kg)")}</View>
        <Text style={{ color: t.ink, fontWeight: "600" }}>Rep test (same weight each time, to failure)</Text>
        {input("exercise", "Exercise", false)}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{input("testWeight", `Weight (${s.unit})`)}{input("testReps", "Reps")}</View>
        {input("notes", "Notes", false)}
        <Button title="Save" variant="primary" disabled={!any} onPress={save} />
      </Card>

      {list.length ? <Label>History</Label> : null}
      {[...list].reverse().map((m) => (
        <Card key={m.id} style={{ padding: 12, gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Text style={{ color: t.ink, fontWeight: "700", flex: 1 }}>{new Date(m.at).toLocaleString()}</Text>
            <Button small variant="danger" title={confirm === m.id ? "Tap again" : "Delete"} onPress={() => {
              if (confirm !== m.id) { setConfirm(m.id); setTimeout(() => setConfirm(null), 3000); return; }
              deleteMeasurement(m.id);
            }} />
          </View>
          <Text style={{ color: t.ink, fontVariant: ["tabular-nums"] }}>{summary(m, s.unit)}</Text>
          {m.notes ? <Text style={{ color: t.muted, fontSize: 13 }}>{m.notes}</Text> : null}
        </Card>
      ))}
    </ScrollView>
  );
}

function summary(m: Measurement, unit: string) {
  const v = (x?: number) => (x === undefined ? "–" : String(x));
  const parts = [`Arm L ${v(m.leftRelaxed)}/${v(m.leftFlexed)} · R ${v(m.rightRelaxed)}/${v(m.rightFlexed)} cm (relaxed/flexed)`];
  if (m.leftForearm !== undefined || m.rightForearm !== undefined) parts.push(`Forearm L ${v(m.leftForearm)} · R ${v(m.rightForearm)} cm`);
  if (m.bodyweight !== undefined) parts.push(`${m.bodyweight} kg bodyweight`);
  if (m.test) parts.push(`${m.test.exercise || "Rep test"}: ${m.test.weight} ${unit} × ${m.test.reps}`);
  return parts.join("\n");
}

/** Relaxed upper-arm circumference over time, left and right. */
function Chart({ list }: { list: Measurement[] }) {
  const t = useTheme();
  const [w, setW] = useState(0);
  const H = 170, pad = { l: 34, r: 10, t: 12, b: 22 };
  const series = [
    { key: "leftRelaxed" as const, color: t.accent, label: "left" },
    { key: "rightRelaxed" as const, color: t.warn, label: "right" },
  ];
  const pts = list.flatMap((m) => series.map((s) => m[s.key]).filter((x): x is number => x !== undefined));
  if (!pts.length) return null;
  const lo = Math.floor(Math.min(...pts) - 0.5), hi = Math.ceil(Math.max(...pts) + 0.5);
  const t0 = new Date(list[0].at).getTime(), t1 = Math.max(t0 + 86400000, new Date(list[list.length - 1].at).getTime());
  const X = (at: string) => pad.l + ((new Date(at).getTime() - t0) / (t1 - t0)) * (w - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const ticks = [lo, (lo + hi) / 2, hi];
  return (
    <Card style={{ padding: 10, gap: 6 }}>
      <Text style={{ color: t.ink, fontWeight: "600" }}>Upper arm, relaxed (cm)</Text>
      <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ height: H }}>
        {w ? (
          <Svg width={w} height={H}>
            {ticks.map((v) => (
              <React.Fragment key={v}>
                <Line x1={pad.l} x2={w - pad.r} y1={Y(v)} y2={Y(v)} stroke={t.line} strokeWidth={1} />
                <SvgText x={pad.l - 6} y={Y(v) + 4} fontSize={10} fill={t.muted} textAnchor="end">{v.toFixed(1)}</SvgText>
              </React.Fragment>
            ))}
            <SvgText x={pad.l} y={H - 6} fontSize={10} fill={t.muted}>{new Date(t0).toLocaleDateString()}</SvgText>
            <SvgText x={w - pad.r} y={H - 6} fontSize={10} fill={t.muted} textAnchor="end">{new Date(t1).toLocaleDateString()}</SvgText>
            {series.map((s) => {
              const ms = list.filter((m) => m[s.key] !== undefined);
              return (
                <React.Fragment key={s.key}>
                  {ms.length > 1 ? <Polyline points={ms.map((m) => `${X(m.at)},${Y(m[s.key]!)}`).join(" ")} fill="none" stroke={s.color} strokeWidth={2} /> : null}
                  {ms.map((m) => <Circle key={m.id} cx={X(m.at)} cy={Y(m[s.key]!)} r={3.5} fill={s.color} />)}
                </React.Fragment>
              );
            })}
          </Svg>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", gap: 14 }}>
        {series.map((s) => <Text key={s.key} style={{ color: s.color, fontSize: 12, fontWeight: "600" }}>● {s.label}</Text>)}
      </View>
    </Card>
  );
}
