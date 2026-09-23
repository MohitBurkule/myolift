import React, { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import type { LoggedSet } from "../core/log";
import { ACT_DT, movingAverage } from "../core/workout";
import { seriesColumns, StaticPlot } from "../components/plots";
import { Body, Button, Card, Label, Pill, Title } from "../components/ui";
import { shortName } from "../lib/exercises";
import { getSettings } from "../lib/settings";
import { clock, useTheme } from "../lib/theme";
import { editSet, envelopeOf, liveLog, loadWorkout } from "../lib/workout";

/** One set: activation per arm with reps and holds marked, rep-by-rep numbers, and corrections. */
export default function SetScreen() {
  const t = useTheme();
  const { sid, wid } = useLocalSearchParams<{ sid: string; wid?: string }>();
  const [set, setSet] = useState<LoggedSet | null>(null);
  const [traces, setTraces] = useState<Record<string, Float32Array | null>>({});
  const [confirm, setConfirm] = useState(false);
  const reload = () => {
    const sets = wid ? loadWorkout(wid)?.sets ?? [] : liveLog();
    setSet(sets.find((s) => s.id === sid) ?? null);
  };
  useEffect(reload, [sid, wid]);
  useEffect(() => {
    if (!set) return;
    (async () => {
      const out: Record<string, Float32Array | null> = {};
      for (const side of set.sides) out[side.key] = await envelopeOf(wid ?? null, side.key);
      setTraces(out);
    })();
  }, [set?.id]);
  if (!set) return <View style={{ flex: 1, backgroundColor: t.bg, padding: 24 }}><Body muted>Set not found (it may have been merged or deleted).</Body></View>;

  const step = getSettings().weightStep;
  const pad = 1500, a = set.start - pad, b = set.end + pad, span = b - a;
  const refs = getSettings().refs;
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
      <Title>{shortName({ id: set.exerciseId, name: set.exerciseName })}{set.grip ? ` · ${set.grip}` : ""}</Title>
      <Text style={{ color: t.muted, fontVariant: ["tabular-nums"] }}>{clock(set.start / 1000)}–{clock(set.end / 1000)} into the workout · {((set.end - set.start) / 1000).toFixed(0)} s</Text>
      {set.flags.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{set.flags.map((f, i) => <Pill key={i} text={f.text} tone={f.kind === "good" ? "ok" : "warn"} />)}</View> : null}

      {set.sides.map((side) => {
        const env = traces[side.key];
        const ref = Object.entries(refs).find(([k]) => k.startsWith(side.key + "|"))?.[1]?.ref;
        let plot: React.ReactNode = <ActivityIndicator color={t.accent} />;
        if (env === null) plot = <Body muted>No signal saved for this sensor.</Body>;
        else if (env && ref) {
          const k0 = Math.max(0, Math.floor(a / ACT_DT)), k1 = Math.min(env.length, Math.ceil(b / ACT_DT));
          const smooth = movingAverage(env.slice(k0, k1), 10);
          const cols = seriesColumns(smooth, 0, smooth.length, 280, 100 / ref.mvcRms);
          const x = (tm: number) => (tm - a) / span;
          plot = (
            <StaticPlot columns={cols} height={150} color={side.side === "left" ? t.sensors[0] : t.sensors[1]} unit="%"
              ymin={0} ymax={Math.max(cols.hi * 1.1, 20)}
              markers={side.reps.map((r, i) => ({ x: x(r.peakT), label: String(i + 1) }))}
              bands={side.holds.map((h) => [x(h.start), x(h.end)] as [number, number])} />
          );
        }
        return (
          <Card key={side.key} style={{ padding: 12, gap: 8 }}>
            <Text style={{ color: t.ink, fontWeight: "700" }}>{side.side} {side.muscle} · {side.reps.length} reps · {side.peak.toFixed(0)}% avg peak</Text>
            {plot}
            <Text style={{ color: t.muted, fontSize: 12 }}>Numbers mark each detected rep; green bands are holds.</Text>
            <View style={{ gap: 2 }}>
              <Text style={{ color: t.muted, fontSize: 12, fontVariant: ["tabular-nums"] }}>rep   peak   up (s)  down (s)  freq     range</Text>
              {side.reps.map((r, i) => (
                <Text key={i} style={{ color: t.ink, fontSize: 13, fontVariant: ["tabular-nums"] }}>
                  {String(i + 1).padStart(3)}   {r.peak.toFixed(0).padStart(3)}%   {r.riseS.toFixed(1).padStart(5)}   {r.fallS.toFixed(1).padStart(7)}   {(r.mdf ? `${r.mdf.toFixed(0)} Hz` : "–").padEnd(8)} {r.range === "top" ? "top half" : r.range === "bottom" ? "bottom half" : r.range ?? "full"}
                </Text>
              ))}
            </View>
            {side.holds.length ? <Text style={{ color: t.muted, fontSize: 13 }}>Holds: {side.holds.map((h) => `${((h.end - h.start) / 1000).toFixed(1)} s at ${h.level.toFixed(0)}% (${h.position === "top" ? "contracted" : "mid-range"})`).join(" · ")}</Text> : null}
          </Card>
        );
      })}
      <Body muted style={{ fontSize: 12 }}>Range is estimated from activation (a full rep peaks high and relaxes low; top-half partials never relax, bottom-half partials never peak), not from the joint angle. "Up" is onset to peak activation (mostly the lifting part), "down" is peak to relaxed (mostly lowering). Frequency is the median frequency of the EMG; it drops as the muscle fatigues.</Body>

      <Label>Fix this set</Label>
      <Card style={{ padding: 12, gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: t.ink, flex: 1 }}>Reps: <Text style={{ fontWeight: "700" }}>{set.reps}</Text></Text>
          <Button small title="−1" onPress={() => { editSet(set.start, { reps: Math.max(0, set.reps - 1) }, wid); reload(); }} />
          <Button small title="+1" onPress={() => { editSet(set.start, { reps: set.reps + 1 }, wid); reload(); }} />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: t.ink, flex: 1 }}>Weight: <Text style={{ fontWeight: "700" }}>{set.weight ?? "–"} {set.unit}</Text></Text>
          <Button small title={`−${step}`} onPress={() => { editSet(set.start, { weight: Math.max(0, (set.weight ?? 0) - step) }, wid); reload(); }} />
          <Button small title={`+${step}`} onPress={() => { editSet(set.start, { weight: (set.weight ?? 0) + step }, wid); reload(); }} />
        </View>
        <Button title={confirm ? "Tap again: not a real set" : "Delete this set"} variant="danger" onPress={() => {
          if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 3000); return; }
          editSet(set.start, { deleted: true }, wid); router.back();
        }} />
      </Card>
    </ScrollView>
  );
}
