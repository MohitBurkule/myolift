import React, { useCallback, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { totals } from "../../core/log";
import { Body, Card, Pill, Title } from "../../components/ui";
import { shortName } from "../../lib/exercises";
import { clock, useTheme } from "../../lib/theme";
import { listWorkouts, useWorkout, type WorkoutSummary } from "../../lib/workout";

export default function HistoryScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const live = useWorkout();
  const [items, setItems] = useState<WorkoutSummary[]>([]);
  useFocusEffect(useCallback(() => { setItems(listWorkouts()); }, [live.active?.meta.id]));
  return (
    <FlatList
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, gap: 10 }}
      data={items}
      keyExtractor={(w) => w.meta.id}
      ListHeaderComponent={<Title style={{ marginBottom: 4 }}>History</Title>}
      ListEmptyComponent={<Body muted>Finished workouts show up here.</Body>}
      renderItem={({ item: w }) => {
        const tot = totals(w.sets);
        const names = [...new Set(w.sets.map((s) => shortName({ id: s.exerciseId, name: s.exerciseName })))];
        const start = new Date(w.meta.startedAt), end = w.meta.endedAt ? new Date(w.meta.endedAt) : null;
        return (
          <Pressable onPress={() => router.push({ pathname: "/workout/[id]", params: { id: w.meta.id } })}>
            <Card style={{ padding: 14, gap: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ color: t.ink, fontWeight: "700", fontSize: 16, flex: 1 }}>{w.meta.name}</Text>
                {!end ? <Pill text={live.active?.meta.id === w.meta.id ? "In progress" : "Interrupted"} tone="warn" /> : null}
              </View>
              <Text style={{ color: t.muted, fontSize: 13, fontVariant: ["tabular-nums"] }}>
                {start.toLocaleDateString()} {start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{end ? ` · ${clock((end.getTime() - start.getTime()) / 1000)}` : ""} · {tot.sets} sets · {tot.reps} reps{tot.volume ? ` · ${Math.round(tot.volume)} ${w.meta.unit}` : ""}
              </Text>
              {names.length ? <Text style={{ color: t.muted, fontSize: 13 }} numberOfLines={2}>{names.join(", ")}</Text> : null}
            </Card>
          </Pressable>
        );
      }}
    />
  );
}
