import React, { useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { defaultGrip } from "../core/grips";
import { Body, Button } from "../components/ui";
import { isUnilateral, searchExercises, shortName, type Exercise } from "../lib/exercises";
import { getSettings, updateSettings, useSettings } from "../lib/settings";
import { useTheme } from "../lib/theme";
import { addEvent } from "../lib/workout";

export default function ExerciseScreen() {
  const t = useTheme();
  const s = useSettings();
  const [q, setQ] = useState("");
  const muscles = [...new Set(s.placements.map((p) => p.muscle))];
  const list = useMemo(() => searchExercises(q, muscles), [q, muscles.join(","), s.customExercises.length]);
  const pick = (e: Exercise) => {
    const uni = getSettings().unilateral[e.id] ?? isUnilateral(e);
    addEvent({ type: "exercise", exerciseId: e.id, name: e.name, unilateral: uni, assisted: !!e.assisted });
    const g = defaultGrip(e.name, e.equipment);
    if (g !== getSettings().grip) addEvent({ type: "grip", grip: g });
    router.back();
  };
  const addCustom = () => {
    const name = q.trim();
    if (!name) return;
    const e = { id: "custom:" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, primary: muscles.length ? [muscles[0]] : [], equipment: null };
    updateSettings({ customExercises: [e, ...getSettings().customExercises.filter((x) => x.id !== e.id)] });
    pick({ ...e, secondary: [], mechanic: null, force: null, custom: true });
  };
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={{ padding: 16, gap: 8 }}>
        <TextInput value={q} onChangeText={setQ} placeholder="Search exercises" placeholderTextColor={t.muted} autoFocus
          style={{ color: t.ink, backgroundColor: t.panel, borderColor: t.line, borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 16 }} />
        {q.trim() ? <Button small title={`Add "${q.trim()}" as my own exercise`} onPress={addCustom} /> : null}
        {muscles.length ? <Body muted style={{ fontSize: 13 }}>Recent first, then {muscles.join(" & ")} exercises.</Body> : null}
      </View>
      <FlatList
        data={list}
        keyExtractor={(e) => e.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
        renderItem={({ item: e }) => (
          <Pressable onPress={() => pick(e)} accessibilityRole="button" accessibilityLabel={shortName(e)}
            style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.line }}>
            <Text style={{ color: e.id === s.exercise?.id ? t.accent : t.ink, fontSize: 16, fontWeight: "600" }}>{shortName(e)}</Text>
            <Text style={{ color: t.muted, fontSize: 12 }}>{[e.primary.join(", "), e.equipment, e.custom ? "mine" : null].filter(Boolean).join(" · ")}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}
