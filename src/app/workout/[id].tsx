import React, { useCallback, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { totals, type LoggedSet } from "../../core/log";
import { SetCard } from "../../components/SetCard";
import { Body, Button, Card, Label, Title } from "../../components/ui";
import { shortName } from "../../lib/exercises";
import { clock, useTheme } from "../../lib/theme";
import { analyseWorkout, deleteWorkout, exportRepsCsv, exportSetsCsv, loadWorkout, type WorkoutSummary } from "../../lib/workout";
import * as Sharing from "expo-sharing";

export default function WorkoutDetail() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [w, setW] = useState<WorkoutSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const reload = () => setW(loadWorkout(id));
  useFocusEffect(useCallback(reload, [id]));
  if (!w) return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  const start = new Date(w.meta.startedAt), end = w.meta.endedAt ? new Date(w.meta.endedAt) : null;
  const tot = totals(w.sets);
  // group by exercise (+grip), in order of first appearance
  const groups: { key: string; name: string; sets: { set: LoggedSet; index: number }[] }[] = [];
  w.sets.forEach((s, i) => {
    const key = s.exerciseId + "|" + s.grip;
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push((g = { key, name: shortName({ id: s.exerciseId, name: s.exerciseName }) + (s.grip ? ` · ${s.grip}` : ""), sets: [] }));
    g.sets.push({ set: s, index: i + 1 });
  });
  const share = async (f: { uri: string }, mime: string) => { if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(f.uri, { mimeType: mime }); };
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
      <Stack.Screen options={{ title: w.meta.name }} />
      <Title>{w.meta.name}</Title>
      <Text style={{ color: t.muted }}>{start.toLocaleString()}{end ? ` · ${clock((end.getTime() - start.getTime()) / 1000)}` : " · recording"}</Text>
      <Card style={{ padding: 14, flexDirection: "row", flexWrap: "wrap", rowGap: 10 }}>
        {[["Sets", String(tot.sets)], ["Reps", String(tot.reps)], ["Volume", tot.volume ? `${Math.round(tot.volume)} ${w.meta.unit}` : "–"],
          ["Under tension", clock(tot.tutS)], ["Holds", `${tot.holdS.toFixed(0)} s`], ["EMG effort", `${Math.round(tot.effort / 100)}`]].map(([k, v]) => (
          <View key={k} style={{ width: "33%" }}>
            <Text style={{ color: t.muted, fontSize: 12 }}>{k}</Text>
            <Text style={{ color: t.ink, fontSize: 18, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{v}</Text>
          </View>
        ))}
      </Card>
      {!w.analysed ? <Body muted style={{ fontSize: 13 }}>Showing the live result. The full analysis (with fatigue per rep) runs from the raw recording.</Body> : null}
      {groups.map((g) => (
        <View key={g.key} style={{ gap: 8 }}>
          <Label>{g.name} · {g.sets.length} set{g.sets.length > 1 ? "s" : ""}</Label>
          {g.sets.map(({ set, index }) => <SetCard key={set.id} set={set} index={index} onPress={() => router.push({ pathname: "/set", params: { sid: set.id, wid: id } })} />)}
        </View>
      ))}
      {!w.sets.length ? <Body muted>No sets detected. If you trained, check the sensor positions and calibration, then Re-analyse.</Body> : null}
      <Label>Data</Label>
      <Body muted style={{ fontSize: 13 }}>The raw EMG of the whole workout is kept ({(w.bytes / 1e6).toFixed(1)} MB), so it can be re-analysed later with better detection.</Body>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button title="Sets CSV" onPress={() => share(exportSetsCsv(w), "text/csv")} />
        <Button title="Reps CSV" onPress={() => share(exportRepsCsv(w), "text/csv")} />
        <Button title={busy ?? "Re-analyse"} disabled={!!busy || !end} onPress={async () => { setBusy("Analysing…"); await new Promise((r) => setTimeout(r, 30)); await analyseWorkout(id); setBusy(null); reload(); }} />
      </View>
      {busy ? <ActivityIndicator color={t.accent} /> : null}
      <Button title={confirm ? "Tap again to delete everything" : "Delete workout"} variant="danger" disabled={!end} onPress={() => {
        if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 3000); return; }
        deleteWorkout(id); router.back();
      }} />
    </ScrollView>
  );
}
