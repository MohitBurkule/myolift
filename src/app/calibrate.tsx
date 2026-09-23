import React, { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { useKeepAwake } from "expo-keep-awake";
import { summarize, verdict, VERDICT_LABEL, type Calibration } from "../core/calibration";
import type { Placement } from "../core/log";
import { Body, Button, Card, Title } from "../components/ui";
import { getSensor, getSensors, setDemoHint } from "../lib/sensors";
import { getSettings } from "../lib/settings";
import { useTheme } from "../lib/theme";
import { addEvent } from "../lib/workout";

const HOW: Record<string, string> = {
  triceps: "Straighten your arm(s) hard and tense the triceps, like locking out a pushdown",
  biceps: "Bend your arm(s) to 90° and flex the biceps as hard as you can",
  forearms: "Make a fist and squeeze as hard as you can",
};

type Phase = { kind: "intro" } | { kind: "run"; title: string; text: string; prep: number; left: number } | { kind: "done"; results: [Placement, Calibration | null][] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function CalibrateScreen() {
  const t = useTheme();
  useKeepAwake();
  const placements = getSettings().placements.filter((p) => getSensor(p.sensorId));
  const [phase, setPhase] = useState<Phase>({ kind: "intro" });
  const running = useRef(false);
  useEffect(() => () => { running.current = false; setDemoHint(null); for (const s of getSensors()) s.capture = null; }, []);
  const muscles = [...new Set(placements.map((p) => p.muscle))];
  const squeeze = muscles.map((m) => HOW[m] ?? `Tense the ${m} as hard as you can`).join(". ");

  async function step(title: string, text: string, hint: "rest" | "mvc", secs: number) {
    for (let i = 3; i > 0; i--) { if (!running.current) return null; setPhase({ kind: "run", title, text, prep: i, left: secs }); await sleep(1000); }
    const caps = new Map(placements.map((p) => { const s = getSensor(p.sensorId)!; s.capture = []; return [p.sensorId, s.capture]; }));
    setDemoHint(hint);
    const t0 = Date.now();
    while (running.current && Date.now() - t0 < secs * 1000) { setPhase({ kind: "run", title, text, prep: 0, left: secs - (Date.now() - t0) / 1000 }); await sleep(100); }
    setDemoHint(null);
    for (const p of placements) { const s = getSensor(p.sensorId); if (s) s.capture = null; }
    return running.current ? caps : null;
  }

  async function run() {
    running.current = true;
    const rest = await step("1 of 2 · Relax", "Let the arm(s) hang completely relaxed", "rest", 4);
    if (!rest) return;
    const mvc = await step("2 of 2 · Squeeze", squeeze, "mvc", 4);
    if (!mvc) return;
    running.current = false;
    const results = placements.map((p) => [p, summarize(rest.get(p.sensorId) ?? [], mvc.get(p.sensorId) ?? [], { band: "emg", notch: 50 })] as [Placement, Calibration | null]);
    setPhase({ kind: "done", results });
  }

  function save(results: [Placement, Calibration | null][]) {
    for (const [p, c] of results) {
      if (!c) continue;
      addEvent({ type: "calibration", sensorId: p.sensorId, muscle: p.muscle, side: p.side, ref: { mvcRms: c.mvcRms, restRms: c.restRms, restSd: c.restSd }, snrDb: c.snrDb });
    }
    router.back();
  }

  if (phase.kind === "intro") return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 14 }}>
      <Body>Dry electrodes touch the skin a little differently every time, so the raw signal size changes between sessions. Calibrating makes everything "% of today's max", which is what makes sessions comparable.</Body>
      <Body muted style={{ fontSize: 13 }}>Two steps of 4 seconds for all placed sensors at once: relax, then squeeze as hard as you can. No weight needed. Redo it whenever you move a sensor.</Body>
      <Card style={{ padding: 12, gap: 4 }}>
        {placements.map((p) => <Text key={p.sensorId} style={{ color: t.ink }}>• {p.side} {p.muscle} <Text style={{ color: t.muted }}>({p.sensorName.replace(/_/g, " ")})</Text></Text>)}
        {!placements.length ? <Body muted>No connected sensor has a position yet.</Body> : null}
      </Card>
      <Button title="Start" variant="primary" disabled={!placements.length} onPress={run} />
    </ScrollView>
  );
  if (phase.kind === "run") return (
    <View style={{ flex: 1, backgroundColor: t.bg, padding: 24, justifyContent: "center", gap: 22 }}>
      <Body muted style={{ textAlign: "center" }}>{phase.title}</Body>
      <Title style={{ textAlign: "center", fontSize: 24 }}>{phase.text}</Title>
      <View style={{ height: 12, borderRadius: 999, backgroundColor: t.panel2, overflow: "hidden" }}>
        <View style={{ width: `${phase.prep ? 0 : (1 - phase.left / 4) * 100}%`, height: "100%", backgroundColor: t.accent }} />
      </View>
      <Text style={{ color: t.ink, fontSize: 52, fontWeight: "800", textAlign: "center", fontVariant: ["tabular-nums"] }}>{phase.prep ? `Get ready… ${phase.prep}` : Math.ceil(phase.left)}</Text>
      <Button title="Cancel" onPress={() => { running.current = false; router.back(); }} />
    </View>
  );
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 14 }}>
      <Title>Results</Title>
      <Card>
        {phase.results.map(([p, c]) => {
          const v = c ? verdict(c) : null;
          return (
            <View key={p.sensorId} style={{ padding: 12, borderBottomWidth: 1, borderBottomColor: t.line, gap: 4 }}>
              <View style={{ flexDirection: "row" }}>
                <Text style={{ color: t.ink, fontWeight: "700", flex: 1 }}>{p.side} {p.muscle}</Text>
                {v ? <Text style={{ color: v === "good" ? t.ok : v === "ok" ? t.warn : t.bad, fontWeight: "700" }}>{VERDICT_LABEL[v]}</Text> : null}
              </View>
              <Text style={{ color: c ? t.muted : t.bad, fontVariant: ["tabular-nums"] }}>{c ? `Rest ${c.restRms.toFixed(1)} µV · max ${c.mvcRms.toFixed(0)} µV · ${c.snrDb.toFixed(0)} dB` : "No data received"}</Text>
            </View>
          );
        })}
      </Card>
      <Body muted style={{ fontSize: 13 }}>Below 10 dB usually means poor skin contact: press the sensor on firmly or move it onto the muscle belly and redo.</Body>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button title="Redo" style={{ flex: 1 }} onPress={run} />
        <Button title="Save" variant="primary" style={{ flex: 1 }} disabled={!phase.results.some(([, c]) => c)} onPress={() => save(phase.results)} />
      </View>
    </ScrollView>
  );
}
