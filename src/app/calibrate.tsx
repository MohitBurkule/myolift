import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { useKeepAwake } from "expo-keep-awake";
import { summarize, verdict, VERDICT_LABEL, type Calibration } from "../core/calibration";
import type { Placement } from "../core/log";
import { compare, fingerprint, OFFSET_LABELS, protocol, type Fingerprint, type Step, type StepCapture, type StepId, type Verdict } from "../core/placement";
import { Body, Button, Card, Pill, Title, Toggle } from "../components/ui";
import { getSensor, getSensors, setDemoHint } from "../lib/sensors";
import { getSettings, updateSettings, useSettings } from "../lib/settings";
import { useTheme } from "../lib/theme";
import { addEvent } from "../lib/workout";

type Result = { p: Placement; cal: Calibration | null; fp: Fingerprint | null; v: Verdict | null };
type Phase = { kind: "intro" } | { kind: "run"; step: Step; index: number; total: number; prep: number; left: number } | { kind: "done"; results: Result[] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const posKey = (p: Placement) => `${p.muscle}|${p.side}`;

/**
 * Calibration + placement check. Every step captures envelope and raw EMG from all placed
 * sensors at once. Rest + squeeze give the calibration (% of max); the other movements give
 * the placement fingerprint that is compared with the stored reference for that muscle and side.
 */
export default function CalibrateScreen() {
  const t = useTheme();
  useKeepAwake();
  const s = useSettings();
  const placements = s.placements.filter((p) => getSensor(p.sensorId));
  const muscles = [...new Set(placements.map((p) => p.muscle))];
  // one protocol for everyone when all sensors are on the same muscle; mixed muscles: rest + squeeze only
  const steps = muscles.length === 1 ? protocol(muscles[0], !s.placementCheck) : protocol("", true);
  const [phase, setPhase] = useState<Phase>({ kind: "intro" });
  const running = useRef(false);
  useEffect(() => () => { running.current = false; setDemoHint(null); for (const x of getSensors()) { x.capture = null; x.captureRaw = null; } }, []);

  async function runStep(step: Step, index: number) {
    for (let i = 2; i > 0; i--) { if (!running.current) return null; setPhase({ kind: "run", step, index, total: steps.length, prep: i, left: step.seconds }); await sleep(1000); }
    const caps = new Map<string, StepCapture>();
    for (const p of placements) { const x = getSensor(p.sensorId)!; x.capture = []; x.captureRaw = []; caps.set(p.sensorId, { env: x.capture, raw: x.captureRaw }); }
    setDemoHint(step.id);
    const t0 = Date.now();
    while (running.current && Date.now() - t0 < step.seconds * 1000) { setPhase({ kind: "run", step, index, total: steps.length, prep: 0, left: step.seconds - (Date.now() - t0) / 1000 }); await sleep(100); }
    setDemoHint(null);
    for (const p of placements) { const x = getSensor(p.sensorId); if (x) { x.capture = null; x.captureRaw = null; } }
    return running.current ? caps : null;
  }

  async function run() {
    running.current = true;
    const all: Partial<Record<StepId, Map<string, StepCapture>>> = {};
    for (let i = 0; i < steps.length; i++) {
      const caps = await runStep(steps[i], i);
      if (!caps) return;
      all[steps[i].id] = caps;
    }
    running.current = false;
    const cfg = getSettings();
    const results: Result[] = placements.map((p) => {
      const per: Partial<Record<StepId, StepCapture>> = {};
      for (const id of Object.keys(all) as StepId[]) { const c = all[id]!.get(p.sensorId); if (c) per[id] = c; }
      const cal = summarize(per.rest?.env ?? [], per.mvc?.env ?? [], { band: "emg", notch: 50 });
      const fs = getSensor(p.sensorId)?.rate || 975;
      const fp = cfg.placementCheck ? fingerprint(per, fs > 500 ? fs : 975) : null;
      const saved = cfg.placementRefs[posKey(p)];
      const v = fp ? compare(fp, saved?.ref ?? null, saved?.offsets ?? []) : null;
      return { p, cal, fp, v };
    });
    setPhase({ kind: "done", results });
  }

  function save(results: Result[]) {
    const refs = { ...getSettings().placementRefs };
    for (const r of results) {
      if (!r.cal) continue;
      // first check at a position becomes its reference automatically
      if (r.fp && !refs[posKey(r.p)]) refs[posKey(r.p)] = { ref: r.fp, at: Date.now(), offsets: [] };
      addEvent({
        type: "calibration", sensorId: r.p.sensorId, muscle: r.p.muscle, side: r.p.side,
        ref: { mvcRms: r.cal.mvcRms, restRms: r.cal.restRms, restSd: r.cal.restSd }, snrDb: r.cal.snrDb,
        fingerprint: r.fp ?? undefined, placement: r.v ? { status: r.v.status, similarity: r.v.similarity, messages: r.v.messages } : undefined,
      });
    }
    updateSettings({ placementRefs: refs });
    router.back();
  }

  function setReference(r: Result) {
    if (!r.fp) return;
    const refs = { ...getSettings().placementRefs };
    refs[posKey(r.p)] = { ref: r.fp, at: Date.now(), offsets: refs[posKey(r.p)]?.offsets ?? [] };
    updateSettings({ placementRefs: refs });
    setPhase((ph) => ph.kind === "done" ? { kind: "done", results: ph.results.map((x) => x === r ? { ...x, v: compare(r.fp!, r.fp!, refs[posKey(r.p)].offsets) } : x) } : ph);
  }

  function label(r: Result, text: string) {
    if (!r.fp) return;
    const refs = { ...getSettings().placementRefs };
    const cur = refs[posKey(r.p)];
    if (!cur) return;
    refs[posKey(r.p)] = { ...cur, offsets: [...cur.offsets.filter((o) => o.label !== text), { label: text, fp: r.fp }] };
    updateSettings({ placementRefs: refs });
  }

  if (phase.kind === "intro") return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 14 }}>
      <Button title="Start" variant="primary" disabled={!placements.length} onPress={run} />
      <Body>Calibrating makes everything "% of today's max", so sessions compare even though dry electrodes sit a little differently each time.</Body>
      {s.placementCheck ? (
        <Body>The placement check adds a few movements. Each one works a different muscle or head, so the app can tell whether the sensor is where it was last time: higher, more outer or inner, rotated, or just poorly in contact.</Body>
      ) : null}
      <Card style={{ padding: 12, gap: 6 }}>
        {steps.map((st, i) => <Text key={st.id} style={{ color: t.ink }}>{i + 1}. <Text style={{ fontWeight: "700" }}>{st.title}</Text> <Text style={{ color: t.muted }}>({st.seconds} s): {st.text}</Text></Text>)}
      </Card>
      <Card style={{ padding: 12, gap: 4 }}>
        {placements.map((p) => {
          const hasRef = !!s.placementRefs[posKey(p)];
          return <Text key={p.sensorId} style={{ color: t.ink }}>• {p.side} {p.muscle} <Text style={{ color: t.muted }}>{hasRef ? "· has a reference placement" : "· no reference yet (this one becomes it)"}</Text></Text>;
        })}
        {!placements.length ? <Body muted>No connected sensor has a position yet.</Body> : null}
      </Card>
      <Toggle label="Placement check" hint="Adds the extra movements (about 12 s)." value={s.placementCheck} onChange={(v) => updateSettings({ placementCheck: v })} />
      {muscles.length > 1 ? <Body muted style={{ fontSize: 13 }}>Sensors are on different muscles, so only rest + squeeze run.</Body> : null}
    </ScrollView>
  );

  if (phase.kind === "run") return (
    <View style={{ flex: 1, backgroundColor: t.bg, padding: 24, justifyContent: "center", gap: 22 }}>
      <Body muted style={{ textAlign: "center" }}>{phase.index + 1} of {phase.total} · {phase.step.title}</Body>
      <Title style={{ textAlign: "center", fontSize: 24 }}>{phase.step.text}</Title>
      <View style={{ height: 12, borderRadius: 999, backgroundColor: t.panel2, overflow: "hidden" }}>
        <View style={{ width: `${phase.prep ? 0 : (1 - phase.left / phase.step.seconds) * 100}%`, height: "100%", backgroundColor: t.accent }} />
      </View>
      <Text style={{ color: t.ink, fontSize: 52, fontWeight: "800", textAlign: "center", fontVariant: ["tabular-nums"] }}>{phase.prep ? `Get ready… ${phase.prep}` : Math.ceil(phase.left)}</Text>
      <Button title="Cancel" onPress={() => { running.current = false; router.back(); }} />
    </View>
  );

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>
      <Title>Results</Title>
      {phase.results.map((r) => <ResultCard key={r.p.sensorId} r={r} onReference={() => setReference(r)} onLabel={(l) => label(r, l)} />)}
      <Body muted style={{ fontSize: 13 }}>Below 10 dB usually means poor skin contact: press the sensor on firmly or move it onto the muscle belly and redo.</Body>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button title="Redo" style={{ flex: 1 }} onPress={run} />
        <Button title="Save" variant="primary" style={{ flex: 1 }} disabled={!phase.results.some((r) => r.cal)} onPress={() => save(phase.results)} />
      </View>
    </ScrollView>
  );
}

