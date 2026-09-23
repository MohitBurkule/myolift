import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { gripsFor } from "../../core/grips";
import type { LoggedSet } from "../../core/log";
import { useTick } from "../../components/plots";
import { SetCard } from "../../components/SetCard";
import { Body, Button, Card, Label, Pill, Title } from "../../components/ui";
import { findExercise, shortName } from "../../lib/exercises";
import { addDemoSensor, nativeAvailable, useSensors } from "../../lib/sensors";
import { useSettings } from "../../lib/settings";
import { clock, useTheme } from "../../lib/theme";
import { addEvent, endWorkout, liveLog, refKey, startWorkout, useWorkout, workoutTime } from "../../lib/workout";

export default function WorkoutScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const s = useSettings();
  const w = useWorkout();
  const sensors = useSensors();
  const active = !!w.active;
  const log: LoggedSet[] = active ? liveLog() : [];
  const ex = s.exercise ? findExercise(s.exercise.id) : undefined;
  const grips = gripsFor(ex?.equipment);
  const uncalibrated = s.placements.filter((p) => !s.refs[refKey(p)] || Date.now() - s.refs[refKey(p)].at > 3 * 3600_000);

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, gap: 12, paddingBottom: 100 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Title style={{ flex: 1 }}>{active ? w.active!.meta.name : "MyoLift"}</Title>
          {active ? <Timer /> : null}
        </View>

        <SensorStrip />

        {!sensors.length ? (
          <Card style={{ padding: 16, gap: 10 }}>
            <Title style={{ fontSize: 17 }}>Put the sensors on</Title>
            <Body>Switch both sensors on (light blinking), then tap Sensors to connect them and say where each one sits: triceps, left or right arm.</Body>
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              <Button title="Sensors" variant="primary" onPress={() => router.push("/sensors")} />
              <Button title="Try demo sensors" onPress={() => { addDemoSensor(); addDemoSensor(); router.push("/sensors"); }} />
            </View>
          </Card>
        ) : s.placements.length === 0 ? (
          <Card style={{ padding: 14, gap: 8 }}>
            <Body>Tell the app where each sensor is.</Body>
            <Button title="Set sensor positions" variant="primary" onPress={() => router.push("/sensors")} />
          </Card>
        ) : uncalibrated.length ? (
          <Card style={{ padding: 14, gap: 8 }}>
            <Body>Calibrate once each time you put the sensors on (dry electrodes sit differently every time): 3 s relaxed, then 3 s squeezing hard.</Body>
            <Button title="Calibrate now" variant="primary" onPress={() => router.push("/calibrate")} />
          </Card>
        ) : null}

        {/* current exercise, grip and weight: sticky, apply to the next sets */}
        <Card style={{ padding: 14, gap: 12 }}>
          <Pressable onPress={() => router.push("/exercise")} accessibilityRole="button" accessibilityLabel="Change exercise">
            <Label>Exercise</Label>
            <Text style={{ color: t.ink, fontSize: 20, fontWeight: "700" }} numberOfLines={1}>{s.exercise ? shortName(s.exercise) : "Pick an exercise"} ›</Text>
          </Pressable>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {grips.map((g) => {
              const on = g === s.grip;
              return (
                <Pressable key={g} onPress={() => addEvent({ type: "grip", grip: on ? "" : g })} accessibilityRole="button" accessibilityLabel={g}
                  style={{ borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, minHeight: 34, justifyContent: "center", borderColor: on ? t.accent : t.line, backgroundColor: on ? t.accent + "22" : t.panel }}>
                  <Text style={{ color: on ? t.accent : t.ink, fontWeight: "600" }}>{g}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <WeightControl />
        </Card>

        {active ? <LiveStatus /> : null}

        {active && log.length ? <Label>Sets · newest first</Label> : null}
        {active ? [...log].reverse().map((set, i) => (
          <SetCard key={set.id} set={set} index={log.length - i} onPress={() => router.push({ pathname: "/set", params: { sid: set.id } })} />
        )) : null}
        {!active && sensors.length ? (
          <Body muted style={{ fontSize: 13 }}>Start once when you begin training. Sets, reps, rest and holds are detected from the EMG; just keep the exercise and weight up to date.</Body>
        ) : null}
      </ScrollView>

      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: 12, paddingHorizontal: 16, backgroundColor: t.bg, borderTopWidth: 1, borderTopColor: t.line, flexDirection: "row", gap: 8 }}>
        <Button title="Sensors" style={{ flex: 1 }} onPress={() => router.push("/sensors")} />
        <Button title="Calibrate" style={{ flex: 1 }} disabled={!s.placements.length} onPress={() => router.push("/calibrate")} />
        {active ? (
          <Button title="End" variant="stop" style={{ flex: 1 }} onPress={async () => { const id = await endWorkout(); if (id) router.push({ pathname: "/workout/[id]", params: { id } }); }} />
        ) : (
          <Button title="▶ Start" variant="primary" style={{ flex: 1.3 }} disabled={!nativeAvailable || !sensors.length} onPress={() => startWorkout()} />
        )}
      </View>
    </View>
  );
}

