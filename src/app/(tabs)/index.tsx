import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { gripsFor } from "../../core/grips";
import type { LoggedSet } from "../../core/log";
import { useTick } from "../../components/plots";
import { SetCard } from "../../components/SetCard";
import { Body, Button, Card, Label, Pill, Title } from "../../components/ui";
import { findExercise, isUnilateral, shortName } from "../../lib/exercises";
import { stackFor, stepStack } from "../../core/stack";
import { defaultMode, setMode } from "../../lib/reps";
import { addDemoSensor, nativeAvailable, useSensors } from "../../lib/sensors";
import { updateSettings, useSettings } from "../../lib/settings";
import { clock, useTheme } from "../../lib/theme";
import { addEvent, endWorkout, isPaused, liveLogFull, refKey, startWorkout, useWorkout, workoutTime } from "../../lib/workout";
import { UpdateBanner } from "../../components/UpdateBanner";

export default function WorkoutScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const s = useSettings();
  const w = useWorkout();
  const sensors = useSensors();
  const active = !!w.active;
  const full = active ? liveLogFull() : { sets: [] as LoggedSet[], ignored: [] };
  const log = full.sets;
  const paused = active && isPaused();
  const ex = s.exercise ? findExercise(s.exercise.id) : undefined;
  const grips = gripsFor(ex?.equipment);
  const uncalibrated = s.placements.filter((p) => !s.refs[refKey(p)] || Date.now() - s.refs[refKey(p)].at > 3 * 3600_000);

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, gap: 12, paddingBottom: 100 }}>
        {!active ? <UpdateBanner /> : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Title style={{ flex: 1 }}>{active ? w.active!.meta.name : "MyoLift"}</Title>
          {active ? (
            <Pressable onPress={() => addEvent({ type: "pause", paused: !paused })} accessibilityRole="button" accessibilityLabel={paused ? "Resume" : "Pause"}
              style={{ paddingHorizontal: 12, minHeight: 32, justifyContent: "center", borderRadius: 999, borderWidth: 1, borderColor: paused ? t.warn : t.line, backgroundColor: paused ? t.warn + "22" : t.panel }}>
              <Text style={{ color: paused ? t.warn : t.ink, fontWeight: "700" }}>{paused ? "▶ Resume" : "❚❚ Pause"}</Text>
            </Pressable>
          ) : null}
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
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {(() => {
              const uni = ex ? s.unilateral[ex.id] ?? isUnilateral(ex) : false;
              const toggle = () => {
                if (!ex || !s.exercise) return;
                updateSettings({ unilateral: { ...s.unilateral, [ex.id]: !uni } });
                addEvent({ type: "exercise", exerciseId: ex.id, name: ex.name, unilateral: !uni, assisted: !!ex.assisted });
              };
              return (
                <Pressable onPress={toggle} accessibilityRole="button" accessibilityLabel={uni ? "One arm at a time" : "Both arms"}
                  style={{ borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, minHeight: 32, justifyContent: "center", borderColor: t.line, backgroundColor: t.panel }}>
                  <Text style={{ color: t.ink, fontWeight: "600" }}>{uni ? "One arm at a time" : "Both arms"} ⇄</Text>
                </Pressable>
              );
            })()}
            {ex ? (() => {
              const mode = s.repProfiles[ex.id]?.params.mode ?? defaultMode(ex.id, ex.name);
              return (
                <Pressable onPress={() => setMode(ex.id, ex.name, mode === "dip" ? "peak" : "dip")} accessibilityRole="button" accessibilityLabel={mode === "dip" ? "Counts lockout dips" : "Counts peaks"}
                  style={{ borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, minHeight: 32, justifyContent: "center", borderColor: t.line, backgroundColor: t.panel }}>
                  <Text style={{ color: t.ink, fontWeight: "600" }}>{mode === "dip" ? "Counts lockout dips" : "Counts peaks"} ⇄</Text>
                </Pressable>
              );
            })() : null}
            {ex?.assisted ? <Text style={{ color: t.muted, fontSize: 13 }}>weight = assistance</Text> : null}
          </View>
          <WeightControl equipment={ex?.equipment ?? null} exerciseId={ex?.id ?? null} />
        </Card>

        {active ? (paused ? (
          <Card style={{ padding: 14, borderColor: t.warn }}><Text style={{ color: t.warn, fontWeight: "700" }}>Paused: nothing counts as a set until you resume.</Text></Card>
        ) : <LiveStatus />) : null}
        {active && full.ignored.length ? (
          <Text style={{ color: t.muted, fontSize: 12 }}>{full.ignored.length} movement{full.ignored.length > 1 ? "s" : ""} not counted ({[...new Set(full.ignored.map((i) => i.reason))].join(", ")})</Text>
        ) : null}

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
      {[...s.placements].sort((a, b) => (a.side === b.side ? 0 : a.side === "left" ? -1 : 1)).map((p) => {
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
            <PlacementBadge status={s.refs[refKey(p)]?.placement?.status} />
          </Card>
        );
      })}
    </View>
  );
}

/** Result of the last placement check for this sensor. */
function PlacementBadge({ status }: { status?: string }) {
  const t = useTheme();
  if (!status) return null;
  const label = { match: "same spot ✓", differs: "placement differs", contact: "poor contact", "no-reference": "reference set" }[status] ?? status;
  const color = status === "match" || status === "no-reference" ? t.ok : t.warn;
  return <Text style={{ color, fontSize: 12, fontWeight: "600" }}>{label}</Text>;
}

function WeightControl({ equipment, exerciseId }: { equipment: string | null; exerciseId: string | null }) {
  const t = useTheme();
  const s = useSettings();
  const set = (v: number) => addEvent({ type: "weight", value: Math.max(0, Math.round(v * 100) / 100), unit: s.unit });
  const w = s.weight ?? 0;
  const stack = stackFor(s.stacks, exerciseId, equipment, s.unit);
  const down = () => set(stack ? stepStack(stack, s.weight, -1) : w - s.weightStep);
  const up = () => set(stack ? stepStack(stack, s.weight, 1) : w + s.weightStep);
  const chips = stack ?? [...new Set([...s.recentWeights])].filter((x) => x !== w).slice(0, 6).sort((a, b) => a - b);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Button title={stack ? "−" : `−${s.weightStep}`} onPress={down} style={{ minWidth: 64 }} />
        <Pressable style={{ flex: 1, alignItems: "center" }} onPress={() => router.push({ pathname: "/weight", params: { exerciseId: exerciseId ?? "", equipment: equipment ?? "" } })} accessibilityRole="button" accessibilityLabel="Enter weight">
          <Text style={{ color: t.ink, fontSize: 30, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{s.weight === null ? "–" : fmtW(w)} <Text style={{ fontSize: 16, color: t.muted }}>{s.unit}</Text></Text>
        </Pressable>
        <Button title={stack ? "+" : `+${s.weightStep}`} onPress={up} style={{ minWidth: 64 }} />
      </View>
      {chips.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {chips.map((r) => {
            const on = s.weight !== null && Math.abs(r - w) < 1e-6;
            return (
              <Pressable key={r} onPress={() => set(r)} accessibilityRole="button" accessibilityLabel={`${fmtW(r)} ${s.unit}`}
                style={{ borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, minHeight: 36, justifyContent: "center", borderColor: on ? t.accent : t.line, backgroundColor: on ? t.accent + "22" : t.panel }}>
                <Text style={{ color: on ? t.accent : t.ink, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{fmtW(r)}</Text>
              </Pressable>
            );
          })}
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
