import React, { useCallback, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import * as Sharing from "expo-sharing";
import { calibrationHeadroom, totals, type LoggedSet } from "../../core/log";
import { hardSetsByMuscle } from "../../core/setmodel";
import { musclesOf } from "../../components/HardSets";
import { SetCard } from "../../components/SetCard";
import { Body, Button, Card, Label, Title } from "../../components/ui";
import { shortName } from "../../lib/exercises";
import { exportWorkouts } from "../../lib/exportzip";
import { clock, useTheme } from "../../lib/theme";
import { analyseWorkout, deleteWorkout, exportRepsCsv, exportSetsCsv, loadWorkout, type WorkoutSummary } from "../../lib/workout";

/** One session: one or more recordings started close together (ids comma-separated). */
export default function WorkoutDetail() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const ids = id.split(",").filter(Boolean);
  const [ws, setWs] = useState<WorkoutSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [info, setInfo] = useState(false);
  const reload = () => setWs(ids.map(loadWorkout).filter((w): w is WorkoutSummary => !!w));
  useFocusEffect(useCallback(reload, [id]));
  if (!ws.length) return <View style={{ flex: 1, backgroundColor: t.bg }} />;

  const first = ws[0], last = ws[ws.length - 1];
  const start = new Date(first.meta.startedAt), end = last.meta.endedAt ? new Date(last.meta.endedAt) : null;
  const all = ws.flatMap((w) => w.sets.map((set) => ({ set, wid: w.meta.id })));
  const tot = totals(all.map((x) => x.set));
  const hard = hardSetsByMuscle(all.map((x) => x.set), musclesOf);
  const hardTotal = Math.round(hard.reduce((n, h) => n + h.hard, 0) * 10) / 10;
  const unrated = hard.reduce((n, h) => n + h.unrated, 0);
  const groups: { key: string; name: string; sets: { set: LoggedSet; wid: string; index: number }[] }[] = [];
  all.forEach(({ set, wid }, i) => {
    const key = set.exerciseId + "|" + set.grip;
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push((g = { key, name: shortName({ id: set.exerciseId, name: set.exerciseName }) + (set.grip ? ` · ${set.grip}` : ""), sets: [] }));
    g.sets.push({ set, wid, index: i + 1 });
  });
  const title = groups.length ? groups.slice(0, 3).map((g) => g.name.split(" · ")[0]).join(" · ") : first.meta.name;
  const share = async (f: { uri: string }, mime: string) => { if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(f.uri, { mimeType: mime }); };
  const ended = ws.every((w) => w.meta.endedAt);
  const stat = (k: string, v: string) => (
    <View key={k} style={{ width: "33%" }}>
      <Text style={{ color: t.muted, fontSize: 12 }}>{k}</Text>
      <Text style={{ color: t.ink, fontSize: 18, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{v}</Text>
    </View>
  );
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
      <Stack.Screen options={{ title }} />
      <Title>{title}</Title>
      <Text style={{ color: t.muted }}>{start.toLocaleString()}{end ? ` · ${clock((end.getTime() - start.getTime()) / 1000)}` : " · recording"}{ws.length > 1 ? ` · ${ws.length} recordings` : ""}</Text>
      <Card style={{ padding: 14, flexDirection: "row", flexWrap: "wrap", rowGap: 10 }}>
        {stat("Sets", String(tot.sets))}
        {stat("Reps", String(tot.reps))}
        {stat("Weight × reps", tot.volume ? `${Math.round(tot.volume)} ${first.meta.unit}` : "–")}
        {stat("Hard sets", hardTotal || unrated ? `${hardTotal}${unrated ? ` (+${unrated}?)` : ""}` : "–")}
        {stat("Under tension", clock(tot.tutS))}
        {stat("Holds", `${tot.holdS.toFixed(0)} s`)}
      </Card>
      <Button small title={info ? "Hide: what counts as a hard set?" : "What counts as a hard set?"} onPress={() => setInfo(!info)} />
      {info ? (
        <Card style={{ padding: 12, gap: 6 }}>
          <Body style={{ fontSize: 13 }}>A hard set ends within about 4 reps of failure. Hard sets per muscle per week are the best-supported measure of growth stimulus (roughly 10–20 a week). Sets 0–1 reps from failure count 1, 2–3 count 0.8, about 4 count 0.5, easier sets 0.</Body>
          <Body style={{ fontSize: 13 }}>Reps left comes from your rating after each set; without one, the muscle model estimates it (the number in brackets is unrated sets). Rate a few sets to make the model's estimate yours.</Body>
          <Body muted style={{ fontSize: 12 }}>Weight × reps and the EMG effort curve are still shown per set, but neither is a measure of growth: EMG rises with fatigue and is lower when lowering the weight, even though that part loads the muscle.</Body>
        </Card>
      ) : null}
      {(() => {
        const over = calibrationHeadroom(all.map((x) => x.set));
        return over.length ? (
          <Card style={{ padding: 12, gap: 4, borderColor: t.warn }}>
            <Text style={{ color: t.warn, fontWeight: "700" }}>Calibration squeeze was weaker than your sets</Text>
            <Body style={{ fontSize: 13 }}>{over.map((o) => `${o.side} ${o.muscle} reached ${Math.round(o.peak)}%`).join(", ")} of the calibrated maximum, so the percentages are inflated. Next time squeeze against the machine: push the rope down hard against a heavy weight and hold at lockout.</Body>
          </Card>
        ) : null;
      })()}
      {ws.some((w) => !w.analysed) ? <Body muted style={{ fontSize: 13 }}>Showing the live result. The full analysis (with fatigue per rep) runs from the raw recording.</Body> : null}
      {groups.map((g) => (
        <View key={g.key} style={{ gap: 8 }}>
          <Label>{g.name} · {g.sets.length} set{g.sets.length > 1 ? "s" : ""}</Label>
          {g.sets.map(({ set, wid, index }) => <SetCard key={wid + set.id} set={set} index={index} onPress={() => router.push({ pathname: "/set", params: { sid: set.id, wid } })} />)}
        </View>
      ))}
      {!all.length ? <Body muted>No sets detected. If you trained, check the sensor positions and calibration, then Re-analyse.</Body> : null}

      <Label>Data</Label>
      <Body muted style={{ fontSize: 13 }}>The raw EMG is kept ({(ws.reduce((n, w) => n + w.bytes, 0) / 1e6).toFixed(1)} MB), so it can be re-analysed later with better detection.</Body>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button title="Raw data (zip)" variant="primary" disabled={!!busy} onPress={async () => { setBusy("Packing…"); try { await exportWorkouts(ids, (m) => setBusy(m)); } finally { setBusy(null); } }} />
        {ws.length === 1 ? <Button title="Sets CSV" onPress={() => share(exportSetsCsv(first), "text/csv")} /> : null}
        {ws.length === 1 ? <Button title="Reps CSV" onPress={() => share(exportRepsCsv(first), "text/csv")} /> : null}
        <Button title={busy ?? "Re-analyse"} disabled={!!busy || !ended} onPress={async () => {
          setBusy("Analysing…"); await new Promise((r) => setTimeout(r, 30));
          for (const w of ws) await analyseWorkout(w.meta.id);
          setBusy(null); reload();
        }} />
      </View>
      {busy ? <ActivityIndicator color={t.accent} /> : null}
      <Button title={confirm ? "Tap again to delete everything" : ws.length > 1 ? "Delete these recordings" : "Delete workout"} variant="danger" disabled={!ended} onPress={() => {
        if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 3000); return; }
        for (const w of ws) deleteWorkout(w.meta.id);
        router.back();
      }} />
    </ScrollView>
  );
}