function ResultCard({ r, onReference, onLabel }: { r: Result; onReference: () => void; onLabel: (l: string) => void }) {
  const t = useTheme();
  const [labelled, setLabelled] = useState<string | null>(null);
  const q = r.cal ? verdict(r.cal) : null;
  const tone = r.v?.status === "match" ? "ok" : r.v?.status === "no-reference" ? "neutral" : "warn";
  const text = { match: "Same spot ✓", differs: "Placement differs", contact: "Poor contact", "no-reference": "New reference" } as const;
  return (
    <Card style={{ padding: 12, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: t.ink, fontWeight: "700", flex: 1 }}>{r.p.side} {r.p.muscle}</Text>
        {q ? <Text style={{ color: q === "good" ? t.ok : q === "ok" ? t.warn : t.bad, fontWeight: "700" }}>{VERDICT_LABEL[q]}</Text> : null}
      </View>
      <Text style={{ color: r.cal ? t.muted : t.bad, fontVariant: ["tabular-nums"] }}>
        {r.cal ? `Rest ${r.cal.restRms.toFixed(1)} µV · max ${r.cal.mvcRms.toFixed(0)} µV · ${r.cal.snrDb.toFixed(0)} dB` : "No data received"}
      </Text>
      {r.v ? (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
            <Pill text={text[r.v.status]} tone={tone} />
            {r.v.similarity !== null ? <Text style={{ color: t.muted, fontSize: 12 }}>{r.v.similarity}% similar to reference</Text> : null}
          </View>
          {r.v.messages.map((m, i) => <Text key={i} style={{ color: t.ink, fontSize: 13 }}>• {m}</Text>)}
          {r.fp ? (
            <Text style={{ color: t.muted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
              push-back {fmtR(r.fp.ratios.push)} · arm-out {fmtR(r.fp.ratios.abduct)}{r.fp.ratios.raise !== undefined ? ` · raise ${fmtR(r.fp.ratios.raise)}` : ""} · {r.fp.mdf.toFixed(0)} Hz · hum {(r.fp.hum * 100).toFixed(0)}%
            </Text>
          ) : null}
          <Button small title="Photo check" onPress={() => router.push({ pathname: "/photo", params: { muscle: r.p.muscle, side: r.p.side } })} />
          {r.v.status !== "no-reference" && r.fp ? (
            <>
              <Button small title="Set this as my reference" onPress={onReference} />
              <Text style={{ color: t.muted, fontSize: 12 }}>Placed it wrong on purpose to teach the app? Say how:</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {OFFSET_LABELS.map((l) => (
                  <Pressable key={l} onPress={() => { onLabel(l); setLabelled(l); }} accessibilityRole="button" accessibilityLabel={`This was ${l}`}
                    style={{ borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, minHeight: 30, justifyContent: "center", borderColor: labelled === l ? t.accent : t.line, backgroundColor: labelled === l ? t.accent + "22" : t.panel }}>
                    <Text style={{ color: labelled === l ? t.accent : t.ink, fontSize: 13 }}>{labelled === l ? `✓ ${l}` : l}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

const fmtR = (v?: number) => (v === undefined ? "–" : `${Math.round(v * 100)}%`);
