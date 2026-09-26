import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useKeepAwake } from "expo-keep-awake";
import Native from "../../modules/myoblue-native";
import { Body, Button, Card, Label, Title, Toggle } from "../components/ui";
import {
  activeExperiment, deleteExperiment, PROTOCOL, PROTOCOL_PRESET, exportExperiments, FEEL, loadExperiment, markExperiment, nowS, PRESETS, startExperiment, stopExperiment,
  updateExperiment, useExperimentsVersion, videoFile, videoSaved, videoStarted, type ExperimentMeta,
} from "../lib/experiments";
import { useSensors } from "../lib/sensors";
import { useSettings } from "../lib/settings";
import { clock, useTheme } from "../lib/theme";

const QUICK_MARKS = ["start", "hold", "push hard", "relax", "stretch", "rep", "change angle", "stop"];
const SYNC_S = 3;

/**
 * One experiment. New: pick what you'll do, add notes, frame the camera, Start. EMG from every
 * connected sensor and the video start together on the phone's clock; it begins with a sync flex
 * so the two can be lined up exactly later. With ?id= it shows a saved experiment to edit notes.
 */
export default function ExperimentScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return id ? <Saved id={id} /> : <NewExperiment />;
}

function NewExperiment() {
  const t = useTheme();
  useKeepAwake();
  const s = useSettings();
  const sensors = useSensors();
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [useCam, setUseCam] = useState(true);
  const [facing, setFacing] = useState<"front" | "back">("back");
  const [preset, setPreset] = useState(PRESETS[0]);
  const [notes, setNotes] = useState("");
  const [feel, setFeel] = useState<string>("fresh");
  const [running, setRunning] = useState<ExperimentMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [weight, setWeight] = useState(s.weight !== null && s.weight !== undefined ? String(s.weight) : "");
  const [step, setStep] = useState<{ i: number; phase: "go" | "rest"; until: number } | null>(null);
  const [, tick] = useState(0);
  const videoDone = useRef<Promise<void> | null>(null);
  const live = useRef(false);

  useEffect(() => {
    if (!running) return;
    const h = setInterval(() => { tick((x) => x + 1); if (live.current && !activeExperiment()) finish(); }, 200); // stopped from the notification
    return () => clearInterval(h);
  }, [running]);
  // leaving the screen stops the recording (the camera goes away with it)
  useEffect(() => () => { if (live.current) { live.current = false; cam.current?.stopRecording(); stopExperiment(); } }, []);

  const kg = () => { const v = parseFloat(weight.replace(",", ".")); return Number.isFinite(v) ? v : null; };

  /** Guided protocol: step through PROTOCOL with countdowns, marking each start/end automatically. */
  async function runProtocol() {
    const wait = async (ms: number) => { const end = Date.now() + ms; while (live.current && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return live.current; };
    if (!(await wait(SYNC_S * 1000 + 2000))) return;
    for (let i = 0; i < PROTOCOL.length; i++) {
      const p = PROTOCOL[i];
      markExperiment(`${p.preset} start`);
      setStep({ i, phase: "go", until: Date.now() + p.seconds * 1000 });
      if (!(await wait(p.seconds * 1000))) return;
      markExperiment(`${p.preset} end`);
      if (p.rest) { setStep({ i, phase: "rest", until: Date.now() + p.rest * 1000 }); if (!(await wait(p.rest * 1000))) return; }
    }
    setStep(null);
    finish();
  }

  async function start(guided = false) {
    setError(null);
    if (!sensors.length) { setError("Connect the sensors first (Sensors)."); return; }
    const r = startExperiment(guided ? PROTOCOL_PRESET : preset, notes, feel, kg());
    if (typeof r === "string") { setError(r); return; }
    live.current = true;
    setRunning(r);
    markExperiment("sync flex");
    if (useCam && cam.current && ready) {
      videoStarted(facing);
      const p = cam.current.recordAsync();
      videoDone.current = p.then((v) => { if (v?.uri) videoSaved(r.id, v.uri, Native?.now() ?? 0); }).catch((e) => setError(`Video: ${e?.message ?? e}`));
    }
    if (guided) runProtocol();
  }

  async function finish() {
    live.current = false;
    if (videoDone.current) cam.current?.stopRecording();
    const m = stopExperiment() ?? running;
    if (videoDone.current) { await videoDone.current; videoDone.current = null; }
    setRunning(null);
    setStep(null);
    if (m) router.replace({ pathname: "/experiment", params: { id: m.id } });
  }

  const el = running ? nowS() : 0;
  const peak = Math.max(1, ...sensors.map((x) => (x.envNow === x.envNow ? x.envNow : 0)));
  const nameOf = (id: string) => { const p = s.placements.find((q) => q.sensorId === id); return p ? `${p.side} ${p.muscle}` : id; };

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: running ? `Recording ${clock(el)}` : "New experiment" }} />
      {useCam ? (
        perm?.granted ? (
          <View style={{ height: 300, borderRadius: 12, overflow: "hidden", backgroundColor: "#000" }}>
            <CameraView ref={cam} style={{ flex: 1 }} facing={facing} mode="video" mute videoQuality="720p" onCameraReady={() => setReady(true)} />
            {running && el < SYNC_S ? (
              <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.45)" }}>
                <Text style={{ color: "#fff", fontSize: 26, fontWeight: "800", textAlign: "center" }}>Sync: flex hard once, now!</Text>
              </View>
            ) : null}
            {running ? <Text style={{ position: "absolute", top: 8, left: 10, color: "#fff", fontWeight: "800", backgroundColor: "rgba(200,0,0,0.8)", paddingHorizontal: 8, borderRadius: 6 }}>● REC {clock(el)}</Text> : null}
            {!running ? (
              <Pressable onPress={() => setFacing((f) => (f === "back" ? "front" : "back"))} style={{ position: "absolute", right: 10, bottom: 10, backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 }} accessibilityRole="button">
                <Text style={{ color: "#fff", fontWeight: "600" }}>Switch camera</Text>
              </Pressable>
            ) : null}
          </View>
        ) : <Button title="Allow camera" onPress={requestPerm} />
      ) : null}
      {!running ? <Body muted style={{ fontSize: 13 }}>Prop the phone side-on, 2–3 m away at about waist height, with your whole arm (shoulder to hand) in the frame.</Body> : null}

      <Card style={{ padding: 12, gap: 6 }}>
        {sensors.length ? sensors.map((x) => (
          <View key={x.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: t.ink, width: 110 }} numberOfLines={1}>{nameOf(x.id)}</Text>
            <View style={{ flex: 1, height: 10, borderRadius: 999, backgroundColor: t.panel2, overflow: "hidden" }}>
              <View style={{ width: `${Math.min(100, ((x.envNow === x.envNow ? x.envNow : 0) / peak) * 100)}%`, height: "100%", backgroundColor: t.accent }} />
            </View>
            <Text style={{ color: t.muted, width: 64, textAlign: "right", fontVariant: ["tabular-nums"] }}>{x.envNow === x.envNow ? `${x.envNow.toFixed(0)} µV` : "–"}</Text>
          </View>
        )) : <Body muted>No sensors connected.</Body>}
      </Card>

      {running && step ? (() => {
        const p = PROTOCOL[step.i], pr = PRESETS.find((x) => x.id === p.preset)!, left = Math.max(0, Math.ceil((step.until - Date.now()) / 1000));
        const next = PRESETS.find((x) => x.id === PROTOCOL[step.i + 1]?.preset);
        return (
          <Card style={{ padding: 14, gap: 6, borderColor: step.phase === "go" ? t.accent : t.line }}>
            <Text style={{ color: t.muted }}>Step {step.i + 1} of {PROTOCOL.length}{step.phase === "rest" ? " · rest" : ""}</Text>
            <Text style={{ color: t.ink, fontSize: 22, fontWeight: "800" }}>{step.phase === "go" ? pr.title : next ? `Rest. Next: ${next.title}` : "Rest"}</Text>
            <Text style={{ color: t.ink }}>{step.phase === "go" ? pr.text : next?.text ?? ""}</Text>
            <Text style={{ color: t.ink, fontSize: 44, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{left}</Text>
          </Card>
        );
      })() : null}
      {running ? (
        <>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <Text style={{ color: t.ink }}>Weight</Text>
            <TextInput value={weight} onChangeText={setWeight} keyboardType="decimal-pad" onEndEditing={() => markExperiment(`weight ${weight} ${s.unit}`)}
              style={{ width: 90, borderWidth: 1, borderColor: t.line, borderRadius: 10, paddingHorizontal: 10, color: t.ink, backgroundColor: t.panel }} />
            <Text style={{ color: t.muted }}>{s.unit} (changing it adds a mark)</Text>
          </View>
          <Label>Mark what you're doing now</Label>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {QUICK_MARKS.map((m) => <Button key={m} small title={m} onPress={() => markExperiment(m)} />)}
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput value={note} onChangeText={setNote} placeholder="Note at this moment…" placeholderTextColor={t.muted}
              style={{ flex: 1, borderWidth: 1, borderColor: t.line, borderRadius: 10, paddingHorizontal: 10, color: t.ink, backgroundColor: t.panel }} />
            <Button small title="Add" disabled={!note.trim()} onPress={() => { markExperiment(note.trim()); setNote(""); }} />
          </View>
          <MarkList marks={activeExperiment()?.meta.marks ?? []} />
          <Button title="Stop" variant="stop" onPress={finish} />
        </>
      ) : (
        <>
          <Label>What you'll do</Label>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {PRESETS.map((p) => <Chip key={p.id} text={p.title} on={preset.id === p.id} onPress={() => setPreset(p)} />)}
          </View>
          <Body style={{ fontSize: 14 }}>{preset.text}</Body>
          <Label>How the muscle feels</Label>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {FEEL.map((f) => <Chip key={f} text={f} on={feel === f} onPress={() => setFeel(f)} />)}
          </View>
          <TextInput value={notes} onChangeText={setNotes} multiline placeholder="Notes: weight, angle, what you're testing…" placeholderTextColor={t.muted}
            style={{ minHeight: 80, borderWidth: 1, borderColor: t.line, borderRadius: 10, padding: 10, color: t.ink, backgroundColor: t.panel, textAlignVertical: "top" }} />
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <Text style={{ color: t.ink }}>Weight</Text>
            <TextInput value={weight} onChangeText={setWeight} keyboardType="decimal-pad" placeholder="none"
              placeholderTextColor={t.muted} style={{ width: 90, borderWidth: 1, borderColor: t.line, borderRadius: 10, paddingHorizontal: 10, color: t.ink, backgroundColor: t.panel }} />
            <Text style={{ color: t.muted }}>{s.unit}</Text>
          </View>
          <Toggle label="Record video" hint="Saved with the EMG on the same clock (no sound)." value={useCam} onChange={setUseCam} />
          {error ? <Text style={{ color: t.warn }}>{error}</Text> : null}
          <Button title="Start" variant="record" disabled={useCam && perm?.granted === true && !ready} onPress={() => start(false)} />
          <Button title={`Run the guided protocol (${PROTOCOL.length} tests, ~${Math.round(PROTOCOL.reduce((n, p) => n + p.seconds + p.rest, 0) / 60)} min)`} variant="primary"
            disabled={useCam && perm?.granted === true && !ready} onPress={() => start(true)} />
          <Body muted style={{ fontSize: 12 }}>The protocol records everything in one go and marks each step automatically; it tells you what to do next and counts down.</Body>
          <Body muted style={{ fontSize: 12 }}>It starts with a 3-second sync flex: tense hard once so the video and EMG can be lined up exactly.</Body>
        </>
      )}
    </ScrollView>
  );
}

