import React, { useCallback, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { totals } from "../../core/log";
import { Body, Button, Card, Pill, Title } from "../../components/ui";
import { shortName } from "../../lib/exercises";
import { exportAll } from "../../lib/exportzip";
import { clock, useTheme } from "../../lib/theme";
import { groupSessions, listWorkouts, useWorkout, type WorkoutSummary } from "../../lib/workout";

export default function HistoryScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const live = useWorkout();
  const [groups, setGroups] = useState<WorkoutSummary[][]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useFocusEffect(useCallback(() => { setGroups(groupSessions(listWorkouts())); }, [live.active?.meta.id]));
  return (
    <FlatList
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, gap: 10, paddingBottom: 40 }}
      data={groups}
      keyExtractor={(g) => g.map((w) => w.meta.id).join(",")}
      ListHeaderComponent={
        <View style={{ gap: 8, marginBottom: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Title style={{ flex: 1 }}>History</Title>
            <Button small title={busy ?? "Export all data"} disabled={!!busy || !groups.length} onPress={async () => {
              setBusy("Packing…");
              try { await exportAll((m) => setBusy(m)); } finally { setBusy(null); }
            }} />
          </View>
          <Body muted style={{ fontSize: 12 }}>Workouts started within 20 minutes of each other are shown as one session.</Body>
        </View>
      }
      ListEmptyComponent={<Body muted>Finished workouts show up here.</Body>}
      renderItem={({ item: g }) => {
        const sets = g.flatMap((w) => w.sets);
        const tot = totals(sets);
        const names = [...new Set(sets.map((s) => shortName({ id: s.exerciseId, name: s.exerciseName })))];
        const first = g[0], last = g[g.length - 1];
        const start = new Date(first.meta.startedAt), end = last.meta.endedAt ? new Date(last.meta.endedAt) : null;
        const inProgress = g.some((w) => live.active?.meta.id === w.meta.id);
        return (
          <Pressable onPress={() => router.push({ pathname: "/workout/[id]", params: { id: g.map((w) => w.meta.id).join(",") } })}>
            <Card style={{ padding: 14, gap: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ color: t.ink, fontWeight: "700", fontSize: 16, flex: 1 }} numberOfLines={1}>{names.length ? names.slice(0, 3).join(" · ") : first.meta.name}</Text>
                {inProgress ? <Pill text="In progress" tone="warn" /> : !end ? <Pill text="Interrupted" tone="warn" /> : null}
              </View>
              <Text style={{ color: t.muted, fontSize: 13, fontVariant: ["tabular-nums"] }}>
                {start.toLocaleDateString()} {start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{end ? ` · ${clock((end.getTime() - start.getTime()) / 1000)}` : ""} · {tot.sets} sets · {tot.reps} reps{tot.volume ? ` · ${Math.round(tot.volume)} ${first.meta.unit}` : ""}{tot.emgLoad ? ` · EMG load ${Math.round(tot.emgLoad)}` : ""}
              </Text>
              {g.length > 1 ? <Text style={{ color: t.muted, fontSize: 12 }}>{g.length} recordings combined</Text> : null}
            </Card>
          </Pressable>
        );
      }}
    />
  );
}
