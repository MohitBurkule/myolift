import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { Button, Choice } from "../components/ui";
import { getSettings, updateSettings, useSettings } from "../lib/settings";
import { useTheme } from "../lib/theme";
import { addEvent } from "../lib/workout";

/** Big keypad: type the weight, tap Set. */
export default function WeightScreen() {
  const t = useTheme();
  const s = useSettings();
  const [v, setV] = useState(s.weight !== null ? String(s.weight) : "");
  const press = (k: string) => setV((x) => (k === "⌫" ? x.slice(0, -1) : k === "." && x.includes(".") ? x : (x + k).replace(/^0(\d)/, "$1")).slice(0, 6));
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"];
  return (
    <View style={{ flex: 1, backgroundColor: t.bg, padding: 16, gap: 14 }}>
      <Text style={{ color: t.ink, fontSize: 48, fontWeight: "800", textAlign: "center", fontVariant: ["tabular-nums"] }}>{v || "0"} <Text style={{ fontSize: 20, color: t.muted }}>{s.unit}</Text></Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {keys.map((k) => (
          <Pressable key={k} onPress={() => press(k)} accessibilityRole="button" accessibilityLabel={k}
            style={({ pressed }) => ({ width: "31.5%", height: 64, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? t.panel2 : t.panel, borderWidth: 1, borderColor: t.line })}>
            <Text style={{ color: t.ink, fontSize: 26, fontWeight: "700" }}>{k}</Text>
          </Pressable>
        ))}
      </View>
      <Choice label="Unit" value={s.unit} onChange={(u) => updateSettings({ unit: u })} options={[{ value: "kg", label: "kg" }, { value: "lb", label: "lb" }]} />
      <Choice label="+/− step" value={s.weightStep} onChange={(st) => updateSettings({ weightStep: st })}
        options={[1, 2, 2.5, 5, 10].map((x) => ({ value: x, label: String(x) }))} />
      <Button title="Set weight" variant="primary" disabled={v === "" || isNaN(+v)} onPress={() => { addEvent({ type: "weight", value: +v, unit: getSettings().unit }); router.back(); }} />
    </View>
  );
}
