import React, { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { linfit } from "../core/insights";
import type { TechniqueCard } from "../core/technique";
import { MiniChart } from "../components/MiniChart";
import { Body, Button, Card, Label, Title } from "../components/ui";
import { computeDayInsights, isStale, loadDayInsights, useInsightsState, type DayInsights } from "../lib/insights";
import { analyseExperimentVideo } from "../lib/videoanalysis";
import { useTheme } from "../lib/theme";

const VERDICT = { helpful: "Helpful", neutral: "Neutral", less_effective: "Less effective", unknown: "Unknown" } as const;
const f = (v: number | null | undefined, d = 1) => (v === null || v === undefined || v !== v ? "–" : v.toFixed(d));

/** One gym session (a calendar day of workouts + experiments): effort vs movement and what worked. */
export default function InsightsScreen() {
  const t = useTheme();
  const { day } = useLocalSearchParams<{ day: string }>();
  useInsightsState();
  const [d, setD] = useState<DayInsights | null>(() => loadDayInsights(day));
  const [msg, setMsg] = useState<string | null>(null);
  const run = async () => { setMsg("Working out your session…"); try { setD(await computeDayInsights(day)); setMsg(null); } catch (e: any) { setMsg(`Couldn't compute: ${e?.message ?? e}`); } };
  useEffect(() => { if (isStale(day, d)) run(); }, [day]);
  const analyseVideos = async () => {
    for (const [i, id] of (d?.missingVideo ?? []).entries()) { setMsg(`Analysing video ${i + 1} of ${d!.missingVideo.length}…`); try { await analyseExperimentVideo(id); } catch {} }
    await run();
  };
  if (!d) return (
    <View style={{ flex: 1, backgroundColor: t.bg, padding: 24, gap: 12, justifyContent: "center" }}>
      <Stack.Screen options={{ title: "Insights" }} />
      {msg ? <><ActivityIndicator color={t.accent} /><Body muted style={{ textAlign: "center" }}>{msg}</Body></> : <Body muted>No recordings with EMG on this day.</Body>}
    </View>
  );
  const { ins, cards } = d, m = ins.metrics;
  const reps = ins.reps;
  const kinds = [...new Set(reps.map((r) => shortKind(r.label)))];
  const byKind = (fn: (r: typeof reps[number]) => number | null) => kinds.map((k) => ({ name: k, points: reps.filter((r) => shortKind(r.label) === k).map((r) => [r.tMin, fn(r) ?? NaN] as [number, number]) }));
  const nme = reps.filter((r) => r.nme !== null).map((r) => [r.tMin, r.nme!] as [number, number]);
  const fit = linfit(nme.map((p) => p[0]), nme.map((p) => p[1]));
  const tMax = Math.max(0, ...reps.map((r) => r.tMin));
  const drop = m.dropSets[0];
  const sets = ins.sets.filter((s) => s.n > 0);
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
      <Stack.Screen options={{ title: "Insights" }} />
      <Title>{new Date(ins.startMs).toLocaleDateString()} · {Math.round(ins.durationMin)} min</Title>
      <Body muted style={{ fontSize: 13 }}>{d.recordings.length} recordings as one session · {m.reps} reps ({m.withVideo} timed from video). Effort is in "kg-equivalent", from your own EMG-vs-weight curve fitted on the first fresh reps (no max squeeze needed).</Body>
      {d.missingVideo.length ? <Button small title={`Analyse ${d.missingVideo.length} video${d.missingVideo.length > 1 ? "s" : ""} for better timing`} onPress={analyseVideos} /> : null}
      {msg ? <Body muted>{msg}</Body> : null}

      <Card style={{ padding: 12, gap: 6 }}>
        <Row k="Effort per kg, start → end" v={`${f(m.effortPerKgFirst, 2)} → ${f(m.effortPerKgLast, 2)} (${m.effortPerKgChangePct === null ? "–" : `${m.effortPerKgChangePct > 0 ? "+" : ""}${Math.round(m.effortPerKgChangePct)}%`})`} />
        <Row k="Movement per unit of effort" v={`${f(m.nmeChangePer10Min)}% per 10 min`} />
        <Row k="Muscle fatigue (EMG frequency)" v={`L ${f(m.mdfPer10Min.left)} · R ${f(m.mdfPer10Min.right)} Hz per 10 min`} />
        <Row k="Tempo" v={`${f(m.conS)} s up · ${f(m.eccS)} s down`} />
        <Row k="Lowering EMG vs push" v={`${f(m.eccConRatio, 2)}×`} />
        {drop ? <Row k="Drop set effort per kg" v={`${f(drop.effortPerKg[0], 2)} → ${f(drop.effortPerKg[drop.effortPerKg.length - 1], 2)}`} /> : null}
      </Card>

      <Label>Is what you did working?</Label>
      {cards.map((c) => <Verdict key={c.key} c={c} />)}
      {!cards.length ? <Body muted>Nothing to judge yet.</Body> : null}

      <Label>Charts</Label>
      <Chart title="Effort per kg through the session"><MiniChart series={byKind((r) => r.effortPerKg)} xLabel="min" yLabel="effort ÷ weight" /></Chart>
      <Chart title="Movement per unit of effort"><MiniChart series={[{ name: "reps", points: nme }, ...(fit.slope === fit.slope ? [{ name: "trend", line: true, dashed: true, color: t.muted, points: [[0, fit.icpt], [tMax, fit.icpt + fit.slope * tMax]] as [number, number][] }] : [])]} xLabel="min" /></Chart>
      <Chart title="Push vs lowering time per rep"><MiniChart series={[{ name: "push", points: reps.map((r) => [r.tMin, r.conS] as [number, number]) }, { name: "lowering", points: reps.map((r) => [r.tMin, r.eccS] as [number, number]) }]} xLabel="min" yLabel="s" /></Chart>
      <Chart title="Effort (kg-equivalent) vs the weight"><MiniChart series={[{ name: "reps", points: reps.filter((r) => r.kgEq !== null && r.w > 0).map((r) => [r.w, r.kgEq!] as [number, number]) }, { name: "effort = weight", line: true, dashed: true, color: t.muted, points: [[0, 0], [Math.max(1, ...reps.map((r) => r.w || 0)), Math.max(1, ...reps.map((r) => r.w || 0))]] }]} xLabel="kg" /></Chart>
      {drop ? <Chart title="Drop set: effort stays high as the weight falls"><MiniChart bars={drop.weights.map(String)} series={[{ name: "effort (kg-eq)", points: drop.kgEq.map((v, i) => [i, v]) }, { name: "weight", points: drop.weights.map((v, i) => [i, v]) }]} /></Chart> : null}
      <Chart title="Time under tension per set"><MiniChart bars={sets.map((s) => `${s.w}`)} stacked series={[{ name: "push", points: sets.map((s, i) => [i, s.tutCon]) }, { name: "lowering", points: sets.map((s, i) => [i, s.tutEcc]) }, { name: "hold at lockout", points: sets.map((s, i) => [i, s.tutHold]) }]} /></Chart>
      <Body muted style={{ fontSize: 12 }}>Computed {new Date(d.computedAt).toLocaleString()} from the recordings (they're only read).</Body>
      <Button small title="Recompute" onPress={run} />
    </ScrollView>
  );
}

function shortKind(label: string) {
  const s = label.toLowerCase();
  if (/drop/.test(s)) return "drop set";
  if (/unilateral|one.?arm|one.?hand/.test(s)) return "one-arm";
  if (/hold/.test(s)) return "holds";
  if (/partial/.test(s)) return "partials";
  if (/slow/.test(s)) return "slow";
  return "reps";
}

function Row({ k, v }: { k: string; v: string }) {
  const t = useTheme();
  return <View style={{ flexDirection: "row", gap: 8 }}><Text style={{ color: t.muted, flex: 1 }}>{k}</Text><Text style={{ color: t.ink, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{v}</Text></View>;
}

function Chart({ title, children }: { title: string; children: React.ReactNode }) {
  const t = useTheme();
  return <Card style={{ padding: 12, gap: 6 }}><Text style={{ color: t.ink, fontWeight: "700" }}>{title}</Text>{children}</Card>;
}

function Verdict({ c }: { c: TechniqueCard }) {
  const t = useTheme();
  const color = c.verdict === "helpful" ? t.ok : c.verdict === "less_effective" ? t.warn : t.muted;
  return (
    <Card style={{ padding: 12, gap: 6, borderColor: color }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: t.ink, fontWeight: "700", flex: 1 }}>{c.title}</Text>
        <Text style={{ color, fontWeight: "700" }}>{VERDICT[c.verdict]}</Text>
      </View>
      <Text style={{ color: t.ink, fontSize: 14 }}>{c.yours}</Text>
      <Text style={{ color: t.ink, fontSize: 13 }}>{c.summary}</Text>
      <Text style={{ color: t.muted, fontSize: 11 }}>Evidence: {c.strength} · {c.source}</Text>
    </Card>
  );
}