function Saved({ id }: { id: string }) {
  const t = useTheme();
  useExperimentsVersion();
  const m = loadExperiment(id);
  const [notes, setNotes] = useState(m?.notes ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  if (!m) return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  const vid = videoFile(id);
  const c = m.context;
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
      <Stack.Screen options={{ title: m.title }} />
      <Title>{m.title}</Title>
      <Text style={{ color: t.muted }}>{new Date(m.startedAt).toLocaleString()} · {clock(m.durationS ?? 0)} · feels {m.feel}{m.weight !== null ? ` · ${m.weight} ${m.unit}` : ""}</Text>
      <Card style={{ padding: 12, gap: 4 }}>
        <Text style={{ color: t.ink }}>{c.minutesSinceLastWorkout !== null ? `${fmtMin(c.minutesSinceLastWorkout)} after the last workout (${c.lastWorkoutName})` : "No earlier workout"}</Text>
        <Text style={{ color: t.ink }}>{c.minutesSincePrevExperiment !== null ? `${fmtMin(c.minutesSincePrevExperiment)} after the previous experiment · #${c.experimentsToday + 1} today` : "First experiment"}</Text>
        <Text style={{ color: t.muted, fontSize: 13 }}>{m.video ? (vid.exists ? `Video ${(vid.size / 1e6).toFixed(0)} MB, starts ${m.video.offsetS.toFixed(2)} s after the EMG` : "Video wasn't saved") : "No video"}</Text>
      </Card>
      <Label>Notes</Label>
      <TextInput value={notes} onChangeText={setNotes} onEndEditing={() => updateExperiment(id, { notes })} multiline
        style={{ minHeight: 90, borderWidth: 1, borderColor: t.line, borderRadius: 10, padding: 10, color: t.ink, backgroundColor: t.panel, textAlignVertical: "top" }} />
      <Button small title="Save notes" onPress={() => updateExperiment(id, { notes })} />
      <Label>Marks</Label>
      <MarkList marks={m.marks} />
      <Button title={busy ?? "Save to Downloads (for USB)"} variant="primary" disabled={!!busy} onPress={async () => {
        setBusy("Packing…");
        try { const r = await exportExperiments([id], setBusy, "save"); setBusy(null); setSavedMsg(`Saved to ${r}`); }
        catch (e: any) { setBusy(null); setSavedMsg(`Couldn't export: ${e?.message ?? e}. The recording is untouched.`); }
      }} />
      <Button title="Share (zip)" disabled={!!busy} onPress={async () => { setBusy("Packing…"); try { await exportExperiments([id], setBusy); } finally { setBusy(null); } }} />
      {savedMsg ? <Body style={{ fontSize: 13 }}>{savedMsg}</Body> : null}
      <Button title={confirm ? "Tap again to delete" : "Delete"} variant="danger" onPress={() => {
        if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 3000); return; }
        deleteExperiment(id); router.back();
      }} />
    </ScrollView>
  );
}

function MarkList({ marks }: { marks: { t: number; label: string }[] }) {
  const t = useTheme();
  if (!marks.length) return <Body muted style={{ fontSize: 13 }}>No marks.</Body>;
  return (
    <Card style={{ padding: 10, gap: 2 }}>
      {marks.slice().reverse().map((k, i) => <Text key={i} style={{ color: t.ink, fontVariant: ["tabular-nums"] }}><Text style={{ color: t.muted }}>{k.t.toFixed(1).padStart(6)} s  </Text>{k.label}</Text>)}
    </Card>
  );
}

function Chip({ text, on, onPress }: { text: string; on: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={text}
      style={{ borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, minHeight: 34, justifyContent: "center", borderColor: on ? t.accent : t.line, backgroundColor: on ? t.accent + "22" : t.panel }}>
      <Text style={{ color: on ? t.accent : t.ink, fontWeight: "600" }}>{text}</Text>
    </Pressable>
  );
}

const fmtMin = (m: number) => (m < 90 ? `${m} min` : m < 48 * 60 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m / 1440)} days`);
