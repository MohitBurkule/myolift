import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { stackFor, stepStack } from "../core/stack";
import { findExercise } from "../lib/exercises";
import { useSettings } from "../lib/settings";
import { useTheme } from "../lib/theme";
import { Button } from "./ui";

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/** −/+ through the weight stack plus one-tap chips. Each tap is one change (no typing). */
export function WeightChips({ value, onChange, exerciseId }: { value: number | null; onChange: (kg: number) => void; exerciseId?: string | null }) {
  const t = useTheme();
  const s = useSettings();
  const ex = exerciseId ? findExercise(exerciseId) : s.exercise ? findExercise(s.exercise.id) : undefined;
  const stack = stackFor(s.stacks, ex?.id ?? null, ex?.equipment ?? "cable", s.unit) ?? [];
  const step = (dir: 1 | -1) => onChange(stack.length ? stepStack(stack, value, dir) : Math.max(0, (value ?? 0) + dir * s.weightStep));
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Button title="−" onPress={() => step(-1)} style={{ minWidth: 56 }} />
        <Text style={{ flex: 1, textAlign: "center", color: t.ink, fontSize: 26, fontWeight: "800", fontVariant: ["tabular-nums"] }}>
          {value === null ? "–" : fmt(value)} <Text style={{ fontSize: 15, color: t.muted }}>{s.unit}</Text>
        </Text>
        <Button title="+" onPress={() => step(1)} style={{ minWidth: 56 }} />
      </View>
      {stack.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {stack.map((r) => {
            const on = value !== null && Math.abs(r - value) < 1e-6;
            return (
              <Pressable key={r} onPress={() => onChange(r)} accessibilityRole="button" accessibilityLabel={`${fmt(r)} ${s.unit}`}
                style={{ borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, minHeight: 36, justifyContent: "center", borderColor: on ? t.accent : t.line, backgroundColor: on ? t.accent + "22" : t.panel }}>
                <Text style={{ color: on ? t.accent : t.ink, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{fmt(r)}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );
}
