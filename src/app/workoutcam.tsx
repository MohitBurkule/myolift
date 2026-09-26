import React, { useEffect, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { router, Stack } from "expo-router";
import { File } from "expo-file-system";
import { useKeepAwake } from "expo-keep-awake";
import { SyncedCamera, type SyncedCameraHandle } from "../components/SyncedCamera";
import { Body, Button, Label, Toggle } from "../components/ui";
import { updateSettings, useSettings } from "../lib/settings";
import { clock, useTheme } from "../lib/theme";
import { activeWorkoutClock, addEvent, useWorkout } from "../lib/workout";
import { analyseWorkoutVideo, useVideoAnalysis } from "../lib/videoanalysis";
import { motionModeFor } from "../core/videomotion";

const QUICK = ["start set", "drop weight", "half reps", "hold", "one arm", "failure", "rest"];

/**
 * Camera during a normal workout: video (with sound for voice notes) saved in the workout folder,
 * on the workout's clock, with a sync flex at the start. Marks go into the workout's events.
 */
export default function WorkoutCamera() {
  const t = useTheme();
  useKeepAwake();
  const s = useSettings();
  const w = useWorkout();
  const last = s.lastExperiment;
  const cam = useRef<SyncedCameraHandle>(null);
  const [facing, setFacing] = useState<"front" | "back">(last?.facing ?? "back");
  const [audio, setAudio] = useState(last?.audio ?? true);
  const [rec, setRec] = useState<{ t0: number; file: string; done: Promise<string | null> } | null>(null);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const vbusy = useVideoAnalysis();
  const [, tick] = useState(0);
  const recRef = useRef(rec);
  recRef.current = rec;

  useEffect(() => { if (!rec) return; const h = setInterval(() => tick((x) => x + 1), 250); return () => clearInterval(h); }, [rec]);
  useEffect(() => () => { if (recRef.current) cam.current?.stop(); }, []);
  // the workout ended elsewhere: stop the video too
  useEffect(() => { if (!w.active && recRef.current) stop(); }, [w.active]);

  const ck = activeWorkoutClock();
  if (!ck) return (
    <View style={{ flex: 1, backgroundColor: t.bg, padding: 16, gap: 12 }}>
      <Body>Start a workout first; the video is saved with it.</Body>
      <Button title="Back" onPress={() => router.back()} />
    </View>
  );

  function start() {
    setMsg(null);
    const c = activeWorkoutClock();
    if (!c) return;
    if (!cam.current?.ready()) { setMsg("The camera isn't ready yet."); return; }
    updateSettings({ lastExperiment: { ...(s.lastExperiment ?? { useCam: true, weight: null, preset: "free" }), facing, audio } });
    const r = cam.current.record();
    if (!r) return;
    const t0 = c.nowMs();
    const n = w.active?.events.filter((e) => e.type === "video").length ?? 0;
    const file = `video_${n + 1}.mp4`;
    addEvent({ type: "video", file, audio, facing });
    addEvent({ type: "note", text: "sync flex" });
    setRec({ t0, file, done: r.done });
  }

  async function stop() {
    const r = recRef.current;
    if (!r) return;
    cam.current?.stop();
    setRec(null);
    const uri = await r.done;
    const c = activeWorkoutClock();
    const dir = c?.dir;
    if (uri && dir) {
      try { new File(uri).move(new File(dir, r.file)); } catch { try { new File(uri).copy(new File(dir, r.file)); } catch {} }
      setMsg(`Saved ${r.file} with this workout.`);
    } else if (!uri) setMsg("The video wasn't saved.");
    addEvent({ type: "note", text: `video stopped (${r.file})` });
    // count reps from the video (only reads it); shown on the set screen
    const mode = motionModeFor(s.exercise?.id, s.exercise?.name);
    if (uri && c && mode) {
      analyseWorkoutVideo(c.id, r.file, r.t0 / 1000, mode)
        .then((v) => v && setMsg(`Saved ${r.file}. Video reps: ${v.reps.length} (${v.full} full + ${v.partial} partial).`))
        .catch((e) => setMsg(`Saved ${r.file}. Couldn't count reps from it: ${e?.message ?? e}`));
    }
  }

  const el = rec ? (ck.nowMs() - rec.t0) / 1000 : 0;
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: rec ? `Recording ${clock(el)}` : "Workout camera" }} />
      <SyncedCamera ref={cam} facing={facing} onFacing={setFacing} audio={audio} locked={!!rec} height={380} overlay={<>
        {rec && el < 3 ? (
          <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.45)" }}>
            <Text style={{ color: "#fff", fontSize: 26, fontWeight: "800", textAlign: "center" }}>Sync: flex hard once, now!</Text>
          </View>
        ) : null}
        {rec ? <Text style={{ position: "absolute", top: 8, left: 10, color: "#fff", fontWeight: "800", backgroundColor: "rgba(200,0,0,0.8)", paddingHorizontal: 8, borderRadius: 6 }}>● REC {clock(el)}</Text> : null}
      </>} />
      {!rec ? <Toggle label="Record sound (voice notes)" hint="Say what you're doing; it gets transcribed with timestamps later." value={audio} onChange={setAudio} /> : null}
      {rec ? (
        <>
          <Label>Mark</Label>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {QUICK.map((m) => <Button key={m} small title={m} onPress={() => addEvent({ type: "note", text: m })} />)}
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput value={note} onChangeText={setNote} placeholder="Note at this moment…" placeholderTextColor={t.muted}
              style={{ flex: 1, borderWidth: 1, borderColor: t.line, borderRadius: 10, paddingHorizontal: 10, color: t.ink, backgroundColor: t.panel }} />
            <Button small title="Add" disabled={!note.trim()} onPress={() => { addEvent({ type: "note", text: note.trim() }); setNote(""); }} />
          </View>
          <Button title="Stop video" variant="stop" onPress={stop} />
        </>
      ) : <Button title="Start video" variant="record" onPress={start} />}
      {vbusy?.key.startsWith("wk:") ? <Body style={{ fontSize: 13 }}>{vbusy.stage} {Math.round(vbusy.progress * 100)}%</Body> : null}
      {msg ? <Body style={{ fontSize: 13 }}>{msg}</Body> : null}
      <Body muted style={{ fontSize: 12 }}>The workout keeps recording EMG and counting sets as usual. Change the weight on the Workout tab; it's recorded with its time.</Body>
    </ScrollView>
  );
}
