import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import type { Placement, Side } from "../core/log";
import { SensorCard } from "../components/SensorCard";
import { Body, Button, Card, Choice, Label } from "../components/ui";
import { addDemoSensor, useSensors } from "../lib/sensors";
import { useSettings } from "../lib/settings";
import { useTheme } from "../lib/theme";
import { addEvent } from "../lib/workout";

const MUSCLE_CHOICES = ["triceps", "biceps", "forearms", "shoulders", "chest", "lats", "quadriceps", "hamstrings", "calves", "other"];

export default function SensorsScreen() {
  const t = useTheme();
  const sensors = useSensors();
  const s = useSettings();
  const placementOf = (id: string) => s.placements.find((p) => p.sensorId === id);
  const update = (id: string, name: string, patch: Partial<Placement>) => {
    const base: Placement = placementOf(id) ?? { sensorId: id, sensorName: name, muscle: "triceps", side: guessSide(s.placements.filter((p) => p.sensorId !== id), name) };
    const next = [...s.placements.filter((p) => p.sensorId !== id), { ...base, ...patch }];
    addEvent({ type: "placement", placements: next });
  };
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
      <Body muted>Say where each sensor sits. Moving a sensor (e.g. triceps → biceps) needs a new calibration; the app asks for it.</Body>
      {sensors.map((x) => {
        const p = placementOf(x.id);
        return (
          <Card key={x.id} style={{ padding: 12, gap: 10 }}>
            <Text style={{ color: t.ink, fontWeight: "700" }}>{x.name.replace(/_/g, " ")}</Text>
            <Choice label="Arm / side" value={p?.side ?? ("" as any)} onChange={(v: Side) => update(x.id, x.name, { side: v })}
              options={[{ value: "left", label: "Left" }, { value: "right", label: "Right" }]} />
            <Choice label="Muscle" value={p?.muscle ?? ""} onChange={(v) => update(x.id, x.name, { muscle: v })}
              options={MUSCLE_CHOICES.map((m) => ({ value: m, label: m[0].toUpperCase() + m.slice(1) }))} />
            {!p ? <Button small title="Use this sensor" onPress={() => update(x.id, x.name, {})} /> : (
              <Button small title={s.placementPhotos[`${p.muscle}|${p.side}`] ? "Photo check" : "Take reference photo"}
                onPress={() => router.push({ pathname: "/photo", params: { muscle: p.muscle, side: p.side } })} />
            )}
          </Card>
        );
      })}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button title="+ Connect" variant="primary" style={{ flex: 1 }} onPress={() => router.push("/scan")} />
        <Button title="Demo sensor" style={{ flex: 1 }} onPress={() => addDemoSensor()} />
      </View>
      {s.placements.length ? <Button title="Calibrate these positions" onPress={() => router.push("/calibrate")} /> : null}
      {sensors.length ? <Label>Signal</Label> : null}
      {sensors.map((x) => <SensorCard key={x.id} sensor={x} settings={s} />)}
    </ScrollView>
  );
}

/** Sensor 1 on the left arm, 2 on the right (odd/even), unless that side is already taken. */
function guessSide(existing: Placement[], name: string): Side {
  const n = parseInt(name, 10);
  const preferred: Side = Number.isFinite(n) && n % 2 === 0 ? "right" : "left";
  const other: Side = preferred === "left" ? "right" : "left";
  return existing.some((p) => p.side === preferred) && !existing.some((p) => p.side === other) ? other : preferred;
}
