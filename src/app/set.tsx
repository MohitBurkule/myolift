import React, { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import type { LoggedSet } from "../core/log";
import { ACT_DT, movingAverage } from "../core/workout";
import { seriesColumns, StaticPlot } from "../components/plots";
import { Body, Button, Card, Label, Pill, Title } from "../components/ui";
import { shortName } from "../lib/exercises";
import { getSettings } from "../lib/settings";
import { clock, useTheme } from "../lib/theme";
import { activeWorkoutId, analyseWorkout, editSet, envelopeOf, liveLog, loadWorkout, redetectLive } from "../lib/workout";
import { defaultMode, learnFromCorrection, paramsFor, setMode } from "../lib/reps";
import { useSettings } from "../lib/settings";

/** One set: activation per arm with reps and holds marked, rep-by-rep numbers, and corrections. */
export default function SetScreen() {
  const t = useTheme();
  const { sid, wid } = useLocalSearchParams<{ sid: string; wid?: string }>();
  const [set, setSet] = useState<LoggedSet | null>(null);
  const [traces, setTraces] = useState<Record<string, Float32Array | null>>({});
  const [confirm, setConfirm] = useState(false);
  const [draft, setDraft] = useState<number | null>(null);
  const [learning, setLearning] = useState<string | null>(null);
  const settings = useSettings();
  const reload = () => {
    const sets = wid ? loadWorkout(wid)?.sets ?? [] : liveLog();
    setSet(sets.find((s) => s.id === sid) ?? null);
  };
  useEffect(reload, [sid, wid]);
  useEffect(() => {
    if (!set) return;
    (async () => {
      const out: Record<string, Float32Array | null> = {};
      for (const side of set.sides) out[side.key] = await envelopeOf(wid ?? null, side.key);
      setTraces(out);
    })();
  }, [set?.id]);
  if (!set) return <View style={{ flex: 1, backgroundColor: t.bg, padding: 24 }}><Body muted>Set not found (it may have been merged or deleted).</Body></View>;

  const step = getSettings().weightStep;
  const liveId = activeWorkoutId();
  const wId = wid ?? liveId ?? "";
  const isLive = !wid || wid === liveId;
  const prof = settings.repProfiles[set.exerciseId];
  const mode = prof?.params.mode ?? defaultMode(set.exerciseId, set.exerciseName);
  const reps = draft ?? set.reps;
  async function reanalyse() {
    if (isLive) redetectLive();
    else if (wid) await analyseWorkout(wid);
    reload();
  }
  async function saveCorrection() {
    if (draft === null) return;
    editSet(set!.start, { reps: draft }, wid);
    setLearning("Learning from your count…");
    await new Promise((r) => setTimeout(r, 30));
    try {
      const p = await learnFromCorrection(set!.exerciseId, set!.exerciseName, wId, isLive, { start: set!.start, end: set!.end }, draft);
      setLearning(`Learned from ${p.labels.length} corrected set${p.labels.length > 1 ? "s" : ""}${p.error ? ` (still off by ${p.error} in total)` : " (all match)"}`);
      await reanalyse();
    } catch (e: any) {
      setLearning(`Saved the count; learning failed: ${e?.message ?? e}`);
    }
    setDraft(null);
  }
  void paramsFor;
  const pad = 1500, a = set.start - pad, b = set.end + pad, span = b - a;
  const refs = getSettings().refs;
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
      <Title>{shortName({ id: set.exerciseId, name: set.exerciseName })}{set.grip ? ` · ${set.grip}` : ""}</Title>
      <Text style={{ color: t.muted, fontVariant: ["tabular-nums"] }}>{clock(set.start / 1000)}–{clock(set.end / 1000)} into the workout · {((set.end - set.start) / 1000).toFixed(0)} s</Text>
      {set.flags.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{set.flags.map((f, i) => <Pill key={i} text={f.text} tone={f.kind === "good" ? "ok" : "warn"} />)}</View> : null}

      {set.sides.map((side) => {
        const env = traces[side.key];
        const ref = Object.entries(refs).find(([k]) => k.startsWith(side.key + "|"))?.[1]?.ref;
        let plot: React.ReactNode = <ActivityIndicator color={t.accent} />;
        if (env === null) plot = <Body muted>No signal saved for this sensor.</Body>;
        else if (env && ref) {
          const k0 = Math.max(0, Math.floor(a / ACT_DT)), k1 = Math.min(env.length, Math.ceil(b / ACT_DT));
          const smooth = movingAverage(env.slice(k0, k1), 10);
          const cols = seriesColumns(smooth, 0, smooth.length, 280, 100 / ref.mvcRms);
          const x = (tm: number) => (tm - a) / span;
          plot = (
            <StaticPlot columns={cols} height={150} color={side.side === "left" ? t.sensors[0] : t.sensors[1]} unit="%"
              ymin={0} ymax={Math.max(cols.hi * 1.1, 20)}
              markers={side.reps.map((r, i) => ({ x: x(r.peakT), label: String(i + 1) }))}
              bands={side.holds.map((h) => [x(h.start), x(h.end)] as [number, number])} />
          );
        }
        return (
          <Card key={side.key} style={{ padding: 12, gap: 8 }}>
            <Text style={{ color: t.ink, fontWeight: "700" }}>{side.side} {side.muscle} · {side.reps.length} reps · {side.peak.toFixed(0)}% avg peak</Text>
            {plot}
            <Text style={{ color: t.muted, fontSize: 12 }}>Numbers mark each detected rep; green bands are holds.</Text>
            <View style={{ gap: 2 }}>
              <Text style={{ color: t.muted, fontSize: 12, fontVariant: ["tabular-nums"] }}>rep   peak   up (s)  down (s)  freq     range</Text>
              {side.reps.map((r, i) => (
                <Text key={i} style={{ color: t.ink, fontSize: 13, fontVariant: ["tabular-nums"] }}>
                  {String(i + 1).padStart(3)}   {r.peak.toFixed(0).padStart(3)}%   {r.riseS.toFixed(1).padStart(5)}   {r.fallS.toFixed(1).padStart(7)}   {(r.mdf ? `${r.mdf.toFixed(0)} Hz` : "–").padEnd(8)} {r.range === "top" ? "top half" : r.range === "bottom" ? "bottom half" : r.range ?? "full"}
                </Text>
              ))}
            </View>
            {side.holds.length ? <Text style={{ color: t.muted, fontSize: 13 }}>Holds: {side.holds.map((h) => `${((h.end - h.start) / 1000).toFixed(1)} s at ${h.level.toFixed(0)}% (${h.position === "top" ? "contracted" : "mid-range"})`).join(" · ")}</Text> : null}
          </Card>
        );
      })}
      <Body muted style={{ fontSize: 12 }}>Range is estimated from activation (a full rep peaks high and relaxes low; top-half partials never relax, bottom-half partials never peak), not from the joint angle. "Up" is onset to peak activation (mostly the lifting part), "down" is peak to relaxed (mostly lowering). Frequency is the median frequency of the EMG; it drops as the muscle fatigues.</Body>

      <Label>Fix this set</Label>
      <Card style={{ padding: 12, gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: t.ink, flex: 1 }}>Full reps: <Text style={{ fontWeight: "700" }}>{reps}</Text>{draft !== null && draft !== set.reps ? <Text style={{ color: t.muted }}> (was {set.reps})</Text> : null}</Text>
          <Button small title="−1" onPress={() => setDraft(Math.max(0, reps - 1))} />
          <Button small title="+1" onPress={() => setDraft(reps + 1)} />
        </View>
        {draft !== null && draft !== set.reps ? <Button title="Save & learn" variant="primary" disabled={!!learning && learning.startsWith("Learning")} onPress={saveCorrection} /> : null}
        {learning ? <Text style={{ color: t.muted, fontSize: 13 }}>{learning}</Text> : null}
        <View style={{ gap: 6 }}>
          <Text style={{ color: t.muted, fontSize: 13 }}>
            {shortName({ id: set.exerciseId, name: set.exerciseName })} counts reps as <Text style={{ color: t.ink, fontWeight: "700" }}>{mode === "dip" ? "lockout dips" : "activation peaks"}</Text>
            {prof?.labels.length ? `, learned from ${prof.labels.length} corrected set${prof.labels.length > 1 ? "s" : ""}.` : " (default settings; correcting a count teaches it)."}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button small title="Peaks" variant={mode === "peak" ? "primary" : "plain"} onPress={async () => { setMode(set.exerciseId, set.exerciseName, "peak"); await reanalyse(); }} />
            <Button small title="Lockout dips" variant={mode === "dip" ? "primary" : "plain"} onPress={async () => { setMode(set.exerciseId, set.exerciseName, "dip"); await reanalyse(); }} />
          </View>
          <Text style={{ color: t.muted, fontSize: 12 }}>Peaks: the muscle works hardest at the top (cable pushdown, curls). Lockout dips: the muscle relaxes when locked out (pushdown machine).</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: t.ink, flex: 1 }}>Weight: <Text style={{ fontWeight: "700" }}>{set.weight ?? "–"} {set.unit}</Text></Text>
          <Button small title={`−${step}`} onPress={() => { editSet(set.start, { weight: Math.max(0, (set.weight ?? 0) - step) }, wid); reload(); }} />
          <Button small title={`+${step}`} onPress={() => { editSet(set.start, { weight: (set.weight ?? 0) + step }, wid); reload(); }} />
        </View>
        <Button title={confirm ? "Tap again: not a real set" : "Delete this set"} variant="danger" onPress={() => {
          if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 3000); return; }
          editSet(set.start, { deleted: true }, wid); router.back();
        }} />
      </Card>
    </ScrollView>
  );
}
