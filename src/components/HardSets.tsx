import React, { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import type { LoggedSet } from "../core/log";
import { hardSetsByMuscle, type HardSets } from "../core/setmodel";
import { findExercise } from "../lib/exercises";
import { useTheme } from "../lib/theme";
import { listWorkouts } from "../lib/workout";
import { Card } from "./ui";

/** Muscles a set trains: the exercise's primary muscles, else where the sensors were. */
export function musclesOf(s: LoggedSet): string[] {
  const ex = findExercise(s.exerciseId);
  if (ex?.primary.length) return ex.primary;
  return [...new Set(s.sides.map((x) => x.muscle))];
}

/** Hard sets per muscle over the last 7 days. */
export function weeklyHardSets(days = 7): HardSets[] {
  const since = Date.now() - days * 86400_000;
  const sets = listWorkouts().filter((w) => new Date(w.meta.startedAt).getTime() >= since).flatMap((w) => w.sets);
  return hardSetsByMuscle(sets, musclesOf);
}

export function HardSetsCard() {
  const t = useTheme();
  const [rows, setRows] = useState<HardSets[] | null>(null);
  useFocusEffect(useCallback(() => { try { setRows(weeklyHardSets()); } catch { setRows([]); } }, []));
  if (!rows || !rows.length) return null;
  return (
    <Card style={{ padding: 12, gap: 6 }}>
      <Text style={{ color: t.muted, fontSize: 12, fontWeight: "700", letterSpacing: 0.6 }}>HARD SETS · LAST 7 DAYS</Text>
      {rows.map((r) => (
        <View key={r.muscle} style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Text style={{ color: t.ink, fontWeight: "700", flex: 1 }}>{r.muscle[0].toUpperCase() + r.muscle.slice(1)}</Text>
          <Text style={{ color: t.ink, fontSize: 20, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{fmt(r.hard)}</Text>
          <Text style={{ color: t.muted, fontSize: 12, width: 120, textAlign: "right" }}>{r.sets} set{r.sets > 1 ? "s" : ""}{r.unrated ? ` · ${r.unrated} unrated` : ""}</Text>
        </View>
      ))}
      <Text style={{ color: t.muted, fontSize: 12 }}>A hard set ends within about 4 reps of failure (your rating after the set, else the model's estimate); it's the best-supported measure of growth stimulus. Research suggests roughly 10–20 a week per muscle.</Text>
    </Card>
  );
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
