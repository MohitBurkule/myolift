import React, { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { parseStack, stackFor } from "../core/stack";
import { Body, Button, Choice, Label } from "../components/ui";
import { getSettings, updateSettings, useSettings } from "../lib/settings";
import { useTheme } from "../lib/theme";
import { addEvent } from "../lib/workout";

/** Big keypad, the machine's weight stack as chips, and editing that stack. */
export default function WeightScreen() {
  const t = useTheme();
  const s = useSettings();
  const { exerciseId, equipment } = useLocalSearchParams<{ exerciseId?: string; equipment?: string }>();
  const stack = stackFor(s.stacks, exerciseId || null, equipment || null, s.unit);
  const [v, setV] = useState(s.weight !== null ? String(s.weight) : "");
  const [edit, setEdit] = useState(false);
  const [stackText, setStackText] = useState((stack ?? []).join(", "));
  const [stackErr, setStackErr] = useState<string | null>(null);
  const press = (k: string) => setV((x) => (k === "⌫" ? x.slice(0, -1) : k === "." && x.includes(".") ? x : (x + k).replace(/^0(\d)/, "$1")).slice(0, 6));
  const setWeight = (w: number) => { addEvent({ type: "weight", value: w, unit: getSettings().unit }); router.back(); };
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"];
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      {stack ? (
        <>
          <Label>Machine stack</Label>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {stack.map((w) => {
              const on = s.weight !== null && Math.abs(w - s.weight) < 1e-6;
              return (
                <Pressable key={w} onPress={() => setWeight(w)} accessibilityRole="button" accessibilityLabel={`${w} ${s.unit}`}
                  style={{ width: "23%", height: 46, borderRadius: 10, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: on ? t.accent : t.line, backgroundColor: on ? t.accent + "22" : t.panel }}>
                  <Text style={{ color: on ? t.accent : t.ink, fontSize: 16, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{w}</Text>
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}

      <Label>Or type it</Label>
      <Text style={{ color: t.ink, fontSize: 40, fontWeight: "800", textAlign: "center", fontVariant: ["tabular-nums"] }}>{v || "0"} <Text style={{ fontSize: 18, color: t.muted }}>{s.unit}</Text></Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {keys.map((k) => (
          <Pressable key={k} onPress={() => press(k)} accessibilityRole="button" accessibilityLabel={k}
            style={({ pressed }) => ({ width: "31.5%", height: 56, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? t.panel2 : t.panel, borderWidth: 1, borderColor: t.line })}>
            <Text style={{ color: t.ink, fontSize: 24, fontWeight: "700" }}>{k}</Text>
          </Pressable>
        ))}
      </View>
      <Button title="Set weight" variant="primary" disabled={v === "" || isNaN(+v)} onPress={() => setWeight(+v)} />

      <Choice label="Unit" value={s.unit} onChange={(u) => updateSettings({ unit: u })} options={[{ value: "kg", label: "kg" }, { value: "lb", label: "lb" }]} />
      {!stack ? <Choice label="+/− step" value={s.weightStep} onChange={(st) => updateSettings({ weightStep: st })} options={[1, 2, 2.5, 5, 10].map((x) => ({ value: x, label: String(x) }))} /> : null}

      {exerciseId ? (
        edit ? (
          <View style={{ gap: 8 }}>
            <Label>Weights this machine offers</Label>
            <TextInput value={stackText} onChangeText={setStackText} multiline placeholder="1.1, 3.4, 5.7 …  or  2.5-50 step 2.5" placeholderTextColor={t.muted}
              style={{ color: t.ink, backgroundColor: t.panel, borderColor: t.line, borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 15, minHeight: 70 }} />
            {stackErr ? <Body style={{ color: t.bad }}>{stackErr}</Body> : null}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button title="Save stack" variant="primary" style={{ flex: 1 }} onPress={() => {
                const p = parseStack(stackText);
                if (!p) { setStackErr("Use numbers separated by commas, or a range like 2.5-50 step 2.5."); return; }
                updateSettings({ stacks: { ...getSettings().stacks, [exerciseId]: p } }); setEdit(false); setStackErr(null);
              }} />
              <Button title="No stack" style={{ flex: 1 }} onPress={() => { const n = { ...getSettings().stacks }; delete n[exerciseId]; updateSettings({ stacks: { ...n, [exerciseId]: [] } }); setEdit(false); }} />
            </View>
          </View>
        ) : (
          <Button small title={stack ? "Edit this machine's stack" : "Add a weight stack for this exercise"} onPress={() => setEdit(true)} />
        )
      ) : null}
    </ScrollView>
  );
}