function Timer() {
  const t = useTheme();
  useTick(1000);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: t.rec + "22" }}>
      <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: t.rec }} />
      <Text style={{ color: t.rec, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{clock(workoutTime() / 1000)}</Text>
    </View>
  );
}

/** Each placed sensor: position, live activation (% of calibrated max), connection. */
function SensorStrip() {
  const t = useTheme();
  const s = useSettings();
  const sensors = useSensors();
  useTick(250);
  if (!s.placements.length) return null;
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      {s.placements.map((p) => {
        const live = sensors.find((x) => x.id === p.sensorId);
        const ref = s.refs[refKey(p)]?.ref;
        const pct = live && ref && live.envNow === live.envNow ? (live.envNow / ref.mvcRms) * 100 : null;
        const ok = live && (live.state === "live" || live.state === "demo");
        return (
          <Card key={p.sensorId} style={{ flex: 1, padding: 10, gap: 6 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{ color: t.ink, fontWeight: "700", flex: 1 }} numberOfLines={1}>{p.side === "left" ? "L" : "R"} {p.muscle}</Text>
              <Pill text={ok ? "live" : live?.state ?? "off"} tone={ok ? "ok" : "warn"} />
            </View>
            <View style={{ height: 8, borderRadius: 999, backgroundColor: t.panel2, overflow: "hidden" }}>
              <View style={{ width: `${Math.min(100, pct ?? 0)}%`, height: "100%", backgroundColor: p.side === "left" ? t.sensors[0] : t.sensors[1] }} />
            </View>
            <Text style={{ color: t.muted, fontSize: 12, fontVariant: ["tabular-nums"] }}>{pct === null ? (ref ? "–" : "not calibrated") : `${pct.toFixed(0)}% of max`}</Text>
          </Card>
        );
      })}
    </View>
  );
}

function WeightControl() {
  const t = useTheme();
  const s = useSettings();
  const set = (v: number) => addEvent({ type: "weight", value: Math.max(0, Math.round(v * 100) / 100), unit: s.unit });
  const w = s.weight ?? 0;
  const recent = [...new Set([...s.recentWeights])].filter((x) => x !== w).slice(0, 6).sort((a, b) => a - b);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Button title={`−${s.weightStep}`} onPress={() => set(w - s.weightStep)} style={{ minWidth: 64 }} />
        <Pressable style={{ flex: 1, alignItems: "center" }} onPress={() => router.push("/weight")} accessibilityRole="button" accessibilityLabel="Enter weight">
          <Text style={{ color: t.ink, fontSize: 30, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{s.weight === null ? "–" : fmtW(w)} <Text style={{ fontSize: 16, color: t.muted }}>{s.unit}</Text></Text>
        </Pressable>
        <Button title={`+${s.weightStep}`} onPress={() => set(w + s.weightStep)} style={{ minWidth: 64 }} />
      </View>
      {recent.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {recent.map((r) => <Button key={r} small title={`${fmtW(r)}`} onPress={() => set(r)} />)}
        </ScrollView>
      ) : null}
    </View>
  );
}

export const fmtW = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(v * 10 === Math.round(v * 10) ? 1 : 2));

function LiveStatus() {
  const t = useTheme();
  const w = useWorkout();
  useTick(1000);
  if (w.live) {
    const l = w.live;
    const tut = (l.end - l.start) / 1000;
    const peak = l.sides.length ? Math.max(...l.sides.map((x) => x.peak)) : 0;
    const holds = l.sides.reduce((n, x) => n + x.holds.length, 0);
    return (
      <Card style={{ padding: 14, gap: 6, borderColor: t.accent }}>
        <Text style={{ color: t.accent, fontWeight: "800", letterSpacing: 0.5 }}>SET IN PROGRESS</Text>
        <Text style={{ color: t.ink, fontSize: 34, fontWeight: "800", fontVariant: ["tabular-nums"] }}>
          {l.reps} <Text style={{ fontSize: 16, color: t.muted }}>reps{l.sides.length > 1 ? `  (L ${l.sides.find((x) => x.side === "left")?.reps.length ?? 0} · R ${l.sides.find((x) => x.side === "right")?.reps.length ?? 0})` : ""}</Text>
        </Text>
        <Text style={{ color: t.muted, fontVariant: ["tabular-nums"] }}>{peak.toFixed(0)}% activation · {tut.toFixed(0)} s under tension{holds ? ` · ${holds} hold${holds > 1 ? "s" : ""}` : ""}</Text>
      </Card>
    );
  }
  return (
    <Card style={{ padding: 14, flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Text style={{ color: t.muted, fontWeight: "700", flex: 1 }}>{w.restMs === null ? "Waiting for the first set…" : "Resting"}</Text>
      {w.restMs !== null ? <Text style={{ color: t.ink, fontSize: 24, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{clock(w.restMs / 1000)}</Text> : null}
    </Card>
  );
}
