import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Body, Button, Card, Label } from "../components/ui";
import { useTheme } from "../lib/theme";
import {
  diagnosticsText, setWearConfig, useWear, wearAvailable, wearCheck, wearCommand, wearDevices, wearListen, wearPing, wearRequest, wearSendTest,
} from "../lib/wear";

type R = { ok?: boolean; error?: string; code?: unknown; [k: string]: unknown } | null;

/**
 * Huawei watch (experimental): walks through the Wear Engine setup one step at a time and shows the
 * exact result of each call, so we can tell what works on this phone + watch without an app ID.
 */
export default function HuaweiWatchScreen() {
  const t = useTheme();
  const w = useWear();
  const [avail, setAvail] = useState<R>(null);
  const [perm, setPerm] = useState<R>(null);
  const [devs, setDevs] = useState<R>(null);
  const [ping, setPing] = useState<R>(null);
  const [send, setSend] = useState<R>(null);
  const [listen, setListen] = useState<R>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { wearAvailable().then((r) => setAvail(r as R)); }, []);
  const devices = ((devs as any)?.devices ?? []) as Record<string, unknown>[];
  const input = { borderWidth: 1, borderColor: t.line, borderRadius: 10, paddingHorizontal: 10, minHeight: 40, color: t.ink, backgroundColor: t.panel } as const;
  const show = (r: R) => (r ? <Text style={{ color: r.ok ? t.ok : t.warn, fontSize: 13, fontFamily: "monospace" }}>{JSON.stringify(r)}</Text> : null);

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <Body muted style={{ fontSize: 13 }}>Experimental. Tests whether MyoLift can talk to your Huawei watch through Huawei's Wear Engine. Each step shows the exact answer from Huawei's SDK. Send the diagnostics at the bottom back so the next step can be built.</Body>

      <Label>1 · Huawei Health on this phone</Label>
      <Card style={{ padding: 12, gap: 6 }}>
        <Text style={{ color: t.ink }}>Huawei Health: {(avail as any)?.health ?? "not found"} · HMS Core: {(avail as any)?.hmsCore ?? "not found"}</Text>
        <Body muted style={{ fontSize: 12 }}>Wear Engine runs inside the Huawei Health app, and needs HMS Core on non-Huawei phones. Your watch must be paired in Huawei Health.</Body>
        <Button small title="Check again" onPress={() => wearAvailable().then((r) => setAvail(r as R))} />
      </Card>

      <Label>2 · Permission</Label>
      <Card style={{ padding: 12, gap: 6 }}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button small title="Check" onPress={() => wearCheck().then((r) => setPerm(r as R))} />
          <Button small variant="primary" title="Request" onPress={() => wearRequest().then((r) => setPerm(r as R))} />
        </View>
        {show(perm)}
        <Body muted style={{ fontSize: 12 }}>Opens Huawei Health's authorisation page. If it fails with "scope unauthorised" or a similar code, Huawei requires the app to be registered for Wear Engine first.</Body>
      </Card>

      <Label>3 · Your watch</Label>
      <Card style={{ padding: 12, gap: 6 }}>
        <Button small title="Find devices" onPress={() => wearDevices().then((r) => setDevs(r as R))} />
        {devs && !(devs as any).ok ? show(devs) : null}
        {devices.map((d, i) => {
          const uuid = String(d.getUuid ?? "");
          const on = w.config.deviceUuid === uuid;
          return (
            <Pressable key={i} onPress={() => setWearConfig({ deviceUuid: uuid })} accessibilityRole="button"
              style={{ borderWidth: 1, borderColor: on ? t.accent : t.line, borderRadius: 10, padding: 10, gap: 2 }}>
              <Text style={{ color: t.ink, fontWeight: "700" }}>{String(d.getName ?? "watch")} {on ? "✓" : ""}</Text>
              <Text style={{ color: t.muted, fontSize: 12, fontFamily: "monospace" }}>{Object.entries(d).filter(([k]) => k !== "getName").map(([k, v]) => `${k.replace(/^(get|is)/, "")}: ${v}`).join("\n")}</Text>
            </Pressable>
          );
        })}
      </Card>

      <Label>4 · Watch app</Label>
      <Card style={{ padding: 12, gap: 6 }}>
        <Text style={{ color: t.muted, fontSize: 12 }}>Watch app package name</Text>
        <TextInput value={w.config.watchPkg} onChangeText={(v) => setWearConfig({ watchPkg: v.trim() })} autoCapitalize="none" style={input} />
        <Text style={{ color: t.muted, fontSize: 12 }}>Watch app fingerprint (from its signing certificate; can stay empty for the first test)</Text>
        <TextInput value={w.config.watchFingerprint} onChangeText={(v) => setWearConfig({ watchFingerprint: v.trim() })} autoCapitalize="none" style={input} />
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Button small title="Ping" disabled={!w.config.deviceUuid} onPress={() => wearPing().then((r) => setPing(r as R))} />
          <Button small title="Send test" disabled={!w.config.deviceUuid} onPress={() => wearSendTest().then((r) => setSend(r as R))} />
          <Button small variant="primary" title={w.listening ? "Listening" : "Listen for data"} disabled={!w.config.deviceUuid} onPress={() => wearListen().then((r) => setListen(r as R))} />
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button small title="Watch: start streaming" disabled={!w.config.deviceUuid} onPress={() => wearCommand("start").then((r) => setSend(r as R))} />
          <Button small title="Stop" disabled={!w.config.deviceUuid} onPress={() => wearCommand("stop").then((r) => setSend(r as R))} />
        </View>
        {show(ping)}{show(send)}{show(listen)}
        <Body muted style={{ fontSize: 12 }}>Ping works without the watch app: result 200 means the app is on the watch; 201/202 mean it's missing or not running. Messages from the watch are saved into the experiment or workout that's recording (watch.jsonl).</Body>
        <Text style={{ color: t.ink }}>Messages received: {w.received}{w.lastMessage ? ` · last: ${w.lastMessage}` : ""}</Text>
      </Card>

      <Label>Diagnostics</Label>
      <Card style={{ padding: 12, gap: 6 }}>
        <Button small title={copied ? "Selected: long-press to copy" : "Show all"} onPress={() => setCopied(true)} />
        <TextInput value={diagnosticsText()} multiline editable={false} selectTextOnFocus
          style={{ ...input, minHeight: 160, fontFamily: "monospace", fontSize: 11, textAlignVertical: "top" }} />
        <Body muted style={{ fontSize: 12 }}>Also saved as wear-diagnostics.json and included in the Lab and History exports.</Body>
      </Card>
    </ScrollView>
  );
}
