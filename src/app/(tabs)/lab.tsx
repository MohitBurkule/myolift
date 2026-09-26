import React, { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Body, Button, Card, Label, Title } from "../../components/ui";
import { exportExperiments, listExperiments, useExperimentsVersion, videoFile } from "../../lib/experiments";
import { clock, useTheme } from "../../lib/theme";

/** Experiments: EMG + video recordings of specific things (holds, pushes, stretches…) with notes. */
export default function LabScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  useExperimentsVersion();
  const list = listExperiments();
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const run = async (mode: "share" | "save") => {
    setSaved(null); setBusy("Packing…");
    try { const r = await exportExperiments(list.map((e) => e.id), setBusy, mode); if (mode === "save") setSaved(`Saved to ${r}. Connect the phone by USB (File transfer) and open Download/MyoLift.`); }
    catch (e: any) { setSaved(`Couldn't export: ${e?.message ?? e}. Your recordings are untouched.`); }
    finally { setBusy(null); }
  };
  const days = [...new Set(list.map((e) => new Date(e.startedAt).toDateString()))];
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, gap: 12, paddingBottom: 40 }}>
      <Title>Experiments</Title>
      <Body muted>Record the sensors and the camera together while you try one specific thing: a hold, a hard push, a stretch, partials. Add notes and marks so the recording can be analysed later.</Body>
      <Button title="+ New experiment" variant="primary" onPress={() => router.push("/experiment")} />
      {days.map((d) => (
        <View key={d} style={{ gap: 8 }}>
          <Label>{d}</Label>
          {list.filter((e) => new Date(e.startedAt).toDateString() === d).map((e) => (
            <Pressable key={e.id} onPress={() => router.push({ pathname: "/experiment", params: { id: e.id } })} accessibilityRole="button" accessibilityLabel={e.title}>
              <Card style={{ padding: 12, gap: 4 }}>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Text style={{ color: t.ink, fontWeight: "700", flex: 1 }} numberOfLines={1}>{e.title}</Text>
                  <Text style={{ color: t.muted, fontVariant: ["tabular-nums"] }}>{new Date(e.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</Text>
                </View>
                <Text style={{ color: t.muted, fontSize: 13 }}>
                  {clock(e.durationS ?? 0)} · {e.marks.length} marks · {e.feel}{e.video && videoFile(e.id).exists ? " · video" : ""}
                </Text>
                {e.notes ? <Text style={{ color: t.ink, fontSize: 13 }} numberOfLines={2}>{e.notes}</Text> : null}
              </Card>
            </Pressable>
          ))}
        </View>
      ))}
      {!list.length ? <Body muted>No experiments yet.</Body> : (
        <View style={{ gap: 8 }}>
          <Button title={busy ?? "Save all to Downloads (for USB)"} variant="primary" disabled={!!busy} onPress={() => run("save")} />
          <Button title="Share all (zip, with videos)" disabled={!!busy} onPress={() => run("share")} />
          {saved ? <Body style={{ fontSize: 13 }}>{saved}</Body> : null}
          <Body muted style={{ fontSize: 12 }}>Exporting makes a copy; the recordings stay in the app.</Body>
        </View>
      )}
    </ScrollView>
  );
}
