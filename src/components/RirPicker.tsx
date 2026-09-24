import React from "react";
import { Pressable, Text, View } from "react-native";
import { RIR_CHOICES } from "../core/setmodel";
import { useTheme } from "../lib/theme";

/** "How many more reps could you have done?" one tap: 0 / 1–2 / 3–4 / 5+. */
export function RirPicker({ value, onPick }: { value: number | null | undefined; onPick: (v: number | null) => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      {RIR_CHOICES.map((c) => {
        const on = value === c.value;
        return (
          <Pressable key={c.value} onPress={() => onPick(on ? null : c.value)} accessibilityRole="button" accessibilityLabel={c.label}
            style={{ flex: 1, borderWidth: 1, borderRadius: 10, minHeight: 40, alignItems: "center", justifyContent: "center", borderColor: on ? t.accent : t.line, backgroundColor: on ? t.accent + "22" : t.panel }}>
            <Text style={{ color: on ? t.accent : t.ink, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{c.short}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
